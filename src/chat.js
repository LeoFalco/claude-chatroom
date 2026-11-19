import { randomBytes } from 'node:crypto';
import { FirebaseError, REQUEST_TIME, Timestamp, q } from './firebase.js';

export const MAX_MESSAGE_LENGTH = 8000;
const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const MENTION_RE = /(^|[^\w@/])@([a-z0-9][a-z0-9_-]{0,31}(?:\/[a-z0-9][a-z0-9_-]{0,31})?)/gi;
const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

export class ChatError extends Error {}

export function normalizeName(raw, what = 'name') {
  const name = String(raw ?? '').trim().toLowerCase().replace(/^#/, '');
  if (!NAME_RE.test(name)) {
    throw new ChatError(`Invalid ${what} "${raw}": use 1-32 chars of a-z, 0-9, "-" or "_", starting with a letter or digit.`);
  }
  return name;
}

export function parseMentions(text) {
  const found = new Set();
  for (const m of text.matchAll(MENTION_RE)) found.add(m[2].toLowerCase());
  return [...found];
}

/** True when `mentions` address `handle`: "@ana" also reaches "ana/claude"; @all and @here reach everyone. */
export function mentionsHandle(mentions, handle) {
  const user = handle.split('/')[0];
  return mentions.some((m) => m === handle || m === user || m === 'all' || m === 'here');
}

export const hidToHandle = (hid) => hid.replace('~', '/');
export const handleToHid = (handle) => String(handle).toLowerCase().replace(/^@/, '').replace('/', '~');

export function newId(length = 10) {
  const bytes = randomBytes(length);
  return Array.from(bytes, (b) => ID_ALPHABET[b % ID_ALPHABET.length]).join('');
}

/** Pairing strings carry everything a new Claude session needs: "ccr1.<base64url JSON>". */
export function encodePairing({ projectId, apiKey, code }) {
  return `ccr1.${Buffer.from(JSON.stringify({ p: projectId, k: apiKey, c: code })).toString('base64url')}`;
}

export function decodePairing(s) {
  const m = /^ccr1\.([A-Za-z0-9_-]+)$/.exec(String(s).trim());
  if (!m) throw new ChatError('That does not look like a pairing code (it starts with "ccr1.").');
  const { p, k, c } = JSON.parse(Buffer.from(m[1], 'base64url').toString('utf8'));
  if (!p || !k || !c) throw new ChatError('Incomplete pairing code.');
  return { projectId: p, apiKey: k, code: c };
}

function toMessage(doc) {
  const d = doc.data;
  return {
    id: doc.id,
    room: d.room,
    author: d.author,
    author_kind: d.authorKind,
    text: d.text,
    reply_to: d.replyTo ?? null,
    // Recomputed from the text: the stored field is written by the client and could be forged.
    mentions: parseMentions(String(d.text ?? '')),
    created_at: d.createdAt?.value ?? null,
    _ts: d.createdAt,
  };
}

const sleep = (ms, signal) =>
  new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done);
  });

/** Turns Firestore rule denials into messages a model (or person) can act on. */
async function friendly(promise, hint) {
  try {
    return await promise;
  } catch (err) {
    if (err instanceof FirebaseError && (err.status === 403 || err.code === 'PERMISSION_DENIED')) {
      throw new ChatError(hint ?? 'Permission denied by the chatroom rules.');
    }
    throw err;
  }
}

/**
 * Chat operations for one paired Claude session (an anonymous Firebase user with an agents/{uid} doc).
 */
export class ChatClient {
  /**
   * @param {import('./firebase.js').FirebaseClient} fb signed-in client
   * @param {{ pollMs?: number }} [opts]
   */
  constructor(fb, { pollMs = 3000 } = {}) {
    this.fb = fb;
    this.pollMs = pollMs;
    this.me = null;
    this._lastTouch = 0;
  }

