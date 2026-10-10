import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../apps/server/src/app.js';
import { Store } from '../apps/server/src/store.js';
import { Service } from '../apps/server/src/service.js';
import { digest, hashPassword } from '../apps/server/src/auth.js';

const secret = 'native-review-fixture-secret';
type App = Awaited<ReturnType<typeof createApp>>;
type Login = { cookie: string; csrf: string; hash: string };
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'desk-review-login-'));
  const store = new Store(directory), service = new Service(store);
  const password = await hashPassword('test-password');
  for (const [id, role] of [['admin', 'admin'], ['second', 'admin'], ['customer', 'client']]) {
    store.db.prepare('INSERT INTO users VALUES(?,?,?,?,1,?)').run(id, id, password, role, new Date().toISOString());
  }
  const admin = await createApp(store, service, 'admin', secret);
  const client = await createApp(store, service, 'client');
  async function login(app: App, username: string): Promise<Login> {
    const meta = await app.inject({ url: '/api/meta', headers: { host: '127.0.0.1' } });
    const csrfCookie = String(meta.headers['set-cookie']).split(';')[0];
    const result = await app.inject({ method: 'POST', url: '/api/login', payload: { username, password: 'test-password' }, headers: { host: '127.0.0.1', cookie: csrfCookie, 'x-csrf-token': meta.json().csrfToken } });
    assert.equal(result.statusCode, 200, result.body);
    const cookie = String(result.headers['set-cookie']).split(';')[0];
    return { cookie, csrf: result.json().csrfToken, hash: digest(cookie.split('=')[1]) };
  }
  const call = (app: App, url: string, cookie = '', csrf?: string, payload?: object) => app.inject({ method: payload ? 'POST' : 'GET', url, headers: { host: '127.0.0.1', cookie, ...(csrf ? { 'x-csrf-token': csrf } : {}) }, ...(payload ? { payload } : {}) });
  const issue = (app = admin, supplied: string | undefined = secret, cookie = '', origin?: string) => app.inject({ method: 'POST', url: '/api/launcher/review-login', headers: { host: '127.0.0.1', cookie, ...(supplied ? { 'x-launcher-token': supplied } : {}), ...(origin ? { origin } : {}) } });
  const close = async () => { await admin.close(); await client.close(); await service.stop(); store.close(); await rm(directory, { recursive: true, force: true }); };
  return { directory, store, service, admin, client, login, call, issue, close };
}

test('native review reuses a logged-in admin identity and CSRF without a second login', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.issue()).statusCode, 401, 'launcher alone must not log in');
    const customer = await f.login(f.client, 'customer');
    assert.equal((await f.issue()).statusCode, 401, 'client login is not an admin login');
    const browser = await f.login(f.admin, 'admin');
    for (const supplied of ['', 'wrong-secret']) assert.equal((await f.issue(f.admin, supplied, browser.cookie)).statusCode, 401);
    assert.equal((await f.issue(f.admin, secret, '', 'http://127.0.0.1:4310')).statusCode, 403);
    assert.equal((await f.issue(f.client, secret, customer.cookie)).statusCode, 404);
    const issued = await f.issue(); assert.equal(issued.statusCode, 200, issued.body);
    assert.equal(issued.headers['cache-control'], 'no-store');
    const login = issued.json(); const cookie = `desk_admin=${login.sessionToken}`;
    assert.notEqual(cookie, browser.cookie);
    assert.equal(login.expires, (f.store.db.prepare('SELECT expires FROM sessions WHERE token=?').get(browser.hash) as any).expires);
    assert.equal((f.store.db.prepare('SELECT COUNT(*) n FROM sessions').get() as any).n, 2, 'sharing must not create an independent login');
    const me = await f.call(f.admin, '/api/me', cookie);
    assert.equal(me.statusCode, 200); assert.equal(me.json().user.username, 'admin'); assert.equal(me.json().csrfToken, browser.csrf);
    assert.equal((await f.call(f.client, '/api/me', `desk_client=${login.sessionToken}`)).statusCode, 401);
    assert.equal((await f.admin.inject({ url: '/api/me', headers: { host: '127.0.0.1', 'x-launcher-token': secret } })).statusCode, 401);

    f.store.db.prepare('INSERT INTO projects(id,name,path) VALUES(?,?,?)').run('project', 'business', f.directory);
    f.store.db.prepare('INSERT INTO conversations(id,user_id,project_id,created_at) VALUES(?,?,?,?)').run('conversation', 'customer', 'project', new Date().toISOString());
    f.store.db.prepare("INSERT INTO questions(id,user_id,project_id,question,status,draft_answer,created_at,updated_at,conversation_id) VALUES(?,?,?,?,'pending_answer_review',?,?,?,?)").run('question', 'customer', 'project', '业务问题', '待审草稿', new Date().toISOString(), new Date().toISOString(), 'conversation');
    assert.equal((await f.call(f.admin, '/api/questions/question', cookie)).json().draftAnswer, '待审草稿');
    const url = '/api/questions/question/publish', payload = { answer: '已审核的业务答复' };
    assert.equal((await f.call(f.admin, url, cookie, undefined, payload)).statusCode, 403);
    assert.equal((await f.call(f.admin, url, cookie, 'wrong-csrf', payload)).statusCode, 403);
    assert.equal((await f.call(f.admin, url, cookie, me.json().csrfToken, payload)).statusCode, 200);
    assert.equal((f.store.db.prepare('SELECT actor FROM audit WHERE action=?').get('publish') as any).actor, 'admin');
  } finally { await f.close(); }
});

