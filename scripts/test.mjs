#!/usr/bin/env node
// Runs the test suite against the Firebase emulators (Auth + Firestore) with a test access list.
//   node scripts/test.mjs           run all tests
//   node scripts/test.mjs --serve   just start the emulators (plus Hosting) for manual testing
import { writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { renderRules } from './build-rules.mjs';

export const TEST_PROJECT = 'demo-chatroom';
export const TEST_ACCESS = { emails: ['ana@example.com', 'bob@example.com'], domains: ['team.test'] };

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
writeFileSync(join(root, 'firestore.rules'), renderRules(TEST_ACCESS));

const serve = process.argv.includes('--serve');
const firebase = join(root, 'node_modules', 'firebase-tools', 'lib', 'bin', 'firebase.js');
const args = serve
  ? ['emulators:start', '--only', 'auth,firestore,hosting', '--project', TEST_PROJECT]
  : ['emulators:exec', '--only', 'auth,firestore', '--project', TEST_PROJECT, `"${process.execPath}" --test --test-concurrency=1 test/*.test.js`];

const r = spawnSync(process.execPath, [firebase, ...args], { cwd: root, stdio: 'inherit', shell: false });
process.exit(r.status ?? 1);
