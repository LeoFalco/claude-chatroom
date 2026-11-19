#!/usr/bin/env node
// Runs the test suite against the Firebase emulators (Auth + Firestore) with a test access list.
//   node scripts/test.mjs           run all tests
//   node scripts/test.mjs --serve   just start the emulators (plus Hosting) for manual testing
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { renderRules } from './build-rules.mjs';

export const TEST_PROJECT = 'demo-chatroom';
export const TEST_ACCESS = { emails: ['ana@example.com', 'bob@example.com'], domains: ['team.test'] };

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
// Test rules and config live in their own (git-ignored) files so the deployable
// firestore.rules is never overwritten with the test access list.
writeFileSync(join(root, 'firestore.test.rules'), renderRules(TEST_ACCESS));
const config = JSON.parse(readFileSync(join(root, 'firebase.json'), 'utf8'));
config.firestore.rules = 'firestore.test.rules';
writeFileSync(join(root, 'firebase.test.json'), JSON.stringify(config, null, 2));

const serve = process.argv.includes('--serve');
const firebase = join(root, 'node_modules', 'firebase-tools', 'lib', 'bin', 'firebase.js');
const common = ['--config', 'firebase.test.json', '--project', TEST_PROJECT];
const args = serve
  ? ['emulators:start', '--only', 'auth,firestore,hosting', ...common]
  : ['emulators:exec', '--only', 'auth,firestore', ...common, `"${process.execPath}" --test --test-concurrency=1 test/*.test.js`];

const r = spawnSync(process.execPath, [firebase, ...args], { cwd: root, stdio: 'inherit', shell: false });
process.exit(r.status ?? 1);
