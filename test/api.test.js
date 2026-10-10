'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

// Run with `npm test`, which starts wrangler dev and sets BASE_URL.
const base = process.env.BASE_URL;
if (!base) throw new Error('Run the tests with npm test.');

function client() {
  let cookie = '';
  return async (method, url, body, extraHeaders = {}) => {
    const res = await fetch(base + url, {
      method,
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...extraHeaders },
      body: body ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    return { status: res.status, data: await res.json().catch(() => null) };
  };
}

const lincoln = client();
const emma = client();
const grant = client();
const stranger = client();
let ids = {};

test('setup requires the code and a long admin PIN', async () => {
  let r = await stranger('GET', '/api/bootstrap');
  assert.equal(r.data.needsSetup, true);

  r = await stranger('POST', '/api/setup', { code: '000000', pin: '123456', family: [] });
  assert.equal(r.status, 403);

  r = await lincoln('POST', '/api/setup', { code: '424242', name: 'Lincoln', pin: '1234', family: ['Grant'] });
  assert.equal(r.status, 400);

  r = await lincoln('POST', '/api/setup', { code: '424242', name: 'Lincoln', pin: '135790', family: ['Grant', 'Emma', 'Elijah'] });
  assert.equal(r.status, 200);

  r = await stranger('POST', '/api/setup', { code: '424242', pin: '135790', family: [] });
  assert.equal(r.status, 409);

  r = await lincoln('GET', '/api/me');
  assert.equal(r.data.user.role, 'admin');
  assert.equal(r.data.user.onDinnerList, false);

  r = await stranger('GET', '/api/bootstrap');
  assert.equal(r.data.needsSetup, false);
  for (const p of r.data.people) ids[p.name] = p.id;
  assert.deepEqual(Object.keys(ids).sort(), ['Elijah', 'Emma', 'Grant', 'Lincoln']);
});

test('admin sets PINs and people sign in', async () => {
  let r = await emma('POST', '/api/login', { userId: ids.Emma, pin: '1111' });
  assert.equal(r.status, 400, 'no PIN yet');

  r = await emma('POST', `/api/admin/users/${ids.Emma}/pin`, { pin: '1111' });
  assert.equal(r.status, 401);

  assert.equal((await lincoln('POST', `/api/admin/users/${ids.Emma}/pin`, { pin: '1111' })).status, 200);
  assert.equal((await lincoln('POST', `/api/admin/users/${ids.Grant}/pin`, { pin: '2222' })).status, 200);

  r = await emma('POST', '/api/login', { userId: ids.Emma, pin: '9999' });
  assert.equal(r.status, 401);
  r = await emma('POST', '/api/login', { userId: ids.Emma, pin: '1111' });
  assert.equal(r.status, 200);
  r = await grant('POST', '/api/login', { userId: ids.Grant, pin: '2222' });
  assert.equal(r.status, 200);

  r = await emma('GET', '/api/admin/users');
  assert.equal(r.status, 403);
});

test('responses save, are shared, and respect permissions', async () => {
  const day = '2026-10-10';
  let r = await emma('PUT', `/api/responses/${ids.Emma}/${day}`, { home: true });
  assert.equal(r.status, 200);
  r = await emma('PUT', `/api/responses/${ids.Emma}/${day}`, { goingOut: true, outWhat: 'Book club', outTime: '19:30' });
  assert.equal(r.data.response.home, true);
  assert.equal(r.data.response.outTime, '19:30');

  r = await emma('PUT', `/api/responses/${ids.Emma}/${day}`, { outTime: '25:00' });
  assert.equal(r.status, 400);
  r = await emma('PUT', `/api/responses/${ids.Emma}/2026-02-30`, { home: true });
  assert.equal(r.status, 400);

  // Grant sees Emma's answer.
  r = await grant('GET', `/api/days?from=2026-10-01&to=2026-10-31`);
  assert.equal(r.status, 200);
  const emmaResp = r.data.responses.find((x) => x.userId === ids.Emma);
  assert.equal(emmaResp.outWhat, 'Book club');
  assert.ok(!r.data.people.some((p) => p.id === ids.Lincoln), 'admin not on dinner list');

  // Grant can't change Emma's plans by default...
  r = await grant('PUT', `/api/responses/${ids.Emma}/${day}`, { home: false });
  assert.equal(r.status, 403);
  // ...but the admin can.
  r = await lincoln('PUT', `/api/responses/${ids.Elijah}/${day}`, { home: false });
  assert.equal(r.status, 200);

  // Turn on shared editing.
  await lincoln('PUT', '/api/admin/settings', { everyoneCanEdit: true });
  r = await grant('PUT', `/api/responses/${ids.Elijah}/${day}`, { home: true });
  assert.equal(r.status, 200);

  r = await emma('GET', '/api/me');
  assert.deepEqual(r.data.suggestions, ['Book club']);

  r = await stranger('GET', `/api/days?from=2026-10-01&to=2026-10-31`);
  assert.equal(r.status, 401);
});

test('cross-site writes are blocked', async () => {
  const r = await emma('PUT', `/api/responses/${ids.Emma}/2026-10-11`, { home: true }, { Origin: 'https://evil.example' });
  assert.equal(r.status, 403);
});

test('wrong PINs lock the account', async () => {
  const c = client();
  for (let i = 0; i < 5; i++) await c('POST', '/api/login', { userId: ids.Grant, pin: '0000' });
  const r = await c('POST', '/api/login', { userId: ids.Grant, pin: '2222' });
  assert.equal(r.status, 429);
  // Admin resetting the PIN unlocks it.
  await lincoln('POST', `/api/admin/users/${ids.Grant}/pin`, { pin: '3333' });
  assert.equal((await c('POST', '/api/login', { userId: ids.Grant, pin: '3333' })).status, 200);
  // Resetting signed Grant out elsewhere.
  assert.equal((await grant('GET', '/api/me')).status, 401);
});

test('admin can add, rename and remove people', async () => {
  let r = await lincoln('POST', '/api/admin/users', { name: 'Nana' });
  assert.equal(r.status, 200);
  const id = r.data.user.id;
  r = await lincoln('PATCH', `/api/admin/users/${id}`, { name: 'Nana Rieger', onDinnerList: false });
  assert.equal(r.data.user.name, 'Nana Rieger');
  r = await lincoln('DELETE', `/api/admin/users/${id}`);
  assert.equal(r.status, 200);
  r = await lincoln('DELETE', `/api/admin/users/${ids.Lincoln}`);
  assert.equal(r.status, 400);
  r = await lincoln('PATCH', `/api/admin/users/${ids.Lincoln}`, { onDinnerList: true });
  assert.equal(r.data.user.onDinnerList, true);
});

test('logout ends the session', async () => {
  await emma('POST', '/api/logout', {});
  assert.equal((await emma('GET', '/api/me')).status, 401);
});
