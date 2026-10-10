// The Rieger House API, running as a Cloudflare Worker with a D1 database.
// Static files in public/ are served by Workers Static Assets; only /api/* reaches this code.

const SESSION_DAYS = 180;
const DAY_MS = 86_400_000;
const MAX_BODY = 16 * 1024;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const PIN_RE = /^\d{4,8}$/;
const ADMIN_MIN_PIN = 6;
const PBKDF2_ITERATIONS = 100_000; // the most Workers allows
const PALETTE = ['#2F7D5B', '#B5525A', '#3F6C9E', '#C08A1E', '#7A5A9E', '#3D8A8A', '#A8613A', '#5E6E2E'];

// ---------- helpers ----------

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const now = () => Date.now();
const enc = new TextEncoder();
const toHex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const fromHex = (hex) => new Uint8Array(hex.match(/../g).map((h) => parseInt(h, 16)));

async function sha256(s) {
  return toHex(await crypto.subtle.digest('SHA-256', enc.encode(s)));
}

async function pbkdf2(pin, salt, iterations) {
  const key = await crypto.subtle.importKey('raw', enc.encode(pin), 'PBKDF2', false, ['deriveBits']);
  return crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256);
}

export async function hashPin(pin) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await pbkdf2(pin, salt, PBKDF2_ITERATIONS);
  return `pbkdf2$${PBKDF2_ITERATIONS}$${toHex(salt)}$${toHex(hash)}`;
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

async function verifyPin(pin, stored) {
  if (!stored || typeof pin !== 'string') return false;
  const [scheme, iterations, saltHex, hashHex] = stored.split('$');
  if (scheme !== 'pbkdf2') return false;
  const actual = new Uint8Array(await pbkdf2(pin, fromHex(saltHex), Number(iterations)));
  return timingSafeEqual(actual, fromHex(hashHex));
}

