#!/usr/bin/env node
// Renders firestore.rules.template into firestore.rules with the instance's access list.
//
// The access list comes from environment variables (so it can live in CI secrets instead of
// the public repository), falling back to the git-ignored chatroom.config.json:
//   CHATROOM_ALLOWED_EMAILS   comma-separated e-mails, e.g. "ana@example.com,bob@example.com"
//   CHATROOM_ALLOWED_DOMAINS  comma-separated e-mail domains, e.g. "example.com"
//   CHATROOM_ALLOW_ANYONE     "true" lets any verified Google account sign in (rooms stay invite-only)
// With none set, nobody can sign in (the conservative default).
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function list(value) {
  return String(value ?? '')
    .split(/[\s,;]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

export function accessFromEnv(env = process.env, configPath = join(root, 'chatroom.config.json')) {
  let emails = list(env.CHATROOM_ALLOWED_EMAILS);
  let domains = list(env.CHATROOM_ALLOWED_DOMAINS);
  let anyone = /^(1|true|yes)$/i.test(String(env.CHATROOM_ALLOW_ANYONE ?? '').trim());
  if (emails.length === 0 && domains.length === 0 && !anyone && existsSync(configPath)) {
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    emails = list((config.access?.emails ?? []).join(','));
    domains = list((config.access?.domains ?? []).join(','));
    anyone = config.access?.anyone === true;
  }
  return { emails, domains, anyone };
}

export function renderRules({ emails, domains, anyone = false }, template = readFileSync(join(root, 'firestore.rules.template'), 'utf8')) {
  for (const e of emails) {
    if (!/^[^\s@'"\\]+@[^\s@'"\\]+$/.test(e)) throw new Error(`Invalid e-mail in access list: ${e}`);
  }
  for (const d of domains) {
    if (!/^[a-z0-9.-]+$/.test(d)) throw new Error(`Invalid domain in access list: ${d}`);
  }
  const emailList = `[${emails.map((e) => `'${e}'`).join(', ')}]`;
  // Rules regexes use RE2; "a^" never matches anything.
  const domainRegex = anyone ? '^[^@]+@[^@]+$' : domains.length ? `^[^@]+@(${domains.map((d) => d.replaceAll('.', '[.]')).join('|')})$` : 'a^';
  return template.replaceAll('__ALLOWED_EMAILS__', emailList).replaceAll('__ALLOWED_DOMAIN_REGEX__', domainRegex);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const access = accessFromEnv();
  writeFileSync(join(root, 'firestore.rules'), renderRules(access));
  const who = access.anyone ? 'any verified Google account' : `${access.emails.length} e-mail(s), ${access.domains.length} domain(s)`;
  console.log(`firestore.rules written: ${who} allowed.`);
}