test('shared review credentials expire and revoke with their original admin login', async t => {
  for (const reason of ['browser logout', 'review logout', 'expiry', 'disabled account', 'changed role']) await t.test(reason, async () => {
    const f = await fixture();
    try {
      const browser = await f.login(f.admin, 'admin');
      const issued = (await f.issue()).json(), cookie = `desk_admin=${issued.sessionToken}`;
      if (reason === 'browser logout') assert.equal((await f.call(f.admin, '/api/logout', browser.cookie, browser.csrf, {})).statusCode, 200);
      if (reason === 'review logout') assert.equal((await f.call(f.admin, '/api/logout', cookie, browser.csrf, {})).statusCode, 200);
      if (reason === 'expiry') f.store.db.prepare('UPDATE sessions SET expires=? WHERE token=?').run(Date.now() - 1, browser.hash);
      if (reason === 'disabled account') f.store.db.prepare('UPDATE users SET enabled=0 WHERE id=?').run('admin');
      if (reason === 'changed role') f.store.db.prepare("UPDATE users SET role='client' WHERE id=?").run('admin');
      assert.equal((await f.call(f.admin, '/api/me', cookie)).statusCode, 401);
      assert.equal((await f.call(f.admin, '/api/logout', cookie, browser.csrf, {})).statusCode, 403);
      assert.equal((await f.call(f.admin, '/api/me', browser.cookie)).statusCode, 401);
      assert.equal((await f.issue()).statusCode, 401, 'native host must not restore revoked login');
    } finally { await f.close(); }
  });
});

test('review adopts the most recent valid admin, excluding newer client logins', async () => {
  const f = await fixture();
  try {
    const first = await f.login(f.admin, 'admin');
    f.store.db.prepare('UPDATE sessions SET expires=? WHERE token=?').run(Date.now() + 60_000, first.hash);
    const second = await f.login(f.admin, 'second'); await f.login(f.client, 'customer');
    const cookie = `desk_admin=${(await f.issue()).json().sessionToken}`;
    assert.equal((await f.call(f.admin, '/api/me', cookie)).json().user.username, 'second');
    await f.call(f.admin, '/api/logout', first.cookie, first.csrf, {});
    assert.equal((await f.call(f.admin, '/api/me', cookie)).statusCode, 200);
    await f.call(f.admin, '/api/logout', second.cookie, second.csrf, {});
    assert.equal((await f.call(f.admin, '/api/me', cookie)).statusCode, 401);
  } finally { await f.close(); }
});