function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function validDate(s) {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

function cleanName(name) {
  if (typeof name !== 'string') throw new HttpError(400, 'Enter a name.');
  const n = name.trim().replace(/\s+/g, ' ');
  if (!n || n.length > 30) throw new HttpError(400, 'Names need to be 1 to 30 characters.');
  return n;
}

function checkPin(pin, role) {
  if (typeof pin !== 'string' || !PIN_RE.test(pin)) throw new HttpError(400, 'PINs are 4 to 8 digits.');
  if (role === 'admin' && pin.length < ADMIN_MIN_PIN) {
    throw new HttpError(400, `The admin PIN needs at least ${ADMIN_MIN_PIN} digits.`);
  }
}

function parseCookies(header) {
  const out = {};
  for (const part of (header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

async function readBody(request) {
  const text = await request.text();
  if (text.length > MAX_BODY) throw new HttpError(413, 'Request too large.');
  if (!text) return {};
  try {
    const body = JSON.parse(text);
    return body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  } catch {
    throw new HttpError(400, 'Invalid JSON.');
  }
}

const publicUser = (u) => ({
  id: u.id,
  name: u.name,
  role: u.role,
  color: u.color,
  onDinnerList: !!u.on_dinner_list,
});

const adminUserView = (u) => ({ ...publicUser(u), hasPin: !!u.pin_hash, locked: u.locked_until > now() });

const publicResponse = (r) => ({
  userId: r.user_id,
  date: r.date,
  home: r.home === null ? null : !!r.home,
  goingOut: !!r.going_out,
  outWhat: r.out_what,
  outTime: r.out_time,
  updatedAt: r.updated_at,
});

// ---------- per-request context ----------

class Ctx {
  constructor(request, env) {
    this.request = request;
    this.env = env;
    this.db = env.DB;
    this.url = new URL(request.url);
    this.cookies = [];
  }

  first(sql, ...args) {
    return this.db.prepare(sql).bind(...args).first();
  }
  async all(sql, ...args) {
    return (await this.db.prepare(sql).bind(...args).all()).results;
  }
  run(sql, ...args) {
    return this.db.prepare(sql).bind(...args).run();
  }

  get ip() {
    return this.request.headers.get('CF-Connecting-IP') || 'unknown';
  }

  async settings() {
    const rows = await this.all("SELECT key, value FROM settings WHERE key IN ('household_name', 'everyone_can_edit')");
    const map = Object.fromEntries(rows.map((r) => [r.key, r.value]));
    return {
      householdName: map.household_name || 'The Rieger House',
      everyoneCanEdit: map.everyone_can_edit === '1',
    };
  }

  async needsSetup() {
    const row = await this.first("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND active = 1");
    return row.n === 0;
  }

  activeUsers() {
    return this.all('SELECT * FROM users WHERE active = 1 ORDER BY sort_order, id');
  }

  userById(id) {
    return this.first('SELECT * FROM users WHERE id = ? AND active = 1', Number(id) || 0);
  }

  // Slows down PIN guessing from any one address: 30 tries per 15 minutes.
  async throttle() {
    const t = now();
    const row = await this.first(
      `INSERT INTO throttle (ip, count, reset_at) VALUES (?1, 1, ?2)
       ON CONFLICT(ip) DO UPDATE SET
         count = CASE WHEN reset_at < ?3 THEN 1 ELSE count + 1 END,
         reset_at = CASE WHEN reset_at < ?3 THEN excluded.reset_at ELSE reset_at END
       RETURNING count`,
      this.ip, t + 15 * 60_000, t
    );
    if (row.count > 30) throw new HttpError(429, 'Too many attempts. Try again in a few minutes.');
  }

  setSessionCookie(value, maxAge) {
    const parts = [`rh_session=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAge}`];
    if (this.url.protocol === 'https:') parts.push('Secure');
    this.cookies.push(parts.join('; '));
  }

  async startSession(userId) {
    const token = randomToken();
    const t = now();
    await this.db.batch([
      this.db.prepare('DELETE FROM sessions WHERE expires_at <= ?').bind(t),
      this.db.prepare('DELETE FROM throttle WHERE reset_at <= ?').bind(t),
      this.db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)').bind(await sha256(token), userId, t + SESSION_DAYS * DAY_MS),
    ]);
    this.setSessionCookie(token, SESSION_DAYS * 86_400);
  }

  async currentUser() {
    if (this._user !== undefined) return this._user;
    this._user = null;
    const token = parseCookies(this.request.headers.get('Cookie')).rh_session;
    if (!token) return null;
    const hash = await sha256(token);
    const row = await this.first(
      'SELECT u.*, s.expires_at AS s_expires FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ? AND u.active = 1',
      hash, now()
    );
    if (!row) return null;
    // Slide the expiry forward at most once a day.
    const fresh = now() + SESSION_DAYS * DAY_MS;
    if (fresh - row.s_expires > DAY_MS) await this.run('UPDATE sessions SET expires_at = ? WHERE token_hash = ?', fresh, hash);
    row.tokenHash = hash;
    this._user = row;
    return row;
  }

  async requireUser() {
    const u = await this.currentUser();
    if (!u) throw new HttpError(401, 'Please sign in.');
    return u;
  }

  async requireAdmin() {
    const u = await this.requireUser();
    if (u.role !== 'admin') throw new HttpError(403, 'Only the admin can do that.');
    return u;
  }

  async nextColor() {
    const used = new Set((await this.all('SELECT color FROM users WHERE active = 1')).map((r) => r.color));
    return PALETTE.find((c) => !used.has(c)) || PALETTE[Math.floor(Math.random() * PALETTE.length)];
  }
}

// ---------- routes ----------

const routes = [];
const route = (method, pattern, handler) => {
  const keys = [];
  const re = new RegExp(`^${pattern.replace(/:(\w+)/g, (_, k) => (keys.push(k), '([^/]+)'))}$`);
  routes.push({ method, re, keys, handler });
};

route('GET', '/api/bootstrap', async (c) => ({
  needsSetup: await c.needsSetup(),
  householdName: (await c.settings()).householdName,
  people: (await c.activeUsers()).map((u) => ({ id: u.id, name: u.name, color: u.color, hasPin: !!u.pin_hash })),
}));

route('POST', '/api/setup', async (c, { body }) => {
  if (!(await c.needsSetup())) throw new HttpError(409, 'Setup has already been done.');
  await c.throttle();
  const expected = c.env.SETUP_CODE;
  if (!expected) {
    throw new HttpError(503, 'Setup is not switched on yet. Set the SETUP_CODE secret with: npx wrangler secret put SETUP_CODE');
  }
  const code = String(body.code || '').trim();
  if (!timingSafeEqual(enc.encode(code), enc.encode(expected))) {
    throw new HttpError(403, 'That setup code is not right.');
  }
  const name = cleanName(body.name || 'Lincoln');
  checkPin(body.pin, 'admin');
  const family = Array.isArray(body.family) ? body.family : [];
  if (family.length > 12) throw new HttpError(400, 'That is a lot of people. Add the rest from the admin page.');
  const familyNames = family.map(cleanName);

  const t = now();
  const insert = c.db.prepare(
    'INSERT INTO users (name, role, pin_hash, color, on_dinner_list, sort_order, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  );
  const people = [
    ...familyNames.map((n) => [n, 'member', null, 1]),
    [name, 'admin', await hashPin(body.pin), body.adminOnDinnerList ? 1 : 0],
  ];
  // The batch runs as one transaction. The settings row has a unique key, so if two
  // setups race, the second one fails as a whole.
  const results = await c.db
    .batch([
      c.db.prepare("INSERT INTO settings (key, value) VALUES ('setup_done', '1')"),
      ...people.map(([n, role, hash, onList], i) => insert.bind(n, role, hash, PALETTE[i % PALETTE.length], onList, i + 1, t)),
    ])
    .catch(() => {
      throw new HttpError(409, 'Setup has already been done.');
    });
  await c.startSession(results[results.length - 1].meta.last_row_id);
  return { ok: true };
});

route('POST', '/api/login', async (c, { body }) => {
  await c.throttle();
  const user = await c.userById(body.userId);
  if (!user) throw new HttpError(400, 'Choose your name.');
  if (!user.pin_hash) throw new HttpError(400, `${user.name} doesn't have a PIN yet. Ask the admin to set one.`);
  if (user.locked_until > now()) {
    const mins = Math.ceil((user.locked_until - now()) / 60_000);
    throw new HttpError(429, `Too many wrong PINs. Try again in ${mins} minute${mins === 1 ? '' : 's'}.`);
  }
  if (!(await verifyPin(body.pin, user.pin_hash))) {
    const fails = user.failed_logins + 1;
    const lock = fails >= 5 ? now() + Math.min(60, 5 * 2 ** (fails - 5)) * 60_000 : 0;
    await c.run('UPDATE users SET failed_logins = ?, locked_until = ? WHERE id = ?', fails, lock, user.id);
    throw new HttpError(401, 'That PIN is not right.');
  }
  await c.run('UPDATE users SET failed_logins = 0, locked_until = 0 WHERE id = ?', user.id);
  await c.startSession(user.id);
  return { ok: true };
});

route('POST', '/api/logout', async (c) => {
  const token = parseCookies(c.request.headers.get('Cookie')).rh_session;
  if (token) await c.run('DELETE FROM sessions WHERE token_hash = ?', await sha256(token));
  c.setSessionCookie('', 0);
  return { ok: true };
});

route('GET', '/api/me', async (c) => {
  const u = await c.requireUser();
  const suggestions = await c.all(
    `SELECT out_what, MAX(updated_at) AS last FROM responses
     WHERE user_id = ? AND going_out = 1 AND out_what <> ''
     GROUP BY out_what COLLATE NOCASE ORDER BY last DESC LIMIT 5`,
    u.id
  );
  return { user: publicUser(u), settings: await c.settings(), suggestions: suggestions.map((r) => r.out_what) };
});

route('POST', '/api/me/pin', async (c, { body }) => {
  const u = await c.requireUser();
  await c.throttle();
  if (!(await verifyPin(body.currentPin, u.pin_hash))) throw new HttpError(400, 'Your current PIN is not right.');
  checkPin(body.newPin, u.role);
  await c.db.batch([
    c.db.prepare('UPDATE users SET pin_hash = ? WHERE id = ?').bind(await hashPin(body.newPin), u.id),
    c.db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash <> ?').bind(u.id, u.tokenHash),
  ]);
  return { ok: true };
});

route('GET', '/api/days', async (c) => {
  await c.requireUser();
  const from = c.url.searchParams.get('from');
  const to = c.url.searchParams.get('to');
  if (!validDate(from) || !validDate(to) || from > to) throw new HttpError(400, 'Invalid date range.');
  if ((Date.parse(to) - Date.parse(from)) / DAY_MS > 62) throw new HttpError(400, 'Date range is too long.');
  const people = (await c.activeUsers()).filter((u) => u.on_dinner_list);
  const responses = await c.all(
    `SELECT r.* FROM responses r JOIN users u ON u.id = r.user_id
     WHERE u.active = 1 AND u.on_dinner_list = 1 AND r.date BETWEEN ? AND ?`,
    from, to
  );
  return { people: people.map(publicUser), responses: responses.map(publicResponse) };
});

route('PUT', '/api/responses/:userId/:date', async (c, { params, body }) => {
  const u = await c.requireUser();
  const targetId = Number(params.userId);
  const date = params.date;
  if (!validDate(date)) throw new HttpError(400, 'Invalid date.');
  const target = await c.userById(targetId);
  if (!target) throw new HttpError(404, 'That person was not found.');
  const canEdit = u.id === targetId || u.role === 'admin' || (await c.settings()).everyoneCanEdit;
  if (!canEdit) throw new HttpError(403, `Only ${target.name} or the admin can change ${target.name}'s plans.`);

  const existing = await c.first('SELECT * FROM responses WHERE user_id = ? AND date = ?', targetId, date);
  const next = existing
    ? { home: existing.home, going_out: existing.going_out, out_what: existing.out_what, out_time: existing.out_time }
    : { home: null, going_out: 0, out_what: '', out_time: '' };

  if ('home' in body) {
    if (body.home !== null && typeof body.home !== 'boolean') throw new HttpError(400, 'Invalid answer.');
    next.home = body.home === null ? null : body.home ? 1 : 0;
  }
  if ('goingOut' in body) {
    if (typeof body.goingOut !== 'boolean') throw new HttpError(400, 'Invalid answer.');
    next.going_out = body.goingOut ? 1 : 0;
  }
  if ('outWhat' in body) {
    if (typeof body.outWhat !== 'string') throw new HttpError(400, 'Invalid text.');
    next.out_what = body.outWhat.trim().slice(0, 80);
  }
  if ('outTime' in body) {
    if (typeof body.outTime !== 'string' || (body.outTime && !TIME_RE.test(body.outTime))) {
      throw new HttpError(400, 'Invalid time.');
    }
    next.out_time = body.outTime;
  }

  const saved = await c.first(
    `INSERT INTO responses (user_id, date, home, going_out, out_what, out_time, updated_at, updated_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, date) DO UPDATE SET
       home = excluded.home, going_out = excluded.going_out, out_what = excluded.out_what,
       out_time = excluded.out_time, updated_at = excluded.updated_at, updated_by = excluded.updated_by
     RETURNING *`,
    targetId, date, next.home, next.going_out, next.out_what, next.out_time, now(), u.id
  );
  return { response: publicResponse(saved) };
});

// ---------- admin ----------

route('GET', '/api/admin/users', async (c) => {
  await c.requireAdmin();
  return { users: (await c.activeUsers()).map(adminUserView), settings: await c.settings(), palette: PALETTE };
});

route('POST', '/api/admin/users', async (c, { body }) => {
  await c.requireAdmin();
  const name = cleanName(body.name);
  if (body.pin) checkPin(body.pin, 'member');
  if ((await c.activeUsers()).length >= 20) throw new HttpError(400, 'There is a limit of 20 people.');
  const sort = (await c.first('SELECT COALESCE(MAX(sort_order), 0) AS m FROM users')).m + 1;
  const user = await c.first(
    'INSERT INTO users (name, role, pin_hash, color, on_dinner_list, sort_order, created_at) VALUES (?, ?, ?, ?, 1, ?, ?) RETURNING *',
    name, 'member', body.pin ? await hashPin(body.pin) : null, await c.nextColor(), sort, now()
  );
  return { user: adminUserView(user) };
});

route('PATCH', '/api/admin/users/:id', async (c, { params, body }) => {
  await c.requireAdmin();
  const target = await c.userById(params.id);
  if (!target) throw new HttpError(404, 'That person was not found.');
  const next = { name: target.name, color: target.color, on_dinner_list: target.on_dinner_list };
  if ('name' in body) next.name = cleanName(body.name);
  if ('color' in body) {
    if (!PALETTE.includes(body.color)) throw new HttpError(400, 'Pick one of the listed colours.');
    next.color = body.color;
  }
  if ('onDinnerList' in body) next.on_dinner_list = body.onDinnerList ? 1 : 0;
  const user = await c.first(
    'UPDATE users SET name = ?, color = ?, on_dinner_list = ? WHERE id = ? RETURNING *',
    next.name, next.color, next.on_dinner_list, target.id
  );
  return { user: adminUserView(user) };
});

route('POST', '/api/admin/users/:id/pin', async (c, { params, body }) => {
  const admin = await c.requireAdmin();
  const target = await c.userById(params.id);
  if (!target) throw new HttpError(404, 'That person was not found.');
  checkPin(body.pin, target.role);
  // Changing a PIN signs that person out everywhere else.
  const [{ results }] = await c.db.batch([
    c.db.prepare('UPDATE users SET pin_hash = ?, failed_logins = 0, locked_until = 0 WHERE id = ? RETURNING *').bind(await hashPin(body.pin), target.id),
    c.db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash <> ?').bind(target.id, target.id === admin.id ? admin.tokenHash : ''),
  ]);
  return { user: adminUserView(results[0]) };
});

route('DELETE', '/api/admin/users/:id', async (c, { params }) => {
  const admin = await c.requireAdmin();
  const target = await c.userById(params.id);
  if (!target) throw new HttpError(404, 'That person was not found.');
  if (target.id === admin.id) throw new HttpError(400, "You can't remove yourself.");
  await c.db.batch([
    c.db.prepare('UPDATE users SET active = 0, pin_hash = NULL WHERE id = ?').bind(target.id),
    c.db.prepare('DELETE FROM sessions WHERE user_id = ?').bind(target.id),
  ]);
  return { ok: true };
});

route('PUT', '/api/admin/settings', async (c, { body }) => {
  await c.requireAdmin();
  const upsert = 'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value';
  if ('householdName' in body) {
    const n = typeof body.householdName === 'string' ? body.householdName.trim() : '';
    if (!n || n.length > 40) throw new HttpError(400, 'The household name needs to be 1 to 40 characters.');
    await c.run(upsert, 'household_name', n);
  }
  if ('everyoneCanEdit' in body) await c.run(upsert, 'everyone_can_edit', body.everyoneCanEdit ? '1' : '0');
  return { settings: await c.settings() };
});

// ---------- entry point ----------

function json(status, data, cookies = []) {
  const headers = new Headers({
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'same-origin',
  });
  for (const cookie of cookies) headers.append('Set-Cookie', cookie);
  return new Response(JSON.stringify(data), { status, headers });
}

async function handleApi(request, env) {
  const c = new Ctx(request, env);
  try {
    if (request.method !== 'GET') {
      // CSRF protection: state-changing requests must come from this site, as JSON.
      const origin = request.headers.get('Origin');
      if (origin) {
        let host;
        try {
          host = new URL(origin).host;
        } catch {}
        if (host !== c.url.host) throw new HttpError(403, 'Cross-site request blocked.');
      }
      const type = request.headers.get('Content-Type') || '';
      if (request.method !== 'DELETE' && !type.startsWith('application/json')) throw new HttpError(415, 'Send JSON.');
    }
    for (const r of routes) {
      if (r.method !== request.method) continue;
      const m = c.url.pathname.match(r.re);
      if (!m) continue;
      const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
      const body = request.method === 'GET' ? {} : await readBody(request);
      const result = await r.handler(c, { params, body });
      return json(200, result, c.cookies);
    }
    throw new HttpError(404, 'Not found.');
  } catch (err) {
    if (err instanceof HttpError) return json(err.status, { error: err.message }, c.cookies);
    console.error(err);
    return json(500, { error: 'Something went wrong on the server. Try again.' });
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) return handleApi(request, env);
    return env.ASSETS.fetch(request);
  },
};
