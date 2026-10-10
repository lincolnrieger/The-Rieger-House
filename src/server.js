'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { open, nextColor, PALETTE } = require('./db');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const SESSION_DAYS = 180;
const MAX_BODY = 16 * 1024;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const PIN_RE = /^\d{4,8}$/;
const ADMIN_MIN_PIN = 6;

// ---------- helpers ----------

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const now = () => Date.now();
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

function hashPin(pin) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pin, salt, 32, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

function verifyPin(pin, stored) {
  if (!stored) return false;
  const [scheme, saltHex, hashHex] = stored.split('$');
  if (scheme !== 'scrypt') return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(pin, Buffer.from(saltHex, 'hex'), expected.length, { N: 16384, r: 8, p: 1 });
  return crypto.timingSafeEqual(expected, actual);
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

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new HttpError(413, 'Request too large.'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        resolve(body && typeof body === 'object' && !Array.isArray(body) ? body : {});
      } catch {
        reject(new HttpError(400, 'Invalid JSON.'));
      }
    });
    req.on('error', reject);
  });
}

function send(res, status, data, headers = {}) {
  const body = data === undefined ? '' : JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(body);
}

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
  'X-Frame-Options': 'DENY',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Content-Security-Policy': [
    "default-src 'self'",
    "style-src 'self' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data:",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'self'",
  ].join('; '),
};

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

// ---------- app ----------

