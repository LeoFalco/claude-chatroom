// Minimal Firebase Auth + Firestore REST client for Node. The web UI uses the official
// JS SDK; the MCP server uses this so it stays dependency-free and can authenticate as an
// anonymous user from a stored refresh token.
//
// Emulators are used when FIREBASE_AUTH_EMULATOR_HOST / FIRESTORE_EMULATOR_HOST are set.

export class FirebaseError extends Error {
  constructor(message, { status, code } = {}) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export const REQUEST_TIME = Symbol('REQUEST_TIME');

// ---- value encoding ---------------------------------------------------------

export function encodeValue(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (v instanceof Timestamp) return { timestampValue: v.value };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (typeof v === 'string') return { stringValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(encodeValue) } };
  if (typeof v === 'object') return { mapValue: { fields: encodeFields(v) } };
  throw new TypeError(`Cannot encode ${typeof v}`);
}

export function encodeFields(obj) {
  const fields = {};
  for (const [k, v] of Object.entries(obj)) if (v !== REQUEST_TIME) fields[k] = encodeValue(v);
  return fields;
}

export function decodeValue(v) {
  if ('nullValue' in v) return null;
  if ('booleanValue' in v) return v.booleanValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('stringValue' in v) return v.stringValue;
  if ('timestampValue' in v) return new Timestamp(v.timestampValue);
  if ('arrayValue' in v) return (v.arrayValue.values ?? []).map(decodeValue);
  if ('mapValue' in v) return decodeFields(v.mapValue.fields ?? {});
  if ('referenceValue' in v) return v.referenceValue;
  return null;
}

export function decodeFields(fields = {}) {
  const out = {};
  for (const [k, v] of Object.entries(fields)) out[k] = decodeValue(v);
  return out;
}

/** RFC 3339 timestamp as returned by Firestore, comparable via `key`. */
export class Timestamp {
  constructor(value) {
    this.value = value;
  }

  /** Fixed-width "YYYY-MM-DDTHH:MM:SS.nnnnnnnnnZ" so string comparison orders correctly. */
  get key() {
    const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?Z$/.exec(this.value);
    if (!m) return new Date(this.value).toISOString().replace('Z', '000000Z');
    return `${m[1]}.${(m[2] ?? '').padEnd(9, '0').slice(0, 9)}Z`;
  }

  compare(other) {
    return this.key < other.key ? -1 : this.key > other.key ? 1 : 0;
  }

  toJSON() {
    return this.value;
  }

  toString() {
    return this.value;
  }

  static epoch() {
    return new Timestamp('1970-01-01T00:00:00Z');
  }
}

// ---- client -----------------------------------------------------------------

export class FirebaseClient {
  /**
   * @param {{ projectId: string, apiKey: string, refreshToken?: string, env?: object, fetch?: Function }} opts
   */
  constructor({ projectId, apiKey, refreshToken, env = process.env, fetch: fetchImpl = globalThis.fetch }) {
    if (!projectId || !apiKey) throw new Error('projectId and apiKey are required');
    this.projectId = projectId;
    this.apiKey = apiKey;
    this.refreshToken = refreshToken ?? null;
    this.fetch = fetchImpl;
    this.uid = null;
    this._idToken = null;
    this._expiresAt = 0;

    const authHost = env.FIREBASE_AUTH_EMULATOR_HOST;
    const fsHost = env.FIRESTORE_EMULATOR_HOST;
    this.identityUrl = authHost ? `http://${authHost}/identitytoolkit.googleapis.com/v1` : 'https://identitytoolkit.googleapis.com/v1';
    this.secureTokenUrl = authHost ? `http://${authHost}/securetoken.googleapis.com/v1` : 'https://securetoken.googleapis.com/v1';
    this.databaseName = `projects/${projectId}/databases/(default)`;
    this.firestoreUrl = `${fsHost ? `http://${fsHost}` : 'https://firestore.googleapis.com'}/v1/${this.databaseName}`;
    this.documentsRoot = `${this.databaseName}/documents`;
  }

  // ---- auth -----------------------------------------------------------------