  /**
   * Redeems a pairing code created in the web UI: signs up a new anonymous user and binds it
   * to "<owner>/<agent>". Returns { uid, hid, handle, refreshToken }.
   */
  static async pair(fb, code) {
    await fb.signUpAnonymously();
    const uid = fb.uid;
    const pairing = await fb.get(`pairings/${code}`);
    if (!pairing) throw new ChatError('Pairing code not found. Create a new one in the web UI.');
    const p = pairing.data;
    if (p.claimedBy) throw new ChatError('This pairing code was already used. Create a new one in the web UI.');
    if (p.expiresAt.compare(new Timestamp(new Date().toISOString())) <= 0) {
      throw new ChatError('This pairing code expired. Create a new one in the web UI.');
    }
    const hid = `${p.ownerHid}~${p.agent}`;
    const agentWrite = {
      path: `agents/${uid}`,
      mode: 'create',
      data: {
        owner: p.owner,
        ownerHid: p.ownerHid,
        ownerEmail: p.ownerEmail,
        agent: p.agent,
        hid,
        pairing: code,
        revoked: false,
        createdAt: REQUEST_TIME,
      },
    };
    const claim = { path: `pairings/${code}`, mode: 'update', data: { claimedBy: uid } };
    const newHandle = {
      path: `handles/${hid}`,
      mode: 'create',
      data: { kind: 'agent', uid, owner: p.owner, status: '', lastSeen: REQUEST_TIME },
    };
    // Same agent name paired again: move the existing handle to this new session.
    const movedHandle = { path: `handles/${hid}`, mode: 'update', data: { uid, lastSeen: REQUEST_TIME } };
    const rejected = 'The pairing was rejected. Is the owner still allowed on this instance?';
    try {
      await fb.commit([agentWrite, newHandle, claim]);
    } catch (err) {
      // Only an existing handle (this agent name was paired before) is worth a retry.
      const exists = err instanceof FirebaseError && (err.status === 409 || err.code === 'ALREADY_EXISTS');
      if (!exists) throw err instanceof FirebaseError && err.status === 403 ? new ChatError(rejected) : err;
      await friendly(fb.commit([agentWrite, movedHandle, claim]), rejected);
    }
    return { uid, hid, handle: hidToHandle(hid), refreshToken: fb.refreshToken };
  }

  /** Loads this session's identity. Must be called before anything else. */
  async init() {
    await this.fb.idToken();
    const agent = await friendly(this.fb.get(`agents/${this.fb.uid}`));
    if (!agent) throw new ChatError('This Claude session is not paired (or was removed). Pair it again from the web UI.');
    if (agent.data.revoked) throw new ChatError('This Claude session was revoked by its owner. Pair it again from the web UI.');
    this.me = { uid: this.fb.uid, hid: agent.data.hid, handle: hidToHandle(agent.data.hid), owner: agent.data.ownerHid, kind: 'agent' };
    return this.me;
  }

  /** Updates lastSeen at most once a minute so presence stays cheap. */
  async touch() {
    if (Date.now() - this._lastTouch < 60_000) return;
    this._lastTouch = Date.now();
    await this.fb.commit([{ path: `handles/${this.me.hid}`, mode: 'update', data: { lastSeen: REQUEST_TIME } }]).catch(() => {});
  }

  async _room(rawName) {
    const name = normalizeName(rawName, 'room name');
    const doc = await friendly(this.fb.get(`rooms/${name}`), 'Not allowed to read rooms. Was this session revoked?');
    if (!doc) throw new ChatError(`Room "${name}" does not exist. Use list_rooms to see rooms or create_room to make it.`);
    return { name, ...doc.data };
  }

  async _membership(room) {
    return this.fb.get(`rooms/${room}/members/${this.me.hid}`);
  }

  async _requireMember(room) {
    const m = await this._membership(room);
    if (!m) throw new ChatError(`You are not in room "${room}". Call join_room first.`);
    return m;
  }

  /** Rooms this session joined: [{ room, lastReadAt }]. */
  async memberships() {
    const docs = await this.fb.query('', {
      from: [{ collectionId: 'members', allDescendants: true }],
      where: q.field('hid', 'EQUAL', this.me.hid),
    });
    return docs.map((d) => ({ room: d.data.room, lastReadAt: d.data.lastReadAt }));
  }

  async listRooms() {
    const [rooms, mine] = await Promise.all([
      friendly(this.fb.query('', { from: [{ collectionId: 'rooms' }], orderBy: [q.order('__name__')], limit: 200 })),
      this.memberships(),
    ]);
    const unread = await this.unread(null, 500);
    const counts = new Map();
    for (const m of unread) counts.set(m.room, (counts.get(m.room) ?? 0) + 1);
    const joined = new Set(mine.map((m) => m.room));
    const members = await Promise.all(
      rooms.map((r) => this.fb.query(`rooms/${r.id}`, { from: [{ collectionId: 'members' }], select: { fields: [{ fieldPath: 'hid' }] } })),
    );
    return rooms.map((r, i) => ({
      name: r.id,
      topic: r.data.topic,
      created_by: r.data.createdBy,
      members: members[i].length,
      joined: joined.has(r.id),
      unread: joined.has(r.id) ? (counts.get(r.id) ?? 0) : null,
    }));
  }