test('restarting the backend requires native resynchronization rather than persisting extra sessions', async () => {
  const f = await fixture(); let restarted: App | undefined;
  try {
    const browser = await f.login(f.admin, 'admin'), issued = (await f.issue()).json();
    await f.admin.close(); restarted = await createApp(f.store, f.service, 'admin', secret);
    assert.equal((await f.call(restarted, '/api/me', `desk_admin=${issued.sessionToken}`)).statusCode, 401);
    assert.equal((await f.call(restarted, '/api/me', browser.cookie)).statusCode, 200);
    const synced = await f.issue(restarted); assert.equal(synced.statusCode, 200);
    assert.equal((await f.call(restarted, '/api/me', `desk_admin=${synced.json().sessionToken}`)).statusCode, 200);
    assert.equal((f.store.db.prepare('SELECT COUNT(*) n FROM sessions').get() as any).n, 1);
  } finally { await restarted?.close(); await f.close(); }
});

test('review live updates use the inherited login and end when it is revoked', async () => {
  const f = await fixture(); const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), 10_000);
  try {
    const browser = await f.login(f.admin, 'admin');
    const cookie = `desk_admin=${(await f.issue()).json().sessionToken}`;
    await f.admin.listen({ host: '127.0.0.1', port: 0 });
    const address = f.admin.server.address(); assert.ok(address && typeof address !== 'string');
    const response = await fetch(`http://127.0.0.1:${address.port}/api/events`, { headers: { cookie }, signal: controller.signal });
    assert.equal(response.status, 200);
    const reader = response.body!.getReader(); const first = await reader.read();
    assert.match(new TextDecoder().decode(first.value), /refresh/);
    await f.call(f.admin, '/api/logout', browser.cookie, browser.csrf, {});
    f.service.notify();
    assert.equal((await reader.read()).done, true, 'revoked parent must end review stream');
  } finally { clearTimeout(deadline); controller.abort(); await f.close(); }
});

function responseCookies(response: { headers: Record<string, unknown> }) {
  const values = response.headers['set-cookie'];
  return (Array.isArray(values) ? values : values ? [values] : []).map(value => String(value).split(';')[0]).join('; ');
}

test('local password-free access defaults off and only an authenticated admin can enable it', async () => {
  const f = await fixture();
  try {
    assert.equal(f.store.settings().adminAutoLogin, false);
    assert.equal((await f.call(f.admin, '/api/me')).statusCode, 401);
    const initial = await f.call(f.admin, '/api/meta');
    assert.equal(initial.json().adminAutoLogin, false);
    assert.ok(!responseCookies(initial).includes('desk_admin='));
    assert.equal((await f.call(f.admin, '/api/settings/admin-auto-login', responseCookies(initial), initial.json().csrfToken, { enabled: true })).statusCode, 401);
    const customer = await f.login(f.client, 'customer');
    assert.equal((await f.call(f.client, '/api/settings/admin-auto-login', customer.cookie, customer.csrf, { enabled: true })).statusCode, 404);
    const browser = await f.login(f.admin, 'admin');
    assert.equal((await f.call(f.admin, '/api/settings/admin-auto-login', browser.cookie, 'wrong', { enabled: true })).statusCode, 403);
    for (const enabled of ['true', 1, null]) assert.equal((await f.call(f.admin, '/api/settings/admin-auto-login', browser.cookie, browser.csrf, { enabled })).statusCode, 400);
    assert.equal((await f.call(f.admin, '/api/settings/admin-auto-login', browser.cookie, browser.csrf, { enabled: true, userId: 'second' })).statusCode, 400);
    assert.equal((await f.call(f.admin, '/api/settings/admin-auto-login', browser.cookie, browser.csrf, { enabled: true })).statusCode, 200);
    assert.equal(f.store.settings().adminAutoLoginUserId, 'admin');
    const settings = (await f.call(f.admin, '/api/settings', browser.cookie)).json();
    assert.equal(settings.adminAutoLogin, true); assert.ok(!('adminAutoLoginUserId' in settings));
    assert.equal((await f.call(f.admin, '/api/settings', browser.cookie, browser.csrf, { ...settings, adminAutoLogin: false, adminAutoLoginUserId: 'customer' })).statusCode, 200);
    assert.equal(f.store.settings().adminAutoLogin, true, 'saving other settings must preserve the immediate toggle');
    assert.equal(f.store.settings().adminAutoLoginUserId, 'admin');
  } finally { await f.close(); }
});

