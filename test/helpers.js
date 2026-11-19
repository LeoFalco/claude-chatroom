import { FirebaseClient, REQUEST_TIME, Timestamp } from '../src/firebase.js';
import { ChatClient, newId } from '../src/chat.js';

export const PROJECT = process.env.GCLOUD_PROJECT || 'demo-chatroom';
export const API_KEY = 'fake-api-key';

export function emulatorsRunning() {
  return Boolean(process.env.FIRESTORE_EMULATOR_HOST && process.env.FIREBASE_AUTH_EMULATOR_HOST);
}

export async function resetEmulators() {
  const fs = process.env.FIRESTORE_EMULATOR_HOST;
  const auth = process.env.FIREBASE_AUTH_EMULATOR_HOST;
  await fetch(`http://${fs}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: 'DELETE' });
  await fetch(`http://${auth}/emulator/v1/projects/${PROJECT}/accounts`, { method: 'DELETE' });
}

export function client() {
  return new FirebaseClient({ projectId: PROJECT, apiKey: API_KEY });
}

/** Signs in as a Google user (emulator accepts unsigned claims). */
export async function googleUser(email, { verified = true } = {}) {
  const fb = client();
  await fb.signInWithIdp('google.com', { sub: `sub-${email}`, email, email_verified: verified, name: email.split('@')[0] });
  return fb;
}

/** A Google user who picked a handle, the way the web UI does it. */
export async function human(email, hid) {
  const fb = await googleUser(email);
  await fb.commit([
    { path: `users/${fb.uid}`, mode: 'create', data: { hid, displayName: hid, createdAt: REQUEST_TIME } },
    { path: `handles/${hid}`, mode: 'create', data: { kind: 'human', uid: fb.uid, owner: fb.uid, status: '', lastSeen: REQUEST_TIME } },
  ]);
  return { fb, email, hid };
}

export async function createPairing(h, agent = 'claude', { expiresInMs = 10 * 60_000 } = {}) {
  const code = newId(32);
  await h.fb.commit([
    {
      path: `pairings/${code}`,
      mode: 'create',
      data: {
        owner: h.fb.uid,
        ownerHid: h.hid,
        ownerEmail: h.email,
        agent,
        createdAt: REQUEST_TIME,
        expiresAt: new Timestamp(new Date(Date.now() + expiresInMs).toISOString()),
        claimedBy: null,
      },
    },
  ]);
  return code;
}

/** Pairs a new Claude session for human `h` and returns an initialized ChatClient. */
export async function agentFor(h, agent = 'claude') {
  const code = await createPairing(h, agent);
  const fb = client();
  await ChatClient.pair(fb, code);
  const chat = new ChatClient(fb, { pollMs: 100 });
  await chat.init();
  return chat;
}

/** Expects a promise to be rejected by security rules. */
export async function denied(promise) {
  try {
    await promise;
  } catch (err) {
    if (err.status === 403 || /permission|denied|not allowed|rejected/i.test(err.message)) return err;
    throw err;
  }
  throw new Error('Expected the operation to be denied, but it succeeded.');
}
