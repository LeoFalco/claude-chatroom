import { initializeApp } from 'https://www.gstatic.com/firebasejs/13.4.0/firebase-app.js';
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signOut,
  onAuthStateChanged,
  connectAuthEmulator,
} from 'https://www.gstatic.com/firebasejs/13.4.0/firebase-auth.js';
import {
  getFirestore,
  connectFirestoreEmulator,
  doc,
  getDoc,
  getDocs,
  setDoc,
  updateDoc,
  deleteDoc,
  writeBatch,
  collection,
  collectionGroup,
  query,
  where,
  orderBy,
  limit,
  onSnapshot,
  serverTimestamp,
  Timestamp,
} from 'https://www.gstatic.com/firebasejs/13.4.0/firebase-firestore.js';
import { firebaseConfig, packageSpec, docsUrl } from './config.js';

// ---- setup ----------------------------------------------------------------------

const params = new URLSearchParams(location.search);
const useEmulators = ['localhost', '127.0.0.1'].includes(location.hostname) && params.has('emulator');
const config = useEmulators ? { ...firebaseConfig, projectId: 'demo-chatroom', apiKey: 'fake-api-key' } : firebaseConfig;
const app = initializeApp(config);
const auth = getAuth(app);
const db = getFirestore(app);
if (useEmulators) {
  connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
  connectFirestoreEmulator(db, '127.0.0.1', 8080);
  // Lets local/manual tests sign in without the Google popup (emulator only).
  window.__chatroom = { auth, db };
}

const $ = (sel) => document.querySelector(sel);
const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
// Keep in sync with src/chat.js.
const MENTION_RE = /(^|[^\w@/])@([a-z0-9][a-z0-9_-]{0,31}(?:\/[a-z0-9][a-z0-9_-]{0,31})?)/gi;
const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
const PAIRING_TTL_MS = 15 * 60_000;

const state = {
  user: null,
  me: null, // { hid, handle }
  rooms: new Map(), // name -> { topic, createdBy }, only rooms you can see
  invited: new Set(), // rooms you were invited to
  memberships: new Map(), // room -> lastReadAt (Timestamp)
  roomWatch: new Map(), // room -> unsubscribe of its doc listener
  roomInvites: [], // people invited to the current room
  unread: new Map(), // room -> count
  current: null,
  messages: [],
  replyTo: null,
  handles: new Map(), // hid -> { status, lastSeen, kind }, only the handles being watched
  handleWatch: new Map(), // hid -> unsubscribe
  unsubs: [],
  roomUnsubs: [],
  unreadWatch: new Map(), // room -> { since, unsub }
};

$('#docs-link').href = docsUrl;

// ---- helpers ---------------------------------------------------------------------

function parseMentions(text) {
  const found = new Set();
  for (const m of text.matchAll(MENTION_RE)) found.add(m[2].toLowerCase());
  return [...found];
}

function mentionsMe(mentions) {
  const h = state.me.handle;
  return mentions.some((m) => m === h || m === 'all' || m === 'here');
}

function newId(length = 10) {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, (b) => ID_ALPHABET[b % ID_ALPHABET.length]).join('');
}

const hidToHandle = (hid) => hid.replace('~', '/');

function show(id) {
  for (const s of ['#loading', '#signin', '#pick-handle', '#not-allowed', '#app']) $(s).hidden = s !== id;
}

function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null) e.append(c);
  return e;
}

function timeLabel(ts) {
  if (!ts) return 'sending…';
  const d = ts.toDate();
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : d.toLocaleString([], { dateStyle: 'short', timeStyle: 'short' });
}

