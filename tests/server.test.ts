import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../apps/server/src/app.js';
import { Store, activeStates } from '../apps/server/src/store.js';
import { Service, type Executor } from '../apps/server/src/service.js';
import { digest } from '../apps/server/src/auth.js';

type App = Awaited<ReturnType<typeof createApp>>;
type Session = { cookie: string; csrf: string };
const password = 'test-password-12345';
const draft = 'PRIVATE DRAFT: internal project details';
const log = 'PRIVATE LOG: internal execution diagnostics';

test('launcher includes new pending identities beyond 100 postponed reviews', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'desk-launcher-test-'));
  const store = new Store(directory); const service = new Service(store);
  const app = await createApp(store, service, 'admin', 'fixture-launcher');
  try {
    const now = new Date().toISOString();
    store.db.prepare('INSERT INTO projects(id,name,path) VALUES(?,?,?)').run('p', 'fixture', directory);
    for (let i = 0; i < 101; i++) {
      const id = String(i);
      store.db.prepare("INSERT INTO users(id,username,password,role,created_at) VALUES(?,?,?,'client',?)").run(id, `fixture-${i}`, 'unused', now);
      store.db.prepare('INSERT INTO conversations(id,user_id,project_id,created_at) VALUES(?,?,?,?)').run(id, id, 'p', now);
      store.db.prepare("INSERT INTO questions(id,user_id,project_id,question,status,created_at,updated_at,conversation_id) VALUES(?,?,?,?,'pending_question_review',?,?,?)").run(id, id, 'p', 'private body', now, now, id);
    }
    const response = await app.inject({url:'/api/launcher/events',headers:{host:'127.0.0.1','x-launcher-token':'fixture-launcher'}});
    assert.equal(response.statusCode, 200); assert.equal(response.json().items.length, 101);
    assert.ok(response.json().items.some((item: {id:string}) => item.id === '100'));
    assert.ok(!response.body.includes('private body'));
  } finally { await app.close(); await service.stop(); store.close(); await rm(directory,{recursive:true,force:true}); }
});

function cookies(response: { headers: Record<string, unknown> }): string {
  const values = response.headers['set-cookie'];
  return (Array.isArray(values) ? values : values ? [values] : [])
    .map(value => String(value).split(';')[0]).join('; ');
}
async function request(app: App, session: Session, method: 'GET' | 'POST', url: string, payload?: object) {
  return app.inject({ method, url, headers: { host: '127.0.0.1', cookie: session.cookie, 'x-csrf-token': session.csrf }, ...(payload ? { payload } : {}) });
}
async function meta(app: App) {
  const response = await app.inject({ method: 'GET', url: '/api/meta', headers: { host: '127.0.0.1' } });
  assert.equal(response.statusCode, 200);
  return { response, session: { cookie: cookies(response), csrf: response.json().csrfToken } as Session };
}
async function login(app: App, username: string, loginPassword = password) {
  const { session } = await meta(app);
  const response = await request(app, session, 'POST', '/api/login', { username, password: loginPassword });
  assert.equal(response.statusCode, 200, response.body);
  return { cookie: cookies(response), csrf: response.json().csrfToken } as Session;
}

