import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMentions, mentionsHandle, encodePairing, decodePairing, normalizeName, newId, ChatError } from '../src/chat.js';
import { Timestamp, encodeValue, decodeValue } from '../src/firebase.js';
import { renderRules } from '../scripts/build-rules.mjs';

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