  async createRoom(rawName, topic = '') {
    const name = normalizeName(rawName, 'room name');
    try {
      await this.fb.commit([
        { path: `rooms/${name}`, mode: 'create', data: { topic: String(topic).slice(0, 500), createdBy: this.me.handle, createdAt: REQUEST_TIME } },
        this._memberWrite(name, Timestamp.epoch()),
      ]);
    } catch (err) {
      if (err instanceof FirebaseError && (err.status === 409 || err.code === 'ALREADY_EXISTS' || err.code === 'FAILED_PRECONDITION')) {
        throw new ChatError(`Room "${name}" already exists. Use join_room to enter it.`);
      }
      if (err instanceof FirebaseError && err.status === 403) throw new ChatError(`Not allowed to create room "${name}".`);
      throw err;
    }
    return { name, topic };
  }

  _memberWrite(room, lastReadAt) {
    return {
      path: `rooms/${room}/members/${this.me.hid}`,
      mode: 'create',
      data: { hid: this.me.hid, handle: this.me.handle, kind: this.me.kind, room, joinedAt: REQUEST_TIME, lastReadAt },
    };
  }

  /** Joins a room. New members get the last 20 messages as unread, for context. */
  async join(rawName) {
    const room = await this._room(rawName);
    if (await this._membership(room.name)) return { room, alreadyMember: true };
    const recent = await this.fb.query(`rooms/${room.name}`, {
      from: [{ collectionId: 'messages' }],
      orderBy: [q.order('createdAt', 'DESCENDING')],
      limit: 21,
    });
    const lastReadAt = recent.length === 21 ? recent[20].data.createdAt : Timestamp.epoch();
    await friendly(this.fb.commit([this._memberWrite(room.name, lastReadAt)]), `Not allowed to join "${room.name}".`);
    return { room, alreadyMember: false };
  }

  async leave(rawName) {
    const room = normalizeName(rawName, 'room name');
    if (!(await this._membership(room))) return false;
    await this.fb._request('DELETE', `${this.fb.firestoreUrl}/documents/rooms/${room}/members/${this.me.hid}`);
    return true;
  }

  async setTopic(rawName, topic) {
    const room = await this._room(rawName);
    await this._requireMember(room.name);
    await friendly(this.fb.commit([{ path: `rooms/${room.name}`, mode: 'update', data: { topic: String(topic).slice(0, 500) } }]));
    return { name: room.name, topic };
  }

  async who(rawName) {
    const room = await this._room(rawName);
    const members = await this.fb.query(`rooms/${room.name}`, { from: [{ collectionId: 'members' }] });
    const handles = await this.fb.batchGet(members.map((m) => `handles/${m.id}`));
    return members
      .map((m, i) => ({
        handle: m.data.handle,
        kind: m.data.kind,
        status: handles[i]?.data.status ?? '',
        last_seen: handles[i]?.data.lastSeen?.value ?? null,
      }))
      .sort((a, b) => String(b.last_seen).localeCompare(String(a.last_seen)));
  }

  async post(rawName, rawText, replyTo = null) {
    const room = normalizeName(rawName, 'room name');
    await this._requireMember(room);
    const text = String(rawText ?? '').trim();
    if (!text) throw new ChatError('Message text is empty.');
    if (text.length > MAX_MESSAGE_LENGTH) throw new ChatError(`Message is longer than ${MAX_MESSAGE_LENGTH} characters; split it.`);
    if (replyTo != null && !(await this.fb.get(`rooms/${room}/messages/${replyTo}`))) {
      throw new ChatError(`Message ${replyTo} is not in room "${room}".`);
    }
    const id = newId();
    const data = {
      room,
      author: this.me.handle,
      authorHid: this.me.hid,
      authorKind: this.me.kind,
      authorUid: this.me.uid,
      text,
      replyTo: replyTo ?? null,
      mentions: parseMentions(text),
      createdAt: REQUEST_TIME,
    };
    const [transforms] = await friendly(this.fb.commit([{ path: `rooms/${room}/messages/${id}`, mode: 'create', data }]));
    const createdAt = transforms?.[0] ?? null;
    // Keep the read cursor close to the present when nothing from others is pending, so
    // unread queries never have to skip over a long run of our own messages.
    if (createdAt && (await this.unread(room, 1)).length === 0) {
      await this.markRead([{ room, _ts: createdAt }]).catch(() => {});
    }
    this.touch();
    return { id, room, author: this.me.handle, mentions: data.mentions, created_at: createdAt?.value ?? null };
  }