function createApp({ dataDir = process.env.DATA_DIR || path.join(__dirname, '..', 'data'), setupCode = process.env.SETUP_CODE, trustProxy = process.env.TRUST_PROXY === '1', log = console.log } = {}) {
  const db = open(dataDir);

  const q = {
    adminCount: db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND active = 1"),
    userById: db.prepare('SELECT * FROM users WHERE id = ? AND active = 1'),
    activeUsers: db.prepare('SELECT * FROM users WHERE active = 1 ORDER BY sort_order, id'),
    insertUser: db.prepare(
      'INSERT INTO users (name, role, pin_hash, color, on_dinner_list, sort_order, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ),
    maxSort: db.prepare('SELECT COALESCE(MAX(sort_order), 0) AS m FROM users'),
    setting: db.prepare('SELECT value FROM settings WHERE key = ?'),
    putSetting: db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'),
    session: db.prepare(
      'SELECT u.* , s.expires_at AS s_expires FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ? AND u.active = 1'
    ),
    insertSession: db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)'),
    touchSession: db.prepare('UPDATE sessions SET expires_at = ? WHERE token_hash = ?'),
    deleteSession: db.prepare('DELETE FROM sessions WHERE token_hash = ?'),
    deleteUserSessions: db.prepare('DELETE FROM sessions WHERE user_id = ?'),
    deleteOtherSessions: db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash <> ?'),
    purgeSessions: db.prepare('DELETE FROM sessions WHERE expires_at <= ?'),
    loginFail: db.prepare('UPDATE users SET failed_logins = ?, locked_until = ? WHERE id = ?'),
    responsesBetween: db.prepare(
      'SELECT r.* FROM responses r JOIN users u ON u.id = r.user_id WHERE u.active = 1 AND r.date BETWEEN ? AND ?'
    ),
    response: db.prepare('SELECT * FROM responses WHERE user_id = ? AND date = ?'),
    upsertResponse: db.prepare(`
      INSERT INTO responses (user_id, date, home, going_out, out_what, out_time, updated_at, updated_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id, date) DO UPDATE SET
        home = excluded.home, going_out = excluded.going_out, out_what = excluded.out_what,
        out_time = excluded.out_time, updated_at = excluded.updated_at, updated_by = excluded.updated_by
    `),
    suggestions: db.prepare(`
      SELECT out_what, MAX(updated_at) AS last FROM responses
      WHERE user_id = ? AND going_out = 1 AND out_what <> ''
      GROUP BY out_what COLLATE NOCASE ORDER BY last DESC LIMIT 5
    `),
  };

  const getSetting = (key, fallback) => {
    const row = q.setting.get(key);
    return row ? row.value : fallback;
  };
  const settings = () => ({
    householdName: getSetting('household_name', 'The Rieger House'),
    everyoneCanEdit: getSetting('everyone_can_edit', '0') === '1',
  });

  let currentSetupCode = null;
  const needsSetup = () => q.adminCount.get().n === 0;
  if (needsSetup()) {
    currentSetupCode = setupCode || crypto.randomInt(0, 1e6).toString().padStart(6, '0');
    if (!setupCode) log(`\n  First-time setup code: ${currentSetupCode}\n  Open the app and enter this code to create the admin account.\n`);
  }

  // Simple in-memory per-IP throttle for PIN attempts.
  const attempts = new Map();
  function throttle(ip) {
    const t = now();
    const entry = attempts.get(ip) || { count: 0, reset: t + 15 * 60_000 };
    if (t > entry.reset) Object.assign(entry, { count: 0, reset: t + 15 * 60_000 });
    entry.count += 1;
    attempts.set(ip, entry);
    if (entry.count > 30) throw new HttpError(429, 'Too many attempts. Try again in a few minutes.');
  }

  const publicUser = (u) => ({
    id: u.id,
    name: u.name,
    role: u.role,
    color: u.color,
    onDinnerList: !!u.on_dinner_list,
  });

  const publicResponse = (r) => ({
    userId: r.user_id,
    date: r.date,
    home: r.home === null ? null : !!r.home,
    goingOut: !!r.going_out,
    outWhat: r.out_what,
    outTime: r.out_time,
    updatedAt: r.updated_at,
  });

  function clientIp(req) {
    if (trustProxy) {
      const fwd = req.headers['x-forwarded-for'];
      if (fwd) return fwd.split(',')[0].trim();
    }
    return req.socket.remoteAddress || 'unknown';
  }

  function isHttps(req) {
    return req.socket.encrypted || (trustProxy && req.headers['x-forwarded-proto'] === 'https');
  }

  function startSession(req, res, userId) {
    const token = crypto.randomBytes(32).toString('base64url');
    const expires = now() + SESSION_DAYS * 86_400_000;
    q.purgeSessions.run(now());
    q.insertSession.run(sha256(token), userId, expires);
    setSessionCookie(req, res, token, SESSION_DAYS * 86_400);
  }

  function setSessionCookie(req, res, value, maxAge) {
    const parts = [`rh_session=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAge}`];
    if (isHttps(req)) parts.push('Secure');
    res.setHeader('Set-Cookie', parts.join('; '));
  }

  function currentUser(req) {
    const token = parseCookies(req.headers.cookie).rh_session;
    if (!token) return null;
    const hash = sha256(token);
    const row = q.session.get(hash, now());
    if (!row) return null;
    // Slide the expiry forward at most once a day.
    const fresh = now() + SESSION_DAYS * 86_400_000;
    if (fresh - row.s_expires > 86_400_000) q.touchSession.run(fresh, hash);
    row.tokenHash = hash;
    return row;
  }

  function requireUser(req) {
    const u = currentUser(req);
    if (!u) throw new HttpError(401, 'Please sign in.');
    return u;
  }

  function requireAdmin(req) {
    const u = requireUser(req);
    if (u.role !== 'admin') throw new HttpError(403, 'Only the admin can do that.');
    return u;
  }

  function canEdit(user, targetId) {
    return user.id === targetId || user.role === 'admin' || settings().everyoneCanEdit;
  }

  function addUser(name, { role = 'member', pin = null, onDinnerList = true } = {}) {
    const sort = q.maxSort.get().m + 1;
    const info = q.insertUser.run(name, role, pin ? hashPin(pin) : null, nextColor(db), onDinnerList ? 1 : 0, sort, now());
    return Number(info.lastInsertRowid);
  }

  function adminUserView(u) {
    return { ...publicUser(u), hasPin: !!u.pin_hash, locked: u.locked_until > now() };
  }

  // ---------- routes ----------

  const routes = [];
  const route = (method, pattern, handler) => {
    const keys = [];
    const re = new RegExp(`^${pattern.replace(/:(\w+)/g, (_, k) => (keys.push(k), '([^/]+)'))}$`);
    routes.push({ method, re, keys, handler });
  };

  route('GET', '/api/bootstrap', () => ({
    needsSetup: needsSetup(),
    householdName: settings().householdName,
    people: q.activeUsers.all().map((u) => ({ id: u.id, name: u.name, color: u.color, hasPin: !!u.pin_hash })),
  }));

  route('POST', '/api/setup', ({ req, res, body }) => {
    if (!needsSetup()) throw new HttpError(409, 'Setup has already been done.');
    throttle(clientIp(req));
    const code = String(body.code || '').trim();
    if (!currentSetupCode || code.length !== currentSetupCode.length || !crypto.timingSafeEqual(Buffer.from(code), Buffer.from(currentSetupCode))) {
      throw new HttpError(403, 'That setup code is not right. Check the server log for the code.');
    }
    const name = cleanName(body.name || 'Lincoln');
    checkPin(body.pin, 'admin');
    const family = Array.isArray(body.family) ? body.family : [];
    if (family.length > 12) throw new HttpError(400, 'That is a lot of people. Add the rest from the admin page.');
    const familyNames = family.map(cleanName);

    let adminId;
    db.exec('BEGIN');
    try {
      for (const n of familyNames) addUser(n);
      adminId = addUser(name, { role: 'admin', pin: body.pin, onDinnerList: !!body.adminOnDinnerList });
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    currentSetupCode = null;
    startSession(req, res, adminId);
    return { ok: true };
  });

  route('POST', '/api/login', ({ req, res, body }) => {
    throttle(clientIp(req));
    const user = q.userById.get(Number(body.userId));
    if (!user) throw new HttpError(400, 'Choose your name.');
    if (!user.pin_hash) throw new HttpError(400, `${user.name} doesn't have a PIN yet. Ask the admin to set one.`);
    if (user.locked_until > now()) {
      const mins = Math.ceil((user.locked_until - now()) / 60_000);
      throw new HttpError(429, `Too many wrong PINs. Try again in ${mins} minute${mins === 1 ? '' : 's'}.`);
    }
    if (typeof body.pin !== 'string' || !verifyPin(body.pin, user.pin_hash)) {
      const fails = user.failed_logins + 1;
      const lock = fails >= 5 ? now() + Math.min(60, 5 * 2 ** (fails - 5)) * 60_000 : 0;
      q.loginFail.run(fails, lock, user.id);
      throw new HttpError(401, 'That PIN is not right.');
    }
    q.loginFail.run(0, 0, user.id);
    startSession(req, res, user.id);
    return { ok: true };
  });

  route('POST', '/api/logout', ({ req, res }) => {
    const token = parseCookies(req.headers.cookie).rh_session;
    if (token) q.deleteSession.run(sha256(token));
    setSessionCookie(req, res, '', 0);
    return { ok: true };
  });

  route('GET', '/api/me', ({ req }) => {
    const u = requireUser(req);
    return {
      user: publicUser(u),
      settings: settings(),
      suggestions: q.suggestions.all(u.id).map((r) => r.out_what),
    };
  });

  route('POST', '/api/me/pin', ({ req, body }) => {
    const u = requireUser(req);
    throttle(clientIp(req));
    if (typeof body.currentPin !== 'string' || !verifyPin(body.currentPin, u.pin_hash)) {
      throw new HttpError(400, 'Your current PIN is not right.');
    }
    checkPin(body.newPin, u.role);
    db.prepare('UPDATE users SET pin_hash = ? WHERE id = ?').run(hashPin(body.newPin), u.id);
    q.deleteOtherSessions.run(u.id, u.tokenHash);
    return { ok: true };
  });

  route('GET', '/api/days', ({ req, url }) => {
    requireUser(req);
    const from = url.searchParams.get('from');
    const to = url.searchParams.get('to');
    if (!validDate(from) || !validDate(to) || from > to) throw new HttpError(400, 'Invalid date range.');
    if ((Date.parse(to) - Date.parse(from)) / 86_400_000 > 62) throw new HttpError(400, 'Date range is too long.');
    const people = q.activeUsers.all().filter((u) => u.on_dinner_list);
    const ids = new Set(people.map((u) => u.id));
    return {
      people: people.map(publicUser),
      responses: q.responsesBetween.all(from, to).filter((r) => ids.has(r.user_id)).map(publicResponse),
    };
  });

  route('PUT', '/api/responses/:userId/:date', ({ req, params, body }) => {
    const u = requireUser(req);
    const targetId = Number(params.userId);
    const date = params.date;
    if (!validDate(date)) throw new HttpError(400, 'Invalid date.');
    const target = q.userById.get(targetId);
    if (!target) throw new HttpError(404, 'That person was not found.');
    if (!canEdit(u, targetId)) throw new HttpError(403, `Only ${target.name} or the admin can change ${target.name}'s plans.`);

    const existing = q.response.get(targetId, date);
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

    q.upsertResponse.run(targetId, date, next.home, next.going_out, next.out_what, next.out_time, now(), u.id);
    return { response: publicResponse(q.response.get(targetId, date)) };
  });

  // ---------- admin ----------

  route('GET', '/api/admin/users', ({ req }) => {
    requireAdmin(req);
    return { users: q.activeUsers.all().map(adminUserView), settings: settings(), palette: PALETTE };
  });

  route('POST', '/api/admin/users', ({ req, body }) => {
    requireAdmin(req);
    const name = cleanName(body.name);
    if (body.pin) checkPin(body.pin, 'member');
    if (q.activeUsers.all().length >= 20) throw new HttpError(400, 'There is a limit of 20 people.');
    const id = addUser(name, { pin: body.pin || null });
    return { user: adminUserView(q.userById.get(id)) };
  });

  route('PATCH', '/api/admin/users/:id', ({ req, params, body }) => {
    requireAdmin(req);
    const target = q.userById.get(Number(params.id));
    if (!target) throw new HttpError(404, 'That person was not found.');
    const next = { name: target.name, color: target.color, on_dinner_list: target.on_dinner_list, role: target.role };
    if ('name' in body) next.name = cleanName(body.name);
    if ('color' in body) {
      if (!PALETTE.includes(body.color)) throw new HttpError(400, 'Pick one of the listed colours.');
      next.color = body.color;
    }
    if ('onDinnerList' in body) next.on_dinner_list = body.onDinnerList ? 1 : 0;
    db.prepare('UPDATE users SET name = ?, color = ?, on_dinner_list = ?, role = ? WHERE id = ?').run(
      next.name, next.color, next.on_dinner_list, next.role, target.id
    );
    return { user: adminUserView(q.userById.get(target.id)) };
  });

  route('POST', '/api/admin/users/:id/pin', ({ req, params, body }) => {
    requireAdmin(req);
    const target = q.userById.get(Number(params.id));
    if (!target) throw new HttpError(404, 'That person was not found.');
    checkPin(body.pin, target.role);
    db.prepare('UPDATE users SET pin_hash = ?, failed_logins = 0, locked_until = 0 WHERE id = ?').run(hashPin(body.pin), target.id);
    const self = currentUser(req);
    if (target.id === self.id) q.deleteOtherSessions.run(target.id, self.tokenHash);
    else q.deleteUserSessions.run(target.id);
    return { user: adminUserView(q.userById.get(target.id)) };
  });

  route('DELETE', '/api/admin/users/:id', ({ req, params }) => {
    const admin = requireAdmin(req);
    const target = q.userById.get(Number(params.id));
    if (!target) throw new HttpError(404, 'That person was not found.');
    if (target.id === admin.id) throw new HttpError(400, "You can't remove yourself.");
    db.prepare('UPDATE users SET active = 0, pin_hash = NULL WHERE id = ?').run(target.id);
    q.deleteUserSessions.run(target.id);
    return { ok: true };
  });

  route('PUT', '/api/admin/settings', ({ req, body }) => {
    requireAdmin(req);
    if ('householdName' in body) {
      const n = typeof body.householdName === 'string' ? body.householdName.trim() : '';
      if (!n || n.length > 40) throw new HttpError(400, 'The household name needs to be 1 to 40 characters.');
      q.putSetting.run('household_name', n);
    }
    if ('everyoneCanEdit' in body) q.putSetting.run('everyone_can_edit', body.everyoneCanEdit ? '1' : '0');
    return { settings: settings() };
  });

  // ---------- static ----------

  function serveStatic(req, res, pathname) {
    let rel = pathname === '/' ? '/index.html' : pathname;
    let file = path.normalize(path.join(PUBLIC_DIR, decodeURIComponent(rel)));
    if (!file.startsWith(PUBLIC_DIR + path.sep)) {
      res.writeHead(400).end();
      return;
    }
    let stat;
    try {
      stat = fs.statSync(file);
    } catch {
      // Unknown non-file paths fall back to the app shell.
      if (path.extname(rel)) {
        res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
        return;
      }
      file = path.join(PUBLIC_DIR, 'index.html');
      stat = fs.statSync(file);
    }
    const etag = `"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
    const headers = {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
      ETag: etag,
    };
    if (path.basename(file) === 'sw.js') headers['Service-Worker-Allowed'] = '/';
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, headers).end();
      return;
    }
    res.writeHead(200, headers);
    if (req.method === 'HEAD') res.end();
    else fs.createReadStream(file).pipe(res);
  }

  async function handler(req, res) {
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
    if (isHttps(req)) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    const url = new URL(req.url, 'http://localhost');
    try {
      if (!url.pathname.startsWith('/api/')) {
        if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Method not allowed.');
        return serveStatic(req, res, url.pathname);
      }

      if (req.method !== 'GET') {
        // CSRF protection: state-changing requests must come from this site, as JSON.
        const origin = req.headers.origin;
        if (origin) {
          let host;
          try {
            host = new URL(origin).host;
          } catch {}
          if (host !== req.headers.host) throw new HttpError(403, 'Cross-site request blocked.');
        }
        const type = req.headers['content-type'] || '';
        if (req.method !== 'DELETE' && !type.startsWith('application/json')) throw new HttpError(415, 'Send JSON.');
      }

      for (const r of routes) {
        if (r.method !== req.method) continue;
        const m = url.pathname.match(r.re);
        if (!m) continue;
        const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
        const body = req.method === 'GET' ? {} : await readBody(req);
        const result = await r.handler({ req, res, url, params, body });
        return send(res, 200, result);
      }
      throw new HttpError(404, 'Not found.');
    } catch (err) {
      if (err instanceof HttpError) return send(res, err.status, { error: err.message });
      log(err);
      return send(res, 500, { error: 'Something went wrong on the server. Try again.' });
    }
  }

  return { handler, db, getSetupCode: () => currentSetupCode };
}

if (require.main === module) {
  const app = createApp();
  const port = Number(process.env.PORT) || 3000;
  const host = process.env.HOST || '0.0.0.0';
  http.createServer(app.handler).listen(port, host, () => {
    console.log(`The Rieger House is running at http://localhost:${port}`);
  });
}

module.exports = { createApp, hashPin };