  async _authRequest(url, body, form = false) {
    const res = await this.fetch(url, {
      method: 'POST',
      headers: { 'content-type': form ? 'application/x-www-form-urlencoded' : 'application/json' },
      body: form ? new URLSearchParams(body) : JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      const code = json.error?.message ?? `HTTP ${res.status}`;
      throw new FirebaseError(`Firebase Auth error: ${code}`, { status: res.status, code });
    }
    return json;
  }

  _setSession({ idToken, refreshToken, expiresIn, uid }) {
    this._idToken = idToken;
    this.refreshToken = refreshToken;
    this._expiresAt = Date.now() + Number(expiresIn ?? 3600) * 1000;
    if (uid) this.uid = uid;
  }

  async signUpAnonymously() {
    const r = await this._authRequest(`${this.identityUrl}/accounts:signUp?key=${this.apiKey}`, { returnSecureToken: true });
    this._setSession({ idToken: r.idToken, refreshToken: r.refreshToken, expiresIn: r.expiresIn, uid: r.localId });
    return this.uid;
  }

  /** Signs in with an identity provider credential. Only used against the Auth emulator in tests. */
  async signInWithIdp(providerId, claims) {
    const r = await this._authRequest(`${this.identityUrl}/accounts:signInWithIdp?key=${this.apiKey}`, {
      postBody: `id_token=${encodeURIComponent(JSON.stringify(claims))}&providerId=${providerId}`,
      requestUri: 'http://localhost',
      returnSecureToken: true,
      returnIdpCredential: true,
    });
    this._setSession({ idToken: r.idToken, refreshToken: r.refreshToken, expiresIn: r.expiresIn, uid: r.localId });
    return this.uid;
  }

  async idToken() {
    if (this._idToken && Date.now() < this._expiresAt - 120_000) return this._idToken;
    if (!this.refreshToken) throw new FirebaseError('Not signed in.', { code: 'NOT_SIGNED_IN' });
    const r = await this._authRequest(
      `${this.secureTokenUrl}/token?key=${this.apiKey}`,
      { grant_type: 'refresh_token', refresh_token: this.refreshToken },
      true,
    );
    this._setSession({ idToken: r.id_token, refreshToken: r.refresh_token, expiresIn: r.expires_in, uid: r.user_id });
    return this._idToken;
  }

  // ---- firestore --------------------------------------------------------------

  docName(path) {
    return `${this.documentsRoot}/${path}`;
  }

  async _request(method, url, body) {
    const res = await this.fetch(url, {
      method,
      headers: { authorization: `Bearer ${await this.idToken()}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    const json = text ? JSON.parse(text) : {};
    if (!res.ok) {
      const err = Array.isArray(json) ? json[0]?.error : json.error;
      throw new FirebaseError(err?.message ?? `HTTP ${res.status}`, { status: res.status, code: err?.status });
    }
    return json;
  }

  /** Returns { id, path, data } or null when the document does not exist. */
  async get(path) {
    try {
      const d = await this._request('GET', `${this.firestoreUrl}/documents/${path}`);
      return toDoc(d);
    } catch (err) {
      if (err.status === 404) return null;
      throw err;
    }
  }

  async batchGet(paths) {
    if (paths.length === 0) return [];
    const r = await this._request('POST', `${this.firestoreUrl}/documents:batchGet`, { documents: paths.map((p) => this.docName(p)) });
    const byName = new Map(r.filter((x) => x.found).map((x) => [x.found.name, toDoc(x.found)]));
    return paths.map((p) => byName.get(this.docName(p)) ?? null);
  }

  /**
   * Atomic batch. Each write: { path, data, mode: 'create' | 'update' | 'set' } or { path, mode: 'delete' }.
   * Fields set to REQUEST_TIME become server timestamps. Returns per-write transform results.
   */
  async commit(writes) {
    const body = {
      writes: writes.map((w) => {
        if (w.mode === 'delete') return { delete: this.docName(w.path) };
        const out = { update: { name: this.docName(w.path), fields: encodeFields(w.data) } };
        const serverTime = Object.entries(w.data).filter(([, v]) => v === REQUEST_TIME).map(([k]) => k);
        if (serverTime.length) out.updateTransforms = serverTime.map((fieldPath) => ({ fieldPath, setToServerValue: 'REQUEST_TIME' }));
        if (w.mode === 'create') out.currentDocument = { exists: false };
        if (w.mode === 'update') {
          out.currentDocument = { exists: true };
          out.updateMask = { fieldPaths: Object.keys(w.data).filter((k) => w.data[k] !== REQUEST_TIME) };
        }
        return out;
      }),
    };
    const r = await this._request('POST', `${this.firestoreUrl}/documents:commit`, body);
    return (r.writeResults ?? []).map((wr) => (wr.transformResults ?? []).map(decodeValue));
  }

  /**
   * Runs a structured query. `parent` is a document path ('' for the root).
   * Returns [{ id, path, data }].
   */
  async query(parent, structuredQuery) {
    const url = `${this.firestoreUrl}/documents${parent ? `/${parent}` : ''}:runQuery`;
    const r = await this._request('POST', url, { structuredQuery });
    return r.filter((x) => x.document).map((x) => toDoc(x.document));
  }
}

function toDoc(d) {
  const path = d.name.split('/documents/')[1];
  return { id: path.split('/').pop(), path, data: decodeFields(d.fields), updateTime: d.updateTime };
}

// ---- query helpers ----------------------------------------------------------------

export const q = {
  field: (fieldPath, op, value) => ({ fieldFilter: { field: { fieldPath }, op, value: encodeValue(value) } }),
  and: (...filters) => (filters.length === 1 ? filters[0] : { compositeFilter: { op: 'AND', filters } }),
  order: (fieldPath, direction = 'ASCENDING') => ({ field: { fieldPath }, direction }),
};
