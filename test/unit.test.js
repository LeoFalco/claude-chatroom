import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { parseMentions, mentionsHandle, encodePairing, decodePairing, normalizeName, newId, ChatError } from '../src/chat.js';
import { Timestamp, encodeValue, decodeValue } from '../src/firebase.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderRules, accessFromEnv } from '../scripts/build-rules.mjs';
import { VERSION } from '../src/mcp.js';

test('parseMentions finds users, agents and @all, ignoring e-mails', () => {
  assert.deepEqual(parseMentions('hey @Ana and @bob/claude, cc @all. mail me at x@y.com'), ['ana', 'bob/claude', 'all']);
  assert.deepEqual(parseMentions('no mentions here'), []);
});

test('mentionsHandle: @ana reaches ana/claude, @ana/claude does not reach ana', () => {
  assert.ok(mentionsHandle(['ana'], 'ana/claude'));
  assert.ok(mentionsHandle(['ana/claude'], 'ana/claude'));
  assert.ok(!mentionsHandle(['ana/claude'], 'ana'));
  assert.ok(mentionsHandle(['here'], 'bob'));
  assert.ok(!mentionsHandle(['bob'], 'ana/claude'));
});

test('pairing codes round-trip and reject garbage', () => {
  const s = encodePairing({ projectId: 'p', apiKey: 'k', code: 'c' });
  assert.match(s, /^ccr1\./);
  assert.deepEqual(decodePairing(s), { projectId: 'p', apiKey: 'k', code: 'c' });
  assert.throws(() => decodePairing('nope'), ChatError);
});

test('normalizeName lowercases, strips # and validates', () => {
  assert.equal(normalizeName('#Backend'), 'backend');
  assert.throws(() => normalizeName('bad name'), ChatError);
  assert.throws(() => normalizeName(''), ChatError);
});

test('newId uses the alphabet allowed by the rules', () => {
  for (let i = 0; i < 50; i++) assert.match(newId(), /^[a-z0-9]{10}$/);
});

test('Timestamp compares across fractional precisions', () => {
  const a = new Timestamp('2026-01-01T00:00:00Z');
  const b = new Timestamp('2026-01-01T00:00:00.000001Z');
  const c = new Timestamp('2026-01-01T00:00:00.5Z');
  assert.equal(a.compare(b), -1);
  assert.equal(c.compare(b), 1);
  assert.equal(a.compare(new Timestamp('2026-01-01T00:00:00.000Z')), 0);
});

test('Firestore values round-trip', () => {
  const v = { s: 'x', n: 3, f: 1.5, b: true, z: null, l: ['a', 1], m: { k: 'v' } };
  assert.deepEqual(decodeValue(encodeValue(v)), v);
  const ts = decodeValue(encodeValue(new Timestamp('2026-01-01T00:00:00Z')));
  assert.equal(ts.value, '2026-01-01T00:00:00Z');
});

test('PWA: manifest, icons and the service worker shell are consistent', () => {
  const web = new URL('../web/', import.meta.url);
  const manifest = JSON.parse(readFileSync(new URL('manifest.webmanifest', web), 'utf8'));
  assert.equal(manifest.display, 'standalone');
  assert.equal(manifest.start_url, '/');
  for (const purpose of ['any', 'maskable']) {
    for (const size of ['192x192', '512x512']) {
      const icon = manifest.icons.find((i) => i.purpose === purpose && i.sizes === size);
      assert.ok(icon, `missing ${purpose} ${size} icon`);
      const png = readFileSync(new URL(icon.src, web));
      assert.equal(`${png.readUInt32BE(16)}x${png.readUInt32BE(20)}`, size, `${icon.src} has the wrong size`);
    }
  }
  const sw = readFileSync(new URL('sw.js', web), 'utf8');
  const shell = JSON.parse(sw.match(/const SHELL = (\[[\s\S]*?\]);/)[1].replaceAll("'", '"').replace(/,\s*\]/, ']'));
  for (const file of shell.filter((f) => f !== './')) assert.ok(existsSync(new URL(file, web)), `sw.js caches missing ${file}`);
  const html = readFileSync(new URL('index.html', web), 'utf8');
  assert.match(html, /<link rel="manifest" href="manifest.webmanifest"/);
});

test('plugin, package, lockfile and MCP server share one version', () => {
  const json = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
  const plugin = json('../.claude-plugin/plugin.json').version;
  const lock = json('../package-lock.json');
  assert.equal(json('../package.json').version, plugin);
  assert.equal(lock.version, plugin);
  assert.equal(lock.packages[''].version, plugin);
  assert.equal(VERSION, plugin);
});

test('renderRules fills the access list and refuses injection', () => {
  const template = "x in __ALLOWED_EMAILS__ || x.matches('__ALLOWED_DOMAIN_REGEX__')";
  assert.equal(
    renderRules({ emails: ['a@b.com'], domains: ['team.test'] }, template),
    "x in ['a@b.com'] || x.matches('^[^@]+@(team[.]test)$')",
  );
  assert.equal(renderRules({ emails: [], domains: [] }, template), "x in [] || x.matches('a^')");
  assert.throws(() => renderRules({ emails: ["a'@b.com"], domains: [] }, template));
  assert.throws(() => renderRules({ emails: [], domains: ['a|b'] }, template));
});

test('renderRules can let any verified Google account sign in', () => {
  const template = "x.matches('__ALLOWED_DOMAIN_REGEX__')";
  const rendered = renderRules({ emails: [], domains: [], anyone: true }, template);
  const re = new RegExp(rendered.match(/'(.*)'/)[1]);
  for (const ok of ['a@b.com', 'cesar.sprite@gmail.com']) assert.ok(re.test(ok), ok);
  for (const bad of ['nobody', 'a@b@c.com']) assert.ok(!re.test(bad), bad);
  assert.equal(renderRules({ emails: [], domains: [] }, template), "x.matches('a^')");
});

test('accessFromEnv reads CHATROOM_ALLOW_ANYONE and defaults to closed', () => {
  const none = join(tmpdir(), 'no-such-chatroom-config.json');
  assert.equal(accessFromEnv({}, none).anyone, false);
  assert.equal(accessFromEnv({ CHATROOM_ALLOW_ANYONE: 'true' }, none).anyone, true);
  assert.equal(accessFromEnv({ CHATROOM_ALLOW_ANYONE: 'no' }, none).anyone, false);
});