  async history(rawName, { limit = 30, beforeId } = {}) {
    const room = normalizeName(rawName, 'room name');
    await this._requireMember(room);
    let where;
    if (beforeId) {
      const before = await this.fb.get(`rooms/${room}/messages/${beforeId}`);
      if (!before) throw new ChatError(`Message ${beforeId} is not in room "${room}".`);
      where = q.field('createdAt', 'LESS_THAN', before.data.createdAt);
    }
    const docs = await this.fb.query(`rooms/${room}`, {
      from: [{ collectionId: 'messages' }],
      ...(where ? { where } : {}),
      orderBy: [q.order('createdAt', 'DESCENDING')],
      limit: Math.min(200, Math.max(1, limit)),
    });
    return docs.reverse().map(toMessage);
  }

  /** Unread messages from others, in one room or in all joined rooms, oldest first. */
  async unread(rawName = null, limit = 100) {
    let mine = await this.memberships();
    if (rawName) {
      const room = normalizeName(rawName, 'room name');
      mine = mine.filter((m) => m.room === room);
      if (mine.length === 0) throw new ChatError(`You are not in room "${room}". Call join_room first.`);
    }
    if (mine.length === 0) return [];
    // One query per room from its own cursor: a quiet room never drags the others back in time.
    const perRoom = await Promise.all(mine.map((m) => this._unreadInRoom(m.room, m.lastReadAt, limit)));
    return perRoom
      .flat()
      .sort((a, b) => a._ts.compare(b._ts))
      .slice(0, limit);
  }

  async _unreadInRoom(room, lastReadAt, limit) {
    const out = [];
    let since = lastReadAt;
    const pageSize = Math.min(100, Math.max(limit, 20));
    for (let page = 0; page < 20 && out.length < limit; page++) {
      const docs = await this.fb.query(`rooms/${room}`, {
        from: [{ collectionId: 'messages' }],
        where: q.field('createdAt', 'GREATER_THAN', since),
        orderBy: [q.order('createdAt')],
        limit: pageSize,
      });
      for (const d of docs) {
        const m = toMessage(d);
        if (m.author !== this.me.handle) out.push(m);
      }
      if (docs.length < pageSize) break;
      since = docs[docs.length - 1].data.createdAt;
    }
    return out.slice(0, limit);
  }

  /** Moves read cursors up to the newest of `messages` in each room. */
  async markRead(messages) {
    const newest = new Map();
    for (const m of messages) {
      const cur = newest.get(m.room);
      if (!cur || m._ts.compare(cur) > 0) newest.set(m.room, m._ts);
    }
    if (newest.size === 0) return;
    await this.fb.commit(
      [...newest].map(([room, ts]) => ({ path: `rooms/${room}/members/${this.me.hid}`, mode: 'update', data: { lastReadAt: ts } })),
    );
  }

  /**
   * Polls until an unread message matches the filter, then returns every unread message in
   * scope; returns [] on timeout or abort. Filters only decide when to wake up.
   */
  async waitForMessages({ room = null, from = null, mentionsOnly = false, timeoutMs = 60_000, signal } = {}) {
    const fromHandle = from ? String(from).toLowerCase().replace(/^@/, '') : null;
    const matches = (m) =>
      (!fromHandle || m.author === fromHandle || m.author.split('/')[0] === fromHandle) &&
      (!mentionsOnly || mentionsHandle(m.mentions, this.me.handle));
    const deadline = Date.now() + timeoutMs;
    this.touch();
    while (!signal?.aborted) {
      const pending = await this.unread(room);
      if (pending.some(matches)) return pending;
      const left = deadline - Date.now();
      if (left <= 0) break;
      await sleep(Math.min(this.pollMs, left), signal);
    }
    return [];
  }

  async setStatus(status) {
    const text = String(status ?? '').slice(0, 200);
    await friendly(this.fb.commit([{ path: `handles/${this.me.hid}`, mode: 'update', data: { status: text, lastSeen: REQUEST_TIME } }]));
    return text;
  }
}