test('server integration: approval, isolation, sessions, backup and safe cleanup', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'desk-server-test-'));
  const store = new Store(join(directory, 'data'));
  const calls: Parameters<Executor>[0][] = [];
  let finish: (() => void) | undefined;
  const executor: Executor = async options => {
    calls.push(options);
    options.onLog(log);
    await new Promise<void>((resolve, reject) => {
      finish = resolve;
      options.signal.addEventListener('abort', () => reject(new Error('fake execution aborted')), { once: true });
    });
    return { answer: draft, exitCode: 0, sessionId: 'fake-session', costUsd: 0.01 };
  };
  const service = new Service(store, executor);
  let admin: App | undefined;
  let client: App | undefined;
  try {
    admin = await createApp(store, service, 'admin', 'test-launcher-token');
    client = await createApp(store, service, 'client');
    const adminApp = admin, clientApp = client;
    let adminSession!: Session, clientSession!: Session, otherSession!: Session;
    let userId = '', otherId = '', questionId = '';
    const projects: string[] = [];

    await t.test('meta supplies CSRF; setup creates an HttpOnly admin session', async () => {
      const initial = await meta(adminApp);
      assert.equal(initial.response.json().needsSetup, true);
      assert.equal(initial.response.json().portal, 'admin');
      assert.ok(initial.session.csrf);
      assert.match(initial.session.cookie, /^desk_admin_csrf=/);
      const setup = await request(adminApp, initial.session, 'POST', '/api/setup', { username: 'administrator', password });
      assert.equal(setup.statusCode, 200, setup.body);
      assert.equal(setup.json().user.role, 'admin');
      assert.match(String(setup.headers['set-cookie']), /desk_admin=.*HttpOnly.*SameSite=Strict/i);
      adminSession = { cookie: cookies(setup), csrf: setup.json().csrfToken };
      assert.notEqual(adminSession.csrf, initial.session.csrf);
      assert.equal((await request(adminApp, adminSession, 'GET', '/api/me')).json().user.username, 'administrator');
      assert.equal((await meta(adminApp)).response.json().needsSetup, false);
      assert.equal((await request(adminApp, adminSession, 'POST', '/api/setup', { username: 'second-admin', password })).statusCode, 409);
    });

    await t.test('projects, grants and client login use real API and password hashing', async () => {
      for (let index = 0; index < 2; index++) {
        const path = join(directory, `project-${index}`);
        await mkdir(path);
        const response = await request(adminApp, adminSession, 'POST', '/api/projects', { name: `Project ${index}`, path });
        assert.equal(response.statusCode, 200, response.body);
        projects.push(response.json().id);
      }
      for (const username of ['customer', 'other-customer']) {
        const response = await request(adminApp, adminSession, 'POST', '/api/users', { username, password, projectIds: projects });
        assert.equal(response.statusCode, 200, response.body);
        if (username === 'customer') userId = response.json().id;
        else otherId = response.json().id;
      }
      clientSession = await login(clientApp, 'customer');
      otherSession = await login(clientApp, 'other-customer');
      assert.match(clientSession.cookie, /^desk_client=/);
      const visible = await request(clientApp, clientSession, 'GET', '/api/projects');
      assert.equal(visible.statusCode, 200);
      assert.equal(visible.json().length, 2);
      assert.ok(visible.json().every((project: any) => !('path' in project)));
    });

    await t.test('CSRF rejects missing, incorrect and cross-origin tokens without mutation', async () => {
      for (const headers of [
        { host: '127.0.0.1', cookie: clientSession.cookie },
        { host: '127.0.0.1', cookie: clientSession.cookie, 'x-csrf-token': 'incorrect' },
        { host: '127.0.0.1', cookie: clientSession.cookie, 'x-csrf-token': clientSession.csrf, origin: 'http://evil.example' },
      ]) {
        const response = await clientApp.inject({ method: 'POST', url: '/api/questions', headers, payload: { projectId: projects[0], question: 'Business question' } });
        assert.equal(response.statusCode, 403, response.body);
      }
      assert.equal((store.db.prepare('SELECT COUNT(*) n FROM questions').get() as any).n, 0);
    });

    await t.test('one-character password works; empty password fails; omitted reset preserves password', async () => {
      const created = await request(adminApp, adminSession, 'POST', '/api/users', { username: 'short-password', password: 'x', projectIds: projects });
      assert.equal(created.statusCode, 200, created.body);
      await login(clientApp, 'short-password', 'x');
      const id = created.json().id;
      assert.equal((await request(adminApp, adminSession, 'POST', '/api/users', { username: 'empty-password', password: '', projectIds: [] })).statusCode, 400);
      assert.equal((await request(adminApp, adminSession, 'POST', `/api/users/${id}`, { password: '' })).statusCode, 400);
      assert.equal((await request(adminApp, adminSession, 'POST', `/api/users/${id}`, { projectIds: projects })).statusCode, 200);
      await login(clientApp, 'short-password', 'x');
      const anonymous = await meta(clientApp);
      assert.equal((await request(clientApp, anonymous.session, 'POST', '/api/login', { username: 'short-password', password: '' })).statusCode, 400);
    });

    await t.test('prompt preview is administrator-only and includes saved extra business instructions', async () => {
      const anonymous = await meta(adminApp);
      assert.equal((await request(adminApp, anonymous.session, 'GET', '/api/settings/prompt')).statusCode, 401);
      assert.equal((await request(clientApp, clientSession, 'GET', '/api/settings/prompt')).statusCode, 404);
      assert.equal((await request(adminApp, clientSession, 'GET', '/api/settings/prompt')).statusCode, 401);
      const original = (await request(adminApp, adminSession, 'GET', '/api/settings')).json();
      const extraPrompt = 'TEST EXTRA BUSINESS: invoice reconciliation';
      assert.equal((await request(adminApp, adminSession, 'POST', '/api/settings', { ...original, extraPrompt })).statusCode, 200);
      const preview = await request(adminApp, adminSession, 'GET', '/api/settings/prompt');
      assert.equal(preview.statusCode, 200);
      assert.ok(preview.json().fixedPrompt.length > 0);
      assert.ok(!preview.json().fixedPrompt.includes(extraPrompt));
      assert.ok(preview.json().combinedPrompt.startsWith(preview.json().fixedPrompt));
      assert.ok(preview.json().combinedPrompt.includes(extraPrompt));
      assert.equal((await request(adminApp, adminSession, 'POST', '/api/settings', original)).statusCode, 200);
    });

    await t.test('execution mode accepts only background automatic or visible Claude terminal', async () => {
      const original = (await request(adminApp, adminSession, 'GET', '/api/settings')).json();
      for (const mode of ['visible', 'hidden']) {
        const saved = await request(adminApp, adminSession, 'POST', '/api/settings', { ...original, mode });
        assert.equal(saved.statusCode, 200, saved.body);
        assert.equal((await request(adminApp, adminSession, 'GET', '/api/settings')).json().mode, mode);
      }
      for (const mode of ['default', 'bypassPermissions', null]) {
        assert.equal((await request(adminApp, adminSession, 'POST', '/api/settings', { ...original, mode })).statusCode, 400);
      }
      assert.equal((await request(adminApp, adminSession, 'POST', '/api/settings', original)).statusCode, 200);
    });

    await t.test('administrator reminders support only window or Windows notification and legacy settings default to window', async () => {
      const original = (await request(adminApp, adminSession, 'GET', '/api/settings')).json();
      assert.equal(original.adminNotificationMode, 'window');
      for (const adminNotificationMode of ['notification', 'window']) {
        const saved = await request(adminApp, adminSession, 'POST', '/api/settings', { ...original, adminNotificationMode });
        assert.equal(saved.statusCode, 200, saved.body);
        assert.equal((await request(adminApp, adminSession, 'GET', '/api/settings')).json().adminNotificationMode, adminNotificationMode);
        const events = await adminApp.inject({ url: '/api/launcher/events', headers: { host: '127.0.0.1', 'x-launcher-token': 'test-launcher-token' } });
        assert.equal(events.statusCode, 200, events.body);
        assert.equal(events.json().adminNotificationMode, adminNotificationMode);
      }
      for (const adminNotificationMode of ['both', 'invalid', null]) {
        assert.equal((await request(adminApp, adminSession, 'POST', '/api/settings', { ...original, adminNotificationMode })).statusCode, 400);
        assert.equal(store.settings().adminNotificationMode, 'window');
      }
      const { adminNotificationMode: _legacyMissing, ...legacy } = original;
      assert.equal((await request(adminApp, adminSession, 'POST', '/api/settings', { ...original, adminNotificationMode: 'notification' })).statusCode, 200);
      assert.equal((await request(adminApp, adminSession, 'POST', '/api/settings', legacy)).statusCode, 200);
      assert.equal(store.settings().adminNotificationMode, 'notification', 'a stale settings form must preserve the saved reminder choice');
      store.db.prepare('UPDATE settings SET value=? WHERE id=1').run(JSON.stringify(legacy));
      assert.equal(store.settings().adminNotificationMode, 'window', 'legacy database is merged with the default');
      assert.equal((await request(adminApp, adminSession, 'POST', '/api/settings', legacy)).statusCode, 200);
      assert.equal(store.settings().adminNotificationMode, 'window', 'legacy settings form remains accepted');
      assert.equal((await request(adminApp, adminSession, 'POST', '/api/settings', original)).statusCode, 200);
    });

    await t.test('retired file dialog endpoint cannot open another popup', async () => {
      const payload = { kind: 'directory', initialPath: directory };
      const anonymous = await meta(adminApp);
      assert.equal((await request(adminApp, anonymous.session, 'POST', '/api/dialog', payload)).statusCode, 401);
      assert.equal((await request(clientApp, clientSession, 'POST', '/api/dialog', payload)).statusCode, 404);
      assert.equal((await request(adminApp, clientSession, 'POST', '/api/dialog', payload)).statusCode, 403);
      for (const csrf of ['', 'incorrect']) assert.equal((await adminApp.inject({ method: 'POST', url: '/api/dialog', headers: { host: '127.0.0.1', cookie: adminSession.cookie, 'x-csrf-token': csrf }, payload })).statusCode, 403);
      for (const invalid of [{}, { kind: 'wrong', initialPath: '' }, { kind: 'file', initialPath: 1 }, { kind: 'directory', initialPath: 'x'.repeat(501) }, { kind: 'file', initialPath: 'bad\u0000path' }]) {
        const response = await request(adminApp, adminSession, 'POST', '/api/dialog', invalid);
        assert.equal(response.statusCode, 404, response.body);
      }
      assert.equal((await request(adminApp, adminSession, 'POST', '/api/dialog', payload)).statusCode, 404);
    });

    await t.test('launcher requires its token, not an admin browser session', async () => {
      for (const supplied of [undefined, 'incorrect']) {
        const response = await adminApp.inject({ method: 'GET', url: '/api/launcher/events', headers: { host: '127.0.0.1', ...(supplied ? { 'x-launcher-token': supplied } : {}) } });
        assert.equal(response.statusCode, 401);
      }
      assert.equal((await request(adminApp, adminSession, 'GET', '/api/launcher/events')).statusCode, 401);
      assert.equal((await clientApp.inject({ method: 'GET', url: '/api/launcher/events', headers: { host: '127.0.0.1', 'x-launcher-token': 'test-launcher-token' } })).statusCode, 404);
    });

    await t.test('concurrent submissions across projects allow exactly one active question', async () => {
      const responses = await Promise.all(projects.map(projectId => request(clientApp, clientSession, 'POST', '/api/questions', { projectId, question: 'Explain the business workflow' })));
      assert.deepEqual(responses.map(response => response.statusCode).sort(), [200, 409]);
      questionId = responses.find(response => response.statusCode === 200)!.json().id;
      assert.equal((store.db.prepare('SELECT COUNT(*) n FROM questions WHERE user_id=?').get(userId) as any).n, 1);
      service.tick();
      await new Promise<void>(resolve => setImmediate(resolve));
      assert.equal(calls.length, 0, 'pending question must never execute');
      assert.equal((await request(clientApp, clientSession, 'GET', `/api/questions/${questionId}`)).json().status, 'pending_question_review');
    });

    await t.test('launcher pending identities have no question, answer, user or log body', async () => {
      const response = await adminApp.inject({ method: 'GET', url: '/api/launcher/events', headers: { host: '127.0.0.1', 'x-launcher-token': 'test-launcher-token' } });
      assert.equal(response.statusCode, 200, response.body);
      assert.equal(response.json().pendingQuestions, 1);
      assert.equal(response.json().items.length, 1);
      assert.equal(response.json().items[0].id, questionId);
      assert.deepEqual(Object.keys(response.json().items[0]).sort(), ['id', 'status', 'updatedAt']);
      for (const secret of ['Explain the business workflow', draft, log, 'customer', 'test-launcher-token']) assert.ok(!response.body.includes(secret), secret);
    });

    await t.test('client cannot access admin routes or guess another customer question ID', async () => {
      for (const url of ['/api/users', '/api/settings', '/api/stats', '/api/export', '/api/backup']) {
        assert.equal((await request(clientApp, clientSession, 'GET', url)).statusCode, 404, url);
      }
      for (const url of [`/api/questions/${questionId}/approve`, '/api/projects', '/api/users', '/api/cleanup']) {
        assert.equal((await request(clientApp, clientSession, 'POST', url, {})).statusCode, 404, url);
      }
      assert.equal((await request(clientApp, otherSession, 'GET', `/api/questions/${questionId}`)).statusCode, 404);
      assert.equal((await request(clientApp, clientSession, 'GET', `/api/questions/${randomUUID()}`)).statusCode, 404);
      assert.equal((await request(clientApp, otherSession, 'GET', '/api/questions')).json().total, 0);
    });

    await t.test('approval runs once; running and review responses never leak draft or logs', async () => {
      assert.equal((await request(adminApp, adminSession, 'POST', `/api/questions/${questionId}/approve`)).statusCode, 200);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].question, 'Explain the business workflow');
      assert.equal(calls[0].signal.aborted, false);
      assert.equal((await request(adminApp, adminSession, 'POST', `/api/questions/${questionId}/approve`)).statusCode, 200);
      assert.equal(calls.length, 1);
      const running = await request(clientApp, clientSession, 'GET', `/api/questions/${questionId}`);
      assert.equal(running.json().status, 'running');
      assert.ok(!running.body.includes(log));
      const execution = service.current!.promise;
      assert.ok(finish);
      finish();
      await execution;
      const adminDetail = await request(adminApp, adminSession, 'GET', `/api/questions/${questionId}`);
      assert.equal(adminDetail.json().draftAnswer, draft);
      assert.ok(!('runs' in adminDetail.json()), 'ordinary admin detail excludes execution records');
      assert.ok(!adminDetail.body.includes(log));
      for (const url of [`/api/questions/${questionId}`, '/api/questions']) {
        const response = await request(clientApp, clientSession, 'GET', url);
        assert.equal(response.statusCode, 200);
        assert.ok(!response.body.includes(draft));
        assert.ok(!response.body.includes(log));
        const item = url === '/api/questions' ? response.json().items[0] : response.json();
        assert.equal(item.status, 'pending_answer_review');
        for (const key of ['draftAnswer', 'runs', 'logs', 'answer']) assert.ok(!(key in item), key);
      }
      assert.equal((await request(adminApp, adminSession, 'POST', `/api/questions/${questionId}/approve`)).statusCode, 409);
      assert.equal(calls.length, 1);
    });

    await t.test('only explicitly published answer becomes client-visible; publish is idempotent', async () => {
      const answer = 'Reviewed business explanation';
      assert.equal((await request(adminApp, adminSession, 'POST', `/api/questions/${questionId}/publish`, { answer: '```private code```' })).statusCode, 400);
      for (let index = 0; index < 2; index++) {
        assert.equal((await request(adminApp, adminSession, 'POST', `/api/questions/${questionId}/publish`, { answer })).statusCode, 200);
      }
      const detail = await request(clientApp, clientSession, 'GET', `/api/questions/${questionId}`);
      assert.equal(detail.json().status, 'answered');
      assert.equal(detail.json().answer, answer);
      assert.equal((await request(clientApp, clientSession, 'GET', '/api/questions')).json().items[0].answer, answer);
      assert.ok(!detail.body.includes(draft));
      assert.ok(!detail.body.includes(log));
      assert.equal((await request(adminApp, adminSession, 'POST', `/api/questions/${questionId}/publish`, { answer: 'Changed answer' })).statusCode, 409);
    });

    await t.test('SQLite backup is a consistent independent snapshot, including runs and settings', async () => {
      const response = await request(adminApp, adminSession, 'GET', '/api/backup');
      assert.equal(response.statusCode, 200, response.body);
      assert.match(String(response.headers['content-type']), /application\/octet-stream/);
      assert.match(String(response.headers['content-disposition']), /desk-backup.sqlite/);
      const path = join(directory, 'snapshot.sqlite');
      await writeFile(path, response.rawPayload);
      const snapshot = new DatabaseSync(path, { readOnly: true });
      try {
        assert.equal((snapshot.prepare('PRAGMA integrity_check').get() as any).integrity_check, 'ok');
        assert.deepEqual(snapshot.prepare('PRAGMA foreign_key_check').all(), []);
        for (const table of ['users', 'sessions', 'projects', 'grants', 'questions', 'runs', 'settings', 'audit']) {
          assert.deepEqual(snapshot.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(), store.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(), table);
        }
        store.db.prepare('UPDATE questions SET answer=? WHERE id=?').run('Later live change', questionId);
        assert.equal((snapshot.prepare('SELECT answer FROM questions WHERE id=?').get(questionId) as any).answer, 'Reviewed business explanation');
      } finally { snapshot.close(); }
      assert.ok((await readdir(store.directory)).every(name => !name.startsWith('backup-')));
    });

    await t.test('revoked grants and disabled projects hide history and reject new submissions', async () => {
      const projectId = (store.db.prepare('SELECT project_id FROM questions WHERE id=?').get(questionId) as any).project_id;
      assert.equal((await request(adminApp, adminSession, 'POST', `/api/users/${userId}`, { projectIds: [] })).statusCode, 200);
      clientSession = await login(clientApp, 'customer');
      assert.equal((await request(clientApp, clientSession, 'GET', '/api/questions')).json().total, 0);
      assert.deepEqual((await request(clientApp, clientSession, 'GET', '/api/questions')).json().items, []);
      assert.equal((await request(clientApp, clientSession, 'GET', `/api/questions/${questionId}`)).statusCode, 404);
      assert.equal((await request(clientApp, clientSession, 'POST', '/api/questions', { projectId, question: 'Unauthorized submission' })).statusCode, 403);
      assert.equal((await request(adminApp, adminSession, 'GET', `/api/questions/${questionId}`)).statusCode, 200);
      assert.equal((await request(adminApp, adminSession, 'POST', `/api/users/${userId}`, { projectIds: projects })).statusCode, 200);
      clientSession = await login(clientApp, 'customer');
      assert.equal((await request(clientApp, clientSession, 'GET', '/api/questions')).json().total, 1);
      assert.equal((await request(adminApp, adminSession, 'POST', `/api/projects/${projectId}`, { enabled: false })).statusCode, 200);
      assert.equal((await request(clientApp, clientSession, 'GET', '/api/questions')).json().total, 0);
      assert.equal((await request(clientApp, clientSession, 'GET', `/api/questions/${questionId}`)).statusCode, 404);
      assert.equal((await request(clientApp, clientSession, 'POST', '/api/questions', { projectId, question: 'Disabled project submission' })).statusCode, 403);
      assert.equal((await request(adminApp, adminSession, 'POST', `/api/projects/${projectId}`, { enabled: true })).statusCode, 200);
      assert.equal((await request(clientApp, clientSession, 'GET', `/api/questions/${questionId}`)).statusCode, 200);
    });

    await t.test('actual rejection reason is visible to the owner in detail and list', async () => {
      const submitted = await request(clientApp, otherSession, 'POST', '/api/questions', { projectId: projects[0], question: 'Please clarify the approval scope' });
      assert.equal(submitted.statusCode, 200, submitted.body);
      const id = submitted.json().id, reason = '请补充订单日期与业务范围后重新提交。';
      assert.equal((await request(adminApp, adminSession, 'POST', `/api/questions/${id}/reject`, { reason })).statusCode, 200);
      const detail = await request(clientApp, otherSession, 'GET', `/api/questions/${id}`);
      assert.equal(detail.json().status, 'rejected');
      assert.equal(detail.json().error, reason);
      const list = await request(clientApp, otherSession, 'GET', '/api/questions?status=rejected');
      assert.equal(list.json().items.find((q: any) => q.id === id).error, reason);
      assert.equal((await request(clientApp, clientSession, 'GET', `/api/questions/${id}`)).statusCode, 404);
      assert.ok(!(await request(clientApp, clientSession, 'GET', '/api/questions')).body.includes(reason));
    });

    await t.test('disabling an account invalidates its existing session and login', async () => {
      assert.equal((await request(adminApp, adminSession, 'POST', `/api/users/${userId}`, { enabled: false })).statusCode, 200);
      assert.equal((await request(clientApp, clientSession, 'GET', '/api/me')).statusCode, 401);
      assert.equal((await request(clientApp, clientSession, 'GET', '/api/questions')).statusCode, 401);
      assert.equal((store.db.prepare('SELECT COUNT(*) n FROM sessions WHERE user_id=?').get(userId) as any).n, 0);
      const { session } = await meta(clientApp);
      assert.equal((await request(clientApp, session, 'POST', '/api/login', { username: 'customer', password })).statusCode, 401);
      assert.equal((await request(clientApp, otherSession, 'GET', '/api/me')).statusCode, 200);
    });

    await t.test('cleanup requires matching preview and deletes only old archived terminal questions', async () => {
      const before = '2024-01-01T00:00:00.000Z';
      const old = '2023-01-01T00:00:00.000Z', recent = '2025-01-01T00:00:00.000Z';
      const deleted: string[] = [], retained: string[] = [questionId];
      const seed = (status: string, archived: number, createdAt: string) => {
        const id = randomUUID();
        // Each active state gets a separate user to respect the production unique index.
        const owner = activeStates.includes(status) ? randomUUID() : otherId;
        if (owner !== otherId) store.db.prepare('INSERT INTO users VALUES(?,?,?,?,1,?)').run(owner, `seed-${owner}`, 'unused', 'client', old);
        store.db.prepare('INSERT INTO conversations VALUES(?,?,?,?)').run(id, owner, projects[0], createdAt);
        store.db.prepare('INSERT INTO questions(id,user_id,project_id,question,status,archived,created_at,updated_at,conversation_id) VALUES(?,?,?,?,?,?,?,?,?)').run(id, owner, projects[0], 'Cleanup fixture', status, archived, createdAt, createdAt, id);
        return id;
      };
      for (const status of ['answered', 'rejected', 'failed', 'cancelled']) {
        deleted.push(seed(status, 1, old));
        retained.push(seed(status, 0, old), seed(status, 1, recent), seed(status, 1, before));
      }
      for (const status of activeStates) retained.push(seed(status, 1, old));
      store.db.prepare("INSERT INTO runs(id,question_id,status,started_at) VALUES(?,?,'completed',?)").run(randomUUID(), deleted[0], old);
      assert.equal((await request(adminApp, adminSession, 'POST', '/api/cleanup/preview', { before })).json().count, deleted.length);
      assert.equal((await request(adminApp, adminSession, 'POST', '/api/cleanup', { before, confirmation: 'DELETE', expectedCount: deleted.length + 1 })).statusCode, 409);
      assert.equal((await request(adminApp, adminSession, 'POST', '/api/cleanup', { before, confirmation: 'WRONG', expectedCount: deleted.length })).statusCode, 400);
      for (const id of deleted) assert.ok(store.db.prepare('SELECT 1 FROM questions WHERE id=?').get(id));
      const response = await request(adminApp, adminSession, 'POST', '/api/cleanup', { before, confirmation: 'DELETE', expectedCount: deleted.length });
      assert.equal(response.statusCode, 200, response.body);
      assert.equal(response.json().deleted, deleted.length);
      for (const id of deleted) assert.equal(store.db.prepare('SELECT 1 FROM questions WHERE id=?').get(id), undefined);
      for (const id of retained) assert.ok(store.db.prepare('SELECT 1 FROM questions WHERE id=?').get(id), id);
      assert.equal((store.db.prepare('SELECT COUNT(*) n FROM runs WHERE question_id=?').get(deleted[0]) as any).n, 0);
      assert.deepEqual(store.db.prepare('PRAGMA foreign_key_check').all(), []);
    });
    assert.equal(service.listeners.size, 0, 'tests must not open SSE connections');
    assert.equal(adminApp.server.listening, false);
    assert.equal(clientApp.server.listening, false);
  } finally {
    await service.stop();
    await admin?.close();
    await client?.close();
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

// Lifecycle fixtures seed authentication only; state transitions still go through the API.
async function lifecycleFixture(executor: Executor) {
  const directory = await mkdtemp(join(tmpdir(), 'desk-lifecycle-test-'));
  const store = new Store(join(directory, 'data'));
  const projectId = randomUUID(), adminId = randomUUID();
  const now = new Date().toISOString();
  store.db.prepare('INSERT INTO users VALUES(?,?,?,?,1,?)').run(adminId, 'lifecycle-admin', 'unused', 'admin', now);
  store.db.prepare('INSERT INTO projects VALUES(?,?,?,?,1)').run(projectId, 'Lifecycle project', '', directory);
  const session: Session = { cookie: 'desk_admin=lifecycle-session', csrf: 'lifecycle-csrf' };
  store.db.prepare('INSERT INTO sessions VALUES(?,?,?,?,?)').run(digest('lifecycle-session'), adminId, 'admin', session.csrf, Date.now() + 60_000);
  const service = new Service(store, executor);
  const app = await createApp(store, service, 'admin');
  const seed = (status: string, createdAt = now) => {
    const userId = randomUUID(), id = randomUUID();
    store.db.prepare('INSERT INTO users VALUES(?,?,?,?,1,?)').run(userId, `client-${userId}`, 'unused', 'client', now);
    store.db.prepare('INSERT INTO grants VALUES(?,?)').run(userId, projectId);
    store.db.prepare('INSERT INTO conversations VALUES(?,?,?,?)').run(id, userId, projectId, createdAt);
    store.db.prepare('INSERT INTO questions(id,user_id,project_id,question,status,created_at,updated_at,conversation_id) VALUES(?,?,?,?,?,?,?,?)').run(id, userId, projectId, `Question ${id}`, status, createdAt, now, id);
    return id;
  };
  const status = (id: string) => (store.db.prepare('SELECT status FROM questions WHERE id=?').get(id) as any).status;
  const action = (id: string, name: string) => request(app, session, 'POST', `/api/questions/${id}/${name}`);
  const dispose = async () => {
    await service.stop();
    await app.close();
    store.close();
    await rm(directory, { recursive: true, force: true });
  };
  return { directory, store, service, app, session, seed, status, action, dispose };
}

test('publish accepts 9000 Chinese characters but rejects more than 20000 characters', async () => {
  const fixture = await lifecycleFixture(async () => ({ answer: 'Unused', exitCode: 0 }));
  try {
    const id = fixture.seed('pending_answer_review');
    const oversized = '汉'.repeat(20_001);
    const rejected = await request(fixture.app, fixture.session, 'POST', `/api/questions/${id}/publish`, { answer: oversized });
    assert.equal(rejected.statusCode, 400, rejected.body);
    assert.equal(fixture.status(id), 'pending_answer_review');
    assert.equal((fixture.store.db.prepare('SELECT answer FROM questions WHERE id=?').get(id) as any).answer, null);
    const answer = '汉'.repeat(9_000);
    assert.ok(Buffer.byteLength(JSON.stringify({ answer }), 'utf8') > 24 * 1024);
    const published = await request(fixture.app, fixture.session, 'POST', `/api/questions/${id}/publish`, { answer });
    assert.equal(published.statusCode, 200, published.body);
    assert.equal(fixture.status(id), 'answered');
    assert.equal((fixture.store.db.prepare('SELECT answer FROM questions WHERE id=?').get(id) as any).answer, answer);
    // The larger limit is scoped to approval actions, not all JSON API requests.
    const otherRoute = await request(fixture.app, fixture.session, 'POST', '/api/projects', { name: 'Oversized body', description: answer, path: fixture.directory });
    assert.equal(otherRoute.statusCode, 413, otherRoute.body);
  } finally { await fixture.dispose(); }
});

test('failed execution requires retry and a fresh approval before executing again', async () => {
  let calls = 0;
  const fixture = await lifecycleFixture(async () => {
    calls++;
    if (calls === 1) throw new Error('fake runner failed');
    return { answer: 'Retry draft', exitCode: 0 };
  });
  try {
    const id = fixture.seed('pending_question_review');
    assert.equal((await fixture.action(id, 'approve')).statusCode, 200);
    // execute() may finish before inject() resolves, so wait for the queued microtask too.
    await fixture.service.current?.promise;
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(fixture.status(id), 'failed');
    assert.equal(calls, 1);
    const failedRun = fixture.store.db.prepare('SELECT * FROM runs WHERE question_id=?').get(id) as any;
    assert.equal(failedRun.status, 'failed');
    assert.equal(failedRun.error, 'fake runner failed');
    assert.equal((await fixture.action(id, 'approve')).statusCode, 409);
    assert.equal((await fixture.action(id, 'retry')).statusCode, 200);
    assert.equal(fixture.status(id), 'pending_question_review');
    const retried = fixture.store.db.prepare('SELECT draft_answer,error FROM questions WHERE id=?').get(id) as any;
    assert.equal(retried.draft_answer, null);
    assert.equal(retried.error, null);
    fixture.service.tick();
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(calls, 1, 'retry must not bypass question review');
    assert.equal((await fixture.action(id, 'approve')).statusCode, 200);
    await fixture.service.current?.promise;
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(calls, 2);
    assert.equal(fixture.status(id), 'pending_answer_review');
    assert.equal((fixture.store.db.prepare('SELECT COUNT(*) n FROM runs WHERE question_id=?').get(id) as any).n, 2);
  } finally { await fixture.dispose(); }
});

test('queue runs serially and cancellation holds the slot until executor actually exits', async () => {
  const executions: { options: Parameters<Executor>[0]; release: () => void }[] = [];
  const fixture = await lifecycleFixture(async options => {
    // Deliberately ignore abort until release, emulating a child process still exiting.
    await new Promise<void>(resolve => executions.push({ options, release: resolve }));
    return { answer: 'Controlled draft', exitCode: 0 };
  });
  try {
    const first = fixture.seed('queued', '2020-01-01T00:00:00.000Z');
    const second = fixture.seed('queued', '2020-01-02T00:00:00.000Z');
    fixture.service.tick();
    assert.equal(executions.length, 1);
    assert.equal(fixture.service.current?.questionId, first);
    assert.equal(fixture.status(first), 'running');
    assert.equal(fixture.status(second), 'queued');
    fixture.service.tick();
    assert.equal(executions.length, 1);
    const firstPromise = fixture.service.current!.promise;
    assert.equal((await fixture.action(first, 'cancel')).statusCode, 200);
    assert.equal(executions[0].options.signal.aborted, true);
    assert.equal(fixture.status(first), 'running', 'abort request is not execution completion');
    assert.equal(fixture.service.current?.questionId, first);
    fixture.service.tick();
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(executions.length, 1, 'queued execution must wait for cancelled executor to exit');
    executions[0].release();
    await firstPromise;
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(fixture.status(first), 'cancelled');
    assert.equal(executions.length, 2);
    assert.equal(fixture.service.current?.questionId, second);
    assert.equal(fixture.status(second), 'running');
    const cancelledRun = fixture.store.db.prepare('SELECT * FROM runs WHERE question_id=?').get(first) as any;
    assert.equal(cancelledRun.status, 'cancelled');
    assert.ok(cancelledRun.ended_at);
    const secondPromise = fixture.service.current!.promise;
    executions[1].release();
    await secondPromise;
    assert.equal(fixture.status(second), 'pending_answer_review');
    assert.equal(fixture.service.current, undefined);
  } finally {
    // Prevent a failed assertion from leaving a controlled fake blocked in stop().
    fixture.service.stopping = true;
    for (const execution of executions) execution.release();
    await fixture.dispose();
  }
});

test('revoking project grants aborts the current execution without publishing its result', async () => {
  let release: (() => void) | undefined;
  let signal: AbortSignal | undefined;
  const fixture = await lifecycleFixture(async options => {
    signal = options.signal;
    await new Promise<void>(resolve => { release = resolve; });
    return { answer: 'Revoked private answer', exitCode: 0 };
  });
  try {
    const id = fixture.seed('queued');
    fixture.service.tick();
    const promise = fixture.service.current!.promise;
    const userId = (fixture.store.db.prepare('SELECT user_id FROM questions WHERE id=?').get(id) as any).user_id;
    const response = await request(fixture.app, fixture.session, 'POST', `/api/users/${userId}`, { projectIds: [] });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(signal?.aborted, true);
    assert.equal(fixture.status(id), 'running');
    release!();
    await promise;
    assert.equal(fixture.status(id), 'cancelled');
    assert.equal((fixture.store.db.prepare('SELECT draft_answer FROM questions WHERE id=?').get(id) as any).draft_answer, null);
    assert.equal((fixture.store.db.prepare('SELECT status FROM runs WHERE question_id=?').get(id) as any).status, 'cancelled');
  } finally {
    fixture.service.stopping = true;
    release?.();
    await fixture.dispose();
  }
});

test('SSE disconnect removes its listener and permits clean application shutdown', { timeout: 10_000 }, async () => {
  const fixture = await lifecycleFixture(async () => ({ answer: 'Unused', exitCode: 0 }));
  const controller = new AbortController();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    // SSE needs a real streaming transport; only this test listens on an ephemeral loopback port.
    const address = await fixture.app.listen({ host: '127.0.0.1', port: 0 });
    const response = await fetch(`${address}/api/events`, {
      headers: { cookie: fixture.session.cookie }, signal: controller.signal,
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/);
    reader = response.body!.getReader();
    const initial = await reader.read();
    assert.equal(initial.done, false);
    assert.match(new TextDecoder().decode(initial.value), /data: \{"type":"refresh"\}/);
    assert.equal(fixture.service.listeners.size, 1);
    const next = reader.read();
    fixture.service.notify();
    assert.match(new TextDecoder().decode((await next).value), /refresh/);
    await reader.cancel();
    controller.abort();
    // Socket close is asynchronous; bounded polling avoids relying on an arbitrary single sleep.
    const deadline = Date.now() + 2_000;
    while (fixture.service.listeners.size && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(fixture.service.listeners.size, 0);
    await fixture.service.stop();
    await fixture.app.close();
    assert.equal(fixture.app.server.listening, false);
  } finally {
    controller.abort();
    await reader?.cancel().catch(() => {});
    await fixture.dispose();
  }
});

test('application shutdown actively ends an open SSE connection and removes its listener', { timeout: 10_000 }, async () => {
  const fixture = await lifecycleFixture(async () => ({ answer: 'Unused', exitCode: 0 }));
  const controller = new AbortController();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const address = await fixture.app.listen({ host: '127.0.0.1', port: 0 });
    const response = await fetch(`${address}/api/events`, { headers: { cookie: fixture.session.cookie }, signal: controller.signal });
    assert.equal(response.status, 200);
    reader = response.body!.getReader();
    assert.equal((await reader.read()).done, false);
    assert.equal(fixture.service.listeners.size, 1);
    // Leave the client connected: preClose must terminate the stream without a client abort.
    const ending = reader.read();
    await fixture.service.stop();
    await fixture.app.close();
    assert.equal((await ending).done, true);
    assert.equal(controller.signal.aborted, false);
    assert.equal(fixture.service.listeners.size, 0);
    assert.equal(fixture.app.server.listening, false);
  } finally {
    controller.abort();
    await reader?.cancel().catch(() => {});
    await fixture.dispose();
  }
});

test('restart marks persisted running work failed and interrupted without re-execution', async () => {
  let calls = 0;
  const fixture = await lifecycleFixture(async () => {
    calls++;
    return { answer: 'Must not execute', exitCode: 0 };
  });
  let reopened: Store | undefined, restarted: Service | undefined;
  try {
    const id = fixture.seed('running');
    const runId = randomUUID();
    fixture.store.db.prepare("INSERT INTO runs(id,question_id,status,started_at,logs) VALUES(?,?,'running',?,?)").run(runId, id, '2020-01-01T00:00:00.000Z', 'Previous diagnostics');
    await fixture.service.stop();
    await fixture.app.close();
    fixture.store.close();
    reopened = new Store(fixture.store.directory);
    restarted = new Service(reopened, async () => {
      calls++;
      return { answer: 'Must not execute after restart', exitCode: 0 };
    });
    const question = reopened.db.prepare('SELECT * FROM questions WHERE id=?').get(id) as any;
    const run = reopened.db.prepare('SELECT * FROM runs WHERE id=?').get(runId) as any;
    assert.equal(question.status, 'failed');
    assert.match(question.error, /服务在执行中中断/);
    assert.equal(run.status, 'interrupted');
    assert.ok(run.ended_at);
    assert.equal(run.logs, 'Previous diagnostics');
    restarted.tick();
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(calls, 0);
    assert.equal(restarted.current, undefined);
    assert.equal((reopened.db.prepare('SELECT COUNT(*) n FROM runs WHERE question_id=?').get(id) as any).n, 1);
  } finally {
    await restarted?.stop();
    if (reopened) {
      reopened.close();
      // The original Store was already closed before opening the restarted instance.
      await rm(fixture.directory, { recursive: true, force: true });
    } else {
      // Normal assertions above happen after reopening; this covers early setup failure.
      await fixture.dispose();
    }
  }
});