test('saved local preference opens browser and native review without any prior login and keeps CSRF and client isolation', async () => {
  const f = await fixture();
  try {
    const browser = await f.login(f.admin, 'admin');
    await f.call(f.admin, '/api/settings/admin-auto-login', browser.cookie, browser.csrf, { enabled: true });
    f.store.db.prepare('DELETE FROM sessions').run();
    const meta = await f.call(f.admin, '/api/meta'), cookie = responseCookies(meta), csrf = meta.json().csrfToken;
    assert.equal(meta.json().adminAutoLogin, true);
    assert.match(String(meta.headers['set-cookie']), /desk_admin=.*HttpOnly.*SameSite=Strict/i);
    const me = await f.call(f.admin, '/api/me', cookie);
    assert.equal(me.statusCode, 200); assert.equal(me.json().user.username, 'admin'); assert.equal(me.json().user.autoLogin, true);
    assert.equal(me.json().csrfToken, csrf);
    assert.equal((f.store.db.prepare('SELECT COUNT(*) n FROM sessions').get() as any).n, 0, 'do not persist an extra or permanent login');
    const project = { name: '免登录审核', path: f.directory };
    assert.equal((await f.call(f.admin, '/api/projects', cookie, 'wrong', project)).statusCode, 403);
    const created = await f.call(f.admin, '/api/projects', cookie, csrf, project); assert.equal(created.statusCode, 200, created.body);
    assert.equal((f.store.db.prepare('SELECT actor FROM audit WHERE action=?').get('create-project') as any).actor, 'admin');
    assert.equal((await f.call(f.client, '/api/me', cookie.replaceAll('desk_admin', 'desk_client'))).statusCode, 401);
    assert.equal((await f.call(f.client, '/api/meta')).json().adminAutoLogin, undefined);
    const review = await f.issue(); assert.equal(review.statusCode, 200, review.body);
    assert.equal((await f.call(f.admin, '/api/me', `desk_admin=${review.json().sessionToken}`)).json().user.username, 'admin');
    assert.equal((await f.issue(f.admin, '')).statusCode, 401);
  } finally { await f.close(); }
});

test('local preference survives backend restart and renews expired automatic cookies without a password', async t => {
  const f = await fixture(); let restartedStore: Store | undefined, restartedService: Service | undefined, restarted: App | undefined;
  try {
    const browser = await f.login(f.admin, 'admin');
    await f.call(f.admin, '/api/settings/admin-auto-login', browser.cookie, browser.csrf, { enabled: true });
    f.store.db.prepare('DELETE FROM sessions').run();
    const originalCookie = responseCookies(await f.call(f.admin, '/api/meta'));
    await f.admin.close();
    restartedStore = new Store(f.directory); restartedService = new Service(restartedStore);
    restarted = await createApp(restartedStore, restartedService, 'admin', secret);
    assert.equal(restartedStore.settings().adminAutoLogin, true);
    assert.equal((await f.call(restarted, '/api/me', originalCookie)).statusCode, 401);
    const renewed = responseCookies(await f.call(restarted, '/api/meta', originalCookie));
    assert.equal((await f.call(restarted, '/api/me', renewed)).statusCode, 200);
    const later = Date.now() + 9 * 3600_000; t.mock.method(Date, 'now', () => later);
    assert.equal((await f.call(restarted, '/api/me', renewed)).statusCode, 401);
    const fresh = await f.call(restarted, '/api/meta', renewed);
    assert.equal(fresh.json().adminAutoLogin, true);
    assert.equal((await f.call(restarted, '/api/me', responseCookies(fresh))).statusCode, 200);
  } finally { await restarted?.close(); await restartedService?.stop(); restartedStore?.close(); await f.close(); }
});