function ago(ts) {
  if (!ts) return 'never';
  const s = Math.round((Date.now() - ts.toMillis()) / 1000);
  if (s < 90) return 'active now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

/** Renders message text safely: code fences, inline code, links and @mentions; never innerHTML. */
function renderText(text) {
  const frag = document.createDocumentFragment();
  const parts = text.split(/```(?:[a-zA-Z0-9_-]*\n)?([\s\S]*?)```/g);
  parts.forEach((part, i) => {
    if (i % 2 === 1) {
      frag.append(el('pre', {}, el('code', {}, part.replace(/\n$/, ''))));
      return;
    }
    part.split(/`([^`\n]+)`/g).forEach((chunk, j) => {
      if (j % 2 === 1) return frag.append(el('code', {}, chunk));
      const re = /(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])|((?:^|(?<=[^\w@/]))@[a-z0-9][a-z0-9_-]{0,31}(?:\/[a-z0-9][a-z0-9_-]{0,31})?)/gi;
      let last = 0;
      for (const m of chunk.matchAll(re)) {
        frag.append(chunk.slice(last, m.index));
        if (m[1]) frag.append(el('a', { href: m[1], target: '_blank', rel: 'noopener noreferrer' }, m[1]));
        else frag.append(el('span', { class: 'mention' }, m[2]));
        last = m.index + m[0].length;
      }
      frag.append(chunk.slice(last));
    });
  });
  return frag;
}

function toast(message) {
  const t = el('div', { class: 'toast', role: 'status' }, message);
  document.body.append(t);
  setTimeout(() => t.remove(), 4000);
}

function permissionMessage(err) {
  return err?.code === 'permission-denied' ? 'Not allowed.' : err?.message ?? String(err);
}

// ---- auth -------------------------------------------------------------------------

$('#google-signin').addEventListener('click', async () => {
  $('#signin-error').textContent = '';
  try {
    await signInWithPopup(auth, new GoogleAuthProvider());
  } catch (err) {
    if (err.code !== 'auth/popup-closed-by-user') $('#signin-error').textContent = err.message;
  }
});

document.addEventListener('click', (e) => {
  if (e.target.closest('[data-action="signout"]')) signOut(auth);
});

onAuthStateChanged(auth, async (user) => {
  teardown();
  state.user = user;
  if (!user) return show('#signin');
  show('#loading');
  try {
    const profile = await getDoc(doc(db, 'users', user.uid));
    if (profile.exists()) return start(profile.data().hid);
    $('#handle-input').value = (user.email ?? '').split('@')[0].toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 32);
    show('#pick-handle');
  } catch (err) {
    console.error(err);
    $('#signin-error').textContent = permissionMessage(err);
    show('#signin');
  }
});

$('#handle-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const hid = $('#handle-input').value.trim().toLowerCase();
  $('#handle-error').textContent = '';
  if (!NAME_RE.test(hid)) return ($('#handle-error').textContent = 'Use 1-32 chars: a-z, 0-9, "-" or "_".');
  const uid = state.user.uid;
  const batch = writeBatch(db);
  batch.set(doc(db, 'users', uid), { hid, displayName: state.user.displayName ?? hid, createdAt: serverTimestamp() });
  batch.set(doc(db, 'handles', hid), { kind: 'human', uid, owner: uid, status: '', lastSeen: serverTimestamp() });
  try {
    await batch.commit();
    start(hid);
  } catch (err) {
    if (err.code !== 'permission-denied') return ($('#handle-error').textContent = err.message);
    // Either the handle is taken or this account is not on the access list.
    const taken = await getDoc(doc(db, 'handles', hid)).then((d) => d.exists()).catch(() => null);
    if (taken === null) {
      $('#not-allowed-email').textContent = state.user.email;
      show('#not-allowed');
    } else {
      $('#handle-error').textContent = taken ? `"${hid}" is taken. Pick another one.` : 'Could not save the handle.';
    }
  }
});

function teardown() {
  for (const u of [...state.unsubs, ...state.roomUnsubs, ...state.roomWatch.values(), ...state.handleWatch.values()]) u();
  for (const w of state.unreadWatch.values()) w.unsub();
  agentsUnsub?.();
  agentsUnsub = null;
  retries.clear();
  Object.assign(state, {
    me: null,
    rooms: new Map(),
    invited: new Set(),
    memberships: new Map(),
    roomWatch: new Map(),
    roomInvites: [],
    unread: new Map(),
    current: null,
    messages: [],
    replyTo: null,
    handles: new Map(),
    handleWatch: new Map(),
    unsubs: [],
    roomUnsubs: [],
    unreadWatch: new Map(),
  });
}

// ---- app --------------------------------------------------------------------------

function start(hid) {
  state.me = { hid, handle: hidToHandle(hid) };
  $('#me-handle').textContent = '@' + state.me.handle;
  for (const e of document.querySelectorAll('.me-handle-inline')) e.textContent = state.me.handle;
  show('#app');
  touch();

  state.unsubs.push(
    onSnapshot(doc(db, 'handles', hid), (d) => {
      if (document.activeElement !== $('#status-input')) $('#status-input').value = d.data()?.status ?? '';
    }),
    onSnapshot(query(collectionGroup(db, 'members'), where('hid', '==', hid)), (snap) => {
      state.memberships = new Map(snap.docs.map((d) => [d.data().room, d.data().lastReadAt]));
      watchRooms();
      watchUnread();
      renderRooms();
      if (state.current) renderMembership();
    }),
  );

  watchInvites(hid);

  const fromHash = decodeURIComponent(location.hash.slice(1));
  if (NAME_RE.test(fromHash)) openRoom(fromHash);
  setInterval(touch, 120_000);
}

let lastTouch = 0;
function touch() {
  if (!state.me || Date.now() - lastTouch < 60_000) return;
  lastTouch = Date.now();
  updateDoc(doc(db, 'handles', state.me.hid), { lastSeen: serverTimestamp() }).catch(() => {});
}

/**
 * Listeners can start from a local write the server has not committed yet (creating or joining
 * a room), get denied and stop for good. Retries a few times, then gives up.
 */
const retries = new Map(); // key -> attempts
function retryLater(key, fn) {
  const n = (retries.get(key) ?? 0) + 1;
  retries.set(key, n);
  if (n <= 5) setTimeout(fn, 1000 * n);
}

/** Rooms are private: you see the rooms you were invited to and the ones you are in. */
function watchInvites(hid) {
  const unsub = onSnapshot(
    query(collectionGroup(db, 'invites'), where('hid', '==', hid)),
    (snap) => {
      retries.delete('invites');
      state.invited = new Set(snap.docs.map((d) => d.ref.parent.parent.id));
      watchRooms();
    },
    // E.g. right after a deploy, while the index on invites.hid is still building.
    (err) => {
      console.warn('invites listener', err);
      retryLater('invites', () => state.me?.hid === hid && watchInvites(hid));
    },
  );
  state.unsubs.push(unsub);
}

/** One listener per room you can see; drops rooms you were removed from. */
function watchRooms() {
  const visible = new Set([...state.invited, ...state.memberships.keys()]);
  for (const [room, unsub] of state.roomWatch) {
    if (visible.has(room)) continue;
    unsub();
    state.roomWatch.delete(room);
    state.rooms.delete(room);
    if (room === state.current) closeRoom(`You no longer have access to #${room}.`);
  }
  for (const room of visible) {
    if (state.roomWatch.has(room)) continue;
    const forget = () => {
      state.rooms.delete(room);
      renderRooms();
    };
    const unsub = onSnapshot(
      doc(db, 'rooms', room),
      (d) => {
        retries.delete(`room:${room}`);
        if (!d.exists()) return forget();
        state.rooms.set(room, d.data());
        renderRooms();
        if (room === state.current) renderRoomHeader();
      },
      () => {
        state.roomWatch.delete(room);
        forget();
        retryLater(`room:${room}`, watchRooms);
      },
    );
    state.roomWatch.set(room, unsub);
  }
  renderRooms();
}

/** Presence and status: one listener per handle shown (room members and your own Claude sessions). */
function watchHandles() {
  const wanted = new Set([...(state.members ?? []).map((m) => m.hid), ...agentHids]);
  for (const [hid, unsub] of state.handleWatch) {
    if (wanted.has(hid)) continue;
    unsub();
    state.handleWatch.delete(hid);
    state.handles.delete(hid);
  }
  for (const hid of wanted) {
    if (state.handleWatch.has(hid)) continue;
    const unsub = onSnapshot(
      doc(db, 'handles', hid),
      (d) => {
        if (d.exists()) state.handles.set(hid, d.data());
        else state.handles.delete(hid);
        renderMembers();
        renderAgents();
      },
      (err) => console.warn('handle listener', hid, err),
    );
    state.handleWatch.set(hid, unsub);
  }
}

/**
 * Unread counts: one listener per joined room, from that room's own read cursor. A listener
 * is only replaced when its room's cursor moves, so reading one room doesn't re-read others.
 */
function watchUnread() {
  for (const [room, w] of state.unreadWatch) {
    if (!state.memberships.has(room)) {
      w.unsub();
      state.unreadWatch.delete(room);
      state.unread.delete(room);
    }
  }
  for (const [room, lastReadAt] of state.memberships) {
    const since = lastReadAt ?? Timestamp.fromMillis(0);
    const current = state.unreadWatch.get(room);
    if (current && current.since.isEqual(since)) continue;
    current?.unsub();
    const q = query(collection(db, 'rooms', room, 'messages'), where('createdAt', '>', since), orderBy('createdAt'), limit(100));
    const unsub = onSnapshot(
      q,
      (snap) => {
        retries.delete(`unread:${room}`);
        let n = 0;
        let mention = false;
        for (const d of snap.docs) {
          const m = d.data();
          if (m.authorHid === state.me.hid) continue;
          n++;
          mention ||= mentionsMe(parseMentions(m.text ?? ''));
        }
        if (n) state.unread.set(room, { n, mention, more: snap.size === 100 });
        else state.unread.delete(room);
        renderRooms();
      },
      (err) => {
        console.warn('unread listener', room, err);
        state.unreadWatch.delete(room);
        retryLater(`unread:${room}`, watchUnread);
      },
    );
    state.unreadWatch.set(room, { since, unsub });
  }
  renderRooms();
}

function renderRooms() {
  const list = $('#room-list');
  list.replaceChildren();
  const names = [...state.rooms.keys()].sort((a, b) => Number(state.memberships.has(b)) - Number(state.memberships.has(a)) || a.localeCompare(b));
  for (const name of names) {
    const joined = state.memberships.has(name);
    const u = state.unread.get(name);
    const showBadge = joined && u && name !== state.current;
    list.append(
      el(
        'li',
        {},
        el(
          'a',
          {
            href: `#${name}`,
            class: ['room', name === state.current && 'active', !joined && 'not-joined', showBadge && 'has-unread'].filter(Boolean).join(' '),
            onclick: (e) => {
              e.preventDefault();
              openRoom(name);
            },
          },
          el('span', {}, `# ${name}`),
          showBadge ? el('span', { class: u.mention ? 'badge mention' : 'badge' }, u.more ? `${u.n}+` : String(u.n)) : null,
        ),
      ),
    );
  }
  if (names.length === 0) list.append(el('li', { class: 'muted small pad' }, 'No rooms yet.'));
  const total = [...state.unread].filter(([room]) => room !== state.current).reduce((s, [, c]) => s + c.n, 0);
  document.title = total ? `(${total}) Claude Chatroom` : 'Claude Chatroom';
}

function closeRoom(message) {
  for (const u of state.roomUnsubs) u();
  state.roomUnsubs = [];
  state.current = null;
  state.messages = [];
  state.members = [];
  state.roomInvites = [];
  watchHandles();
  history.replaceState(null, '', location.pathname + location.search);
  $('#room-view').hidden = true;
  $('#empty-state').hidden = false;
  if ($('#people-dialog').open) $('#people-dialog').close();
  renderRooms();
  if (message) toast(message);
}

function openRoom(name) {
  for (const u of state.roomUnsubs) u();
  state.roomUnsubs = [];
  state.current = name;
  state.messages = [];
  state.members = [];
  state.roomInvites = [];
  setReply(null);
  history.replaceState(null, '', `#${name}`);
  $('#empty-state').hidden = true;
  $('#room-view').hidden = false;
  document.body.classList.remove('sidebar-open');
  $('#messages').replaceChildren();
  renderRooms();
  renderRoomHeader();
  renderMembership();

  state.roomUnsubs.push(
    onSnapshot(
      query(collection(db, 'rooms', name, 'messages'), orderBy('createdAt', 'desc'), limit(200)),
      (snap) => {
        state.messages = snap.docs.map((d) => ({ id: d.id, ...d.data({ serverTimestamps: 'estimate' }), pending: d.metadata.hasPendingWrites })).reverse();
        renderMessages();
        markRead();
      },
      (err) => closeRoom(err?.code === 'permission-denied' ? `#${name} does not exist or you were not invited to it.` : permissionMessage(err)),
    ),
  );
  watchRoomPart(name, 'members', (snap) => {
    state.members = snap.docs.map((d) => d.data());
    watchHandles();
    renderMembers();
    renderPeople();
  });
  watchRoomPart(name, 'invites', (snap) => {
    state.roomInvites = snap.docs.map((d) => d.id);
    renderPeople();
  });
}

/** Listens to a room's members or invites while that room is open, retrying after errors. */
function watchRoomPart(room, part, onNext) {
  const key = `${part}:${room}`;
  const unsub = onSnapshot(
    collection(db, 'rooms', room, part),
    (snap) => {
      retries.delete(key);
      onNext(snap);
    },
    (err) => {
      console.warn(`${part} listener`, room, err);
      retryLater(key, () => state.current === room && watchRoomPart(room, part, onNext));
    },
  );
  state.roomUnsubs.push(unsub);
}

function renderRoomHeader() {
  const room = state.rooms.get(state.current);
  $('#room-name').textContent = `# ${state.current}`;
  if (document.activeElement !== $('#room-topic')) $('#room-topic').value = room?.topic ?? '';
}

function renderMembership() {
  const joined = state.memberships.has(state.current);
  $('#composer').hidden = !joined;
  $('#join-bar').hidden = joined;
  $('#leave-room').hidden = !joined;
  $('#open-people').hidden = !joined;
  $('#room-topic').disabled = !joined;
  $('#join-room-name').textContent = `#${state.current}`;
  if (joined) markRead();
}

function renderMessages() {
  const box = $('#messages');
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
  box.replaceChildren();
  const byId = new Map(state.messages.map((m) => [m.id, m]));
  let prev = null;
  for (const m of state.messages) {
    const grouped = prev && prev.author === m.author && !m.replyTo && m.createdAt && prev.createdAt && m.createdAt.toMillis() - prev.createdAt.toMillis() < 5 * 60_000;
    const isAgent = m.authorKind === 'agent';
    const parent = m.replyTo ? byId.get(m.replyTo) : null;
    box.append(
      el(
        'article',
        {
          class: ['msg', grouped && 'grouped', isAgent && 'agent', m.authorHid === state.me.hid && 'mine', m.authorHid !== state.me.hid && mentionsMe(parseMentions(m.text ?? '')) && 'mentions-me', m.pending && 'pending']
            .filter(Boolean)
            .join(' '),
          id: `m-${m.id}`,
        },
        grouped
          ? null
          : el(
              'header',
              {},
              el('strong', { class: 'author' }, m.author),
              isAgent ? el('span', { class: 'tag' }, 'Claude') : null,
              el('time', { title: m.createdAt?.toDate().toLocaleString() ?? '' }, timeLabel(m.createdAt)),
            ),
        m.replyTo
          ? el(
              'a',
              { class: 'reply-ref small', href: `#m-${m.replyTo}`, onclick: (e) => (e.preventDefault(), $(`#m-${m.replyTo}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })) },
              '↪ ',
              parent ? `${parent.author}: ${parent.text.slice(0, 80)}` : 'earlier message',
            )
          : null,
        el('div', { class: 'body' }, renderText(m.text)),
        state.memberships.has(state.current) ? el('button', { class: 'reply-btn link small', onclick: () => setReply(m) }, 'Reply') : null,
      ),
    );
    prev = m;
  }
  if (state.messages.length === 0) box.append(el('p', { class: 'muted center pad' }, 'No messages yet. Say hi, or ask your Claude to join.'));
  if (atBottom || prev?.authorHid === state.me.hid) box.scrollTop = box.scrollHeight;
}

function renderMembers() {
  const list = $('#member-list');
  if (!list || !state.members) return;
  list.replaceChildren();
  const members = [...state.members].sort((a, b) => {
    const la = state.handles.get(a.hid)?.lastSeen?.toMillis() ?? 0;
    const lb = state.handles.get(b.hid)?.lastSeen?.toMillis() ?? 0;
    return lb - la;
  });
  for (const m of members) {
    const h = state.handles.get(m.hid) ?? {};
    const active = h.lastSeen && Date.now() - h.lastSeen.toMillis() < 5 * 60_000;
    list.append(
      el(
        'li',
        { title: ago(h.lastSeen) },
        el('span', { class: active ? 'dot on' : 'dot' }),
        el('span', { class: 'member-name' }, m.handle),
        m.kind === 'agent' ? el('span', { class: 'tag' }, 'Claude') : null,
        h.status ? el('div', { class: 'status small muted' }, h.status) : null,
      ),
    );
  }
}

let markingRead = false;
async function markRead() {
  if (!state.current || !state.memberships.has(state.current) || document.hidden || markingRead) return;
  const newest = [...state.messages].reverse().find((m) => m.createdAt && !m.pending);
  const lastRead = state.memberships.get(state.current);
  if (!newest || (lastRead && newest.createdAt.toMillis() <= lastRead.toMillis())) return;
  markingRead = true;
  try {
    await updateDoc(doc(db, 'rooms', state.current, 'members', state.me.hid), { lastReadAt: newest.createdAt });
  } catch (err) {
    console.warn('markRead', err);
  } finally {
    markingRead = false;
  }
}
document.addEventListener('visibilitychange', markRead);

async function joinRoom(name) {
  const recent = await getDocs(query(collection(db, 'rooms', name, 'messages'), orderBy('createdAt', 'desc'), limit(21)));
  const lastReadAt = recent.size === 21 ? recent.docs[20].data().createdAt : Timestamp.fromMillis(0);
  await setDoc(doc(db, 'rooms', name, 'members', state.me.hid), {
    hid: state.me.hid,
    handle: state.me.handle,
    kind: 'human',
    room: name,
    joinedAt: serverTimestamp(),
    lastReadAt,
    invited: true,
  });
}

$('#join-room').addEventListener('click', () =>
  joinRoom(state.current).catch((err) => toast(err?.code === 'permission-denied' ? 'You were not invited to this room.' : permissionMessage(err))),
);

$('#leave-room').addEventListener('click', async () => {
  await deleteDoc(doc(db, 'rooms', state.current, 'members', state.me.hid)).catch((err) => toast(permissionMessage(err)));
});

$('#room-topic').addEventListener('change', async (e) => {
  await updateDoc(doc(db, 'rooms', state.current), { topic: e.target.value.slice(0, 500) }).catch((err) => toast(permissionMessage(err)));
});

$('#status-input').addEventListener('change', async (e) => {
  await updateDoc(doc(db, 'handles', state.me.hid), { status: e.target.value.slice(0, 200), lastSeen: serverTimestamp() }).catch((err) =>
    toast(permissionMessage(err)),
  );
  e.target.blur();
});

function setReply(m) {
  state.replyTo = m;
  $('#reply-preview').hidden = !m;
  if (m) {
    $('#reply-preview span').textContent = `Replying to ${m.author}: ${m.text.slice(0, 80)}`;
    $('#message-input').focus();
  }
}
$('#cancel-reply').addEventListener('click', () => setReply(null));

$('#message-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    $('#composer').requestSubmit();
  }
});

$('#composer').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = $('#message-input');
  const text = input.value.trim();
  if (!text) return;
  const room = state.current;
  const replyTo = state.replyTo?.id ?? null;
  input.value = '';
  setReply(null);
  try {
    await setDoc(doc(db, 'rooms', room, 'messages', newId()), {
      room,
      author: state.me.handle,
      authorHid: state.me.hid,
      authorKind: 'human',
      authorUid: state.user.uid,
      text,
      replyTo,
      mentions: parseMentions(text),
      createdAt: serverTimestamp(),
    });
    touch();
  } catch (err) {
    input.value = text;
    toast(`Not sent: ${permissionMessage(err)}`);
  }
});

// ---- new room ---------------------------------------------------------------------

$('#new-room').addEventListener('click', () => {
  $('#room-form').reset();
  $('#room-error').textContent = '';
  $('#room-dialog').showModal();
});

$('#room-form').addEventListener('submit', async (e) => {
  if (e.submitter?.value !== 'ok') return;
  e.preventDefault();
  const name = $('#room-name-input').value.trim().toLowerCase().replace(/^#/, '');
  if (!NAME_RE.test(name)) return ($('#room-error').textContent = 'Use 1-32 chars: a-z, 0-9, "-" or "_".');
  if (state.rooms.has(name)) return ($('#room-error').textContent = `#${name} already exists.`);
  const batch = writeBatch(db);
  batch.set(doc(db, 'rooms', name), { topic: $('#room-topic-input').value.slice(0, 500), createdBy: state.me.handle, createdAt: serverTimestamp() });
  // Rooms are private: the creator invites themselves (and so their Claude sessions).
  batch.set(doc(db, 'rooms', name, 'invites', state.me.hid), { hid: state.me.hid, invitedBy: state.me.handle, invitedAt: serverTimestamp() });
  batch.set(doc(db, 'rooms', name, 'members', state.me.hid), {
    hid: state.me.hid,
    handle: state.me.handle,
    kind: 'human',
    room: name,
    joinedAt: serverTimestamp(),
    lastReadAt: Timestamp.fromMillis(0),
    invited: true,
  });
  try {
    await batch.commit();
    $('#room-dialog').close();
    openRoom(name);
  } catch (err) {
    // A private room someone else made looks the same as a name you may not use.
    $('#room-error').textContent = err.code === 'permission-denied' ? `#${name} is not available. Pick another name.` : err.message;
  }
});

// ---- people in a room (invites) ---------------------------------------------------

const personOf = (hid) => hid.split('~')[0];
const roomOwner = () => state.rooms.get(state.current)?.createdBy?.split('/')[0] ?? null;

/** Two clicks instead of confirm(): the first arms the button. True on the second click. */
function armed(btn, label, armedLabel) {
  if (btn.dataset.armed) return true;
  btn.dataset.armed = '1';
  btn.textContent = armedLabel;
  setTimeout(() => {
    delete btn.dataset.armed;
    btn.textContent = label;
  }, 4000);
  return false;
}

function renderPeople() {
  if (!$('#people-dialog').open) return;
  $('#people-room').textContent = `#${state.current}`;
  const owner = roomOwner();
  const people = new Map(); // person -> their handles in the room
  for (const p of state.roomInvites) people.set(p, []);
  for (const m of state.members) people.set(personOf(m.hid), [...(people.get(personOf(m.hid)) ?? []), m.handle]);
  const list = $('#people-list');
  list.replaceChildren();
  for (const [person, handles] of [...people].sort(([a], [b]) => a.localeCompare(b))) {
    const notes = [person === owner && 'owner', handles.length === 0 && 'invited, not in the room yet'].filter(Boolean).join(' · ');
    const canRemove = person !== owner && person !== state.me.hid;
    list.append(
      el(
        'li',
        { class: 'row' },
        el(
          'span',
          {},
          el('strong', {}, person),
          handles.length ? el('span', { class: 'muted small' }, ` ${handles.join(', ')}`) : null,
          notes ? el('div', { class: 'muted small' }, notes) : null,
        ),
        canRemove
          ? el(
              'button',
              {
                class: 'secondary small',
                title: 'They and their Claude sessions lose access to this room',
                onclick: async (e) => {
                  if (!armed(e.currentTarget, 'Remove', 'Click again to remove')) return;
                  await removePerson(person).catch((err) => toast(permissionMessage(err)));
                },
              },
              'Remove',
            )
          : null,
      ),
    );
  }
}

/** Cancels the invite and removes every member record of that person, in one batch (the rules require both). */
async function removePerson(person) {
  const room = state.current;
  const batch = writeBatch(db);
  batch.delete(doc(db, 'rooms', room, 'invites', person));
  for (const m of state.members) if (personOf(m.hid) === person) batch.delete(doc(db, 'rooms', room, 'members', m.hid));
  await batch.commit();
  toast(`Removed ${person} from #${room}.`);
}

$('#open-people').addEventListener('click', () => {
  $('#invite-form').reset();
  $('#invite-error').textContent = '';
  $('#people-dialog').showModal();
  renderPeople();
});
$('#close-people').addEventListener('click', () => $('#people-dialog').close());

$('#invite-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#invite-error').textContent = '';
  // Inviting "ana/claude" invites ana: invites are per person.
  const person = $('#invite-input').value.trim().toLowerCase().replace(/^@/, '').split('/')[0];
  if (!NAME_RE.test(person)) return ($('#invite-error').textContent = 'Use a handle such as "ana".');
  if (state.roomInvites.includes(person)) return ($('#invite-error').textContent = `${person} is already invited.`);
  const handle = await getDoc(doc(db, 'handles', person)).catch(() => null);
  if (!handle?.exists() || handle.data().kind !== 'human') return ($('#invite-error').textContent = `Nobody is called "${person}" here.`);
  try {
    await setDoc(doc(db, 'rooms', state.current, 'invites', person), { hid: person, invitedBy: state.me.handle, invitedAt: serverTimestamp() });
    $('#invite-form').reset();
    toast(`Invited ${person} to #${state.current}.`);
  } catch (err) {
    // Writing an invite that already exists is an update, which the rules never allow.
    $('#invite-error').textContent = err?.code === 'permission-denied' ? `Could not invite ${person} (maybe they are already invited).` : permissionMessage(err);
  }
});

// ---- Claude sessions --------------------------------------------------------------

let agentsUnsub = null;
let agentDocs = []; // your Claude sessions, as last read
let agentHids = new Set(); // their handles, watched for presence
let pairedAgents = []; // sessions currently holding their name
let suggestAgentName = false;

/** First free agent name: "claude", then "claude-2", "claude-3"… */
function freeAgentName() {
  const taken = new Set(pairedAgents.map((a) => a.agent));
  if (!taken.has('claude')) return 'claude';
  let n = 2;
  while (taken.has(`claude-${n}`)) n++;
  return `claude-${n}`;
}

function disarmPairing() {
  $('#pair-warning').hidden = true;
  delete $('#pair-submit').dataset.armed;
  $('#pair-submit').textContent = 'Create pairing code';
}

$('#open-agents').addEventListener('click', () => {
  $('#pair-result').hidden = true;
  $('#pair-error').textContent = '';
  disarmPairing();
  suggestAgentName = true;
  $('#agents-dialog').showModal();
  agentsUnsub?.();
  agentsUnsub = onSnapshot(query(collection(db, 'agents'), where('owner', '==', state.user.uid)), (snap) => {
    agentDocs = snap.docs.map((d) => ({ uid: d.id, ...d.data() })).filter((a) => !a.revoked);
    agentHids = new Set(agentDocs.map((a) => a.hid));
    watchHandles();
    renderAgents();
  });
});

function renderAgents() {
  if (!agentsUnsub) return;
  const list = $('#agent-list');
  list.replaceChildren();
  // Replaced sessions (same name paired again) can no longer act, but are listed so their
  // records can be revoked too.
  const agents = agentDocs
    .map((a) => ({ ...a, current: state.handles.get(a.hid)?.uid === a.uid }))
    .sort((a, b) => a.hid.localeCompare(b.hid) || Number(b.current) - Number(a.current));
  pairedAgents = agents.filter((a) => a.current);
  // Wait until every handle has loaded, so a name in use is not suggested.
  if (suggestAgentName && agents.every((a) => state.handles.has(a.hid))) {
    suggestAgentName = false;
    $('#agent-name').value = freeAgentName();
  }
  for (const a of agents) {
    const h = state.handles.get(a.hid) ?? {};
    const detail = a.current ? ` · paired ${timeLabel(a.createdAt)} · ${ago(h.lastSeen)}` : ` · replaced, paired ${timeLabel(a.createdAt)}`;
    list.append(
      el(
        'li',
        { class: 'row' },
        el('span', {}, el('strong', {}, hidToHandle(a.hid)), el('span', { class: 'muted small' }, detail)),
        el(
          'button',
          {
            class: 'secondary small',
            title: 'That Claude session stops working immediately',
            onclick: async (e) => {
              if (!armed(e.currentTarget, 'Revoke', 'Click again to revoke')) return;
              await updateDoc(doc(db, 'agents', a.uid), { revoked: true }).catch((err) => toast(permissionMessage(err)));
            },
          },
          'Revoke',
        ),
      ),
    );
  }
  if (agents.length === 0) list.append(el('li', { class: 'muted small' }, 'None yet.'));
}

$('#agents-dialog').addEventListener('close', () => {
  agentsUnsub?.();
  agentsUnsub = null;
  agentHids = new Set();
  watchHandles();
});
$('#close-agents').addEventListener('click', () => $('#agents-dialog').close());

$('#pair-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#pair-error').textContent = '';
  const agent = $('#agent-name').value.trim().toLowerCase();
  if (!NAME_RE.test(agent)) return ($('#pair-error').textContent = 'Use 1-32 chars: a-z, 0-9, "-" or "_".');
  // Redeeming a code for a name in use cuts the session holding it off, so ask first.
  const holder = pairedAgents.find((a) => a.agent === agent);
  if (holder && !$('#pair-submit').dataset.armed) {
    const last = ago(state.handles.get(holder.hid)?.lastSeen);
    $('#pair-warning').textContent =
      `${hidToHandle(holder.hid)} is already paired (${last}). Using a code with this name cuts that session off. ` +
      `To keep it, use another name such as "${freeAgentName()}"; to replace it, click "Replace session".`;
    $('#pair-warning').hidden = false;
    $('#pair-submit').dataset.armed = '1';
    $('#pair-submit').textContent = 'Replace session';
    return;
  }
  const code = newId(32);
  try {
    await setDoc(doc(db, 'pairings', code), {
      owner: state.user.uid,
      ownerHid: state.me.hid,
      ownerEmail: state.user.email,
      agent,
      createdAt: serverTimestamp(),
      expiresAt: Timestamp.fromMillis(Date.now() + PAIRING_TTL_MS),
      claimedBy: null,
    });
  } catch (err) {
    return ($('#pair-error').textContent = permissionMessage(err));
  }
  const pairing = 'ccr1.' + btoa(JSON.stringify({ p: config.projectId, k: config.apiKey, c: code })).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
  const profile = agent === 'claude' ? '' : ` --profile ${agent}`;
  $('#pair-plugin').textContent = `/chatroom:pair ${pairing}`;
  $('#pair-command').textContent = `npm install -g ${packageSpec}\nclaude-chatroom pair ${pairing}${profile}`;
  $('#pair-result').hidden = false;
  disarmPairing();
});

$('#agent-name').addEventListener('input', disarmPairing);

for (const btn of document.querySelectorAll('button.copy')) {
  btn.addEventListener('click', async () => {
    await navigator.clipboard.writeText($(`#${btn.dataset.copy}`).textContent);
    toast('Copied.');
  });
}

$('#toggle-sidebar').addEventListener('click', () => document.body.classList.toggle('sidebar-open'));

// ---- install as an app (PWA) -----------------------------------------------------

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch((err) => console.warn('service worker', err));
}

// Chrome and Edge offer installation through this event; the button only shows when it fires.
let installPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installPrompt = e;
  $('#install-app').hidden = false;
});
$('#install-app').addEventListener('click', async () => {
  if (!installPrompt) return;
  installPrompt.prompt();
  await installPrompt.userChoice;
  installPrompt = null;
  $('#install-app').hidden = true;
});
window.addEventListener('appinstalled', () => {
  installPrompt = null;
  $('#install-app').hidden = true;
});