test('turning the option off revokes automatic browser and review cookies immediately', async () => {
  const f = await fixture();
  try {
    const browser = await f.login(f.admin, 'admin');
    await f.call(f.admin, '/api/settings/admin-auto-login', browser.cookie, browser.csrf, { enabled: true });
    f.store.db.prepare('DELETE FROM sessions').run();
    const meta = await f.call(f.admin, '/api/meta'), cookie = responseCookies(meta);
    const reviewCookie = `desk_admin=${(await f.issue()).json().sessionToken}`;
    const off = await f.call(f.admin, '/api/settings/admin-auto-login', cookie, meta.json().csrfToken, { enabled: false });
    assert.equal(off.statusCode, 200); assert.equal(f.store.settings().adminAutoLogin, false); assert.equal(f.store.settings().adminAutoLoginUserId, '');
    for (const existing of [cookie, reviewCookie]) assert.equal((await f.call(f.admin, '/api/me', existing)).statusCode, 401);
    const next = await f.call(f.admin, '/api/meta', cookie);
    assert.equal(next.json().adminAutoLogin, false); assert.ok(!responseCookies(next).includes('desk_admin='));
    assert.equal((await f.issue()).statusCode, 401);
    const normal = await f.login(f.admin, 'admin');
    assert.equal((await f.call(f.admin, '/api/me', normal.cookie)).statusCode, 200);
  } finally { await f.close(); }
});

test('automatic admin access is unavailable to remote addresses, spoofed forwarding or cross-site pages', async () => {
  const f = await fixture();
  try {
    const browser = await f.login(f.admin, 'admin');
    await f.call(f.admin, '/api/settings/admin-auto-login', browser.cookie, browser.csrf, { enabled: true });
    for (const request of [
      { remoteAddress: '192.0.2.10', headers: { host: '127.0.0.1', 'x-forwarded-for': '127.0.0.1' } },
      { remoteAddress: '127.0.0.1', headers: { host: 'evil.example' } },
      { remoteAddress: '127.0.0.1', headers: { host: '127.0.0.1', origin: 'https://evil.example' } },
      { remoteAddress: '127.0.0.1', headers: { host: '127.0.0.1', 'sec-fetch-site': 'cross-site' } }
    ]) {
      const response = await f.admin.inject({ url: '/api/meta', ...request });
      assert.equal(response.statusCode, 403); assert.ok(!response.headers['set-cookie']);
    }
  } finally { await f.close(); }
});

test('disabling or changing the saved administrator revokes all automatic access without selecting another account', async t => {
  for (const mutation of ["UPDATE users SET enabled=0 WHERE id='admin'", "UPDATE users SET role='client' WHERE id='admin'"]) await t.test(mutation, async () => {
    const f = await fixture();
    try {
      const browser = await f.login(f.admin, 'admin');
      await f.call(f.admin, '/api/settings/admin-auto-login', browser.cookie, browser.csrf, { enabled: true });
      f.store.db.prepare('DELETE FROM sessions').run();
      const cookie = responseCookies(await f.call(f.admin, '/api/meta'));
      f.store.db.exec(mutation);
      assert.equal((await f.call(f.admin, '/api/me', cookie)).statusCode, 401);
      assert.equal((await f.call(f.admin, '/api/meta')).json().adminAutoLogin, false);
      assert.equal((await f.issue()).statusCode, 401);
    } finally { await f.close(); }
  });
});

test('automatic review live updates close when password-free access is switched off', async () => {
  const f = await fixture(), controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), 10_000);
  try {
    const browser = await f.login(f.admin, 'admin');
    await f.call(f.admin, '/api/settings/admin-auto-login', browser.cookie, browser.csrf, { enabled: true });
    const meta = await f.call(f.admin, '/api/meta'), cookie = responseCookies(meta);
    await f.admin.listen({ host: '127.0.0.1', port: 0 }); const address = f.admin.server.address(); assert.ok(address && typeof address !== 'string');
    const response = await fetch(`http://127.0.0.1:${address.port}/api/events`, { headers: { cookie }, signal: controller.signal });
    assert.equal(response.status, 200); const reader = response.body!.getReader(); await reader.read();
    assert.equal((await f.call(f.admin, '/api/settings/admin-auto-login', cookie, meta.json().csrfToken, { enabled: false })).statusCode, 200);
    assert.equal((await reader.read()).done, true);
  } finally { clearTimeout(deadline); controller.abort(); await f.close(); }
});
