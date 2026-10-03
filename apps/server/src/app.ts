import Fastify, { type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import staticFiles from '@fastify/static';
import { z } from 'zod';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync, realpathSync, statSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { backup } from 'node:sqlite';
import { Store, activeStates, defaultSettings } from './store.js';
import { Service } from './service.js';
import { digest, token, hashPassword, verifyPassword } from './auth.js';
import { probeClaude, buildBusinessPrompt, validatePromptInput } from './claude/runner.js';
import { validateBusinessAnswer } from './claude/prompt.js';
import { contextSnapshotSchema, renderQuestionInput } from './context.js';
import { recordVisibility, registerHistoryRoutes } from './history.js';

const credentials = z.object({ username: z.string().trim().min(2).max(40).regex(/^[\p{L}\p{N}_.-]+$/u), password: z.string().min(1).max(128) });
const settingsSchema = z.object({ claudePath: z.string().max(500), mode: z.enum(['hidden', 'visible']), timeoutSeconds: z.number().int().min(30).max(1800), clientHost: z.string().ip(), clientPort: z.number().int().min(1024).max(65535), adminPort: z.number().int().min(1024).max(65535), allowInsecureLan: z.boolean(), adminNotificationMode: z.enum(['window', 'notification']).default('window'), fixedPrompt: z.string().min(1).max(4000).refine(value => !!value.trim() && !value.includes('\0'), '固定业务提示词不能为空或包含空字符').default(defaultSettings.fixedPrompt), extraPrompt: z.string().max(4000) });
function fail(code: number, message: string): never { throw Object.assign(new Error(message), { statusCode: code }); }
const usernameOf = (request: FastifyRequest) => (request as any).user as any;
function projectPath(path: string) {
  if (/^(?:\\\\|\/\/)/.test(path)) fail(400, '不支持网络共享路径');
  const actual = realpathSync(resolve(path));
  if (!statSync(actual).isDirectory()) fail(400, '项目路径必须为目录');
  return actual;
}
export async function createApp(store: Store, service: Service, portal: 'admin' | 'client', launcherToken?: string) {
  const app = Fastify({ bodyLimit: 24 * 1024, logger: false, trustProxy: false, connectionTimeout: 15000, requestTimeout: 30000 });
  const cookieName = portal === 'admin' ? 'desk_admin' : 'desk_client';
  const eventSockets = new Set<import('node:http').ServerResponse>();
  const eventCounts = new Map<string, number>();
  app.addHook('preClose', async () => { for (const socket of eventSockets) socket.end(); eventSockets.clear(); });
  await app.register(cookie);
  await app.register(rateLimit, { max: 120, timeWindow: '1 minute', allowList: request => request.url === '/api/events' });
  app.setErrorHandler((error, _request, reply) => {
    const e = error as any;
    if (e instanceof z.ZodError) return reply.code(400).send({ message: '输入不符合要求', details: e.issues.map((i: any) => `${i.path.join('.')}: ${i.message}`) });
    const code = e.statusCode ?? (String(e.code).includes('CONSTRAINT') ? 409 : 500);
    reply.code(code).send({ message: code < 500 ? e.message : '操作失败，请检查配置或联系管理员' });
  });
  app.addHook('onRequest', async (request, reply) => {
    const host = request.headers.host?.split(':')[0]?.toLowerCase();
    if (portal === 'admin' && host !== '127.0.0.1' && host !== 'localhost') fail(403, '管理入口只允许本机访问');
    if (!request.url.startsWith('/api/')) return;
    if (request.url === '/api/launcher/events') return;
    const sessionCookie = request.cookies[cookieName];
    const session = sessionCookie ? store.db.prepare('SELECT s.*,u.username,u.role,u.enabled FROM sessions s JOIN users u ON u.id=s.user_id WHERE token=? AND expires>? AND portal=?').get(digest(sessionCookie), Date.now(), portal) as any : undefined;
    if (session?.enabled && (portal !== 'admin' || session.role === 'admin')) (request as any).user = { id: session.user_id, username: session.username, role: session.role, csrfToken: session.csrf };
    if (!['GET', 'HEAD'].includes(request.method)) {
      const origin = request.headers.origin;
      if (origin) {
        try { if (new URL(origin).host !== request.headers.host) fail(403, '请求来源不匹配'); } catch { fail(403, '请求来源不匹配'); }
      }
      const expected = usernameOf(request)?.csrfToken ?? request.cookies[`${cookieName}_csrf`];
      const supplied = request.headers['x-csrf-token'];
      if (!expected || typeof supplied !== 'string' || expected.length !== supplied.length || !timingSafeEqual(Buffer.from(expected), Buffer.from(supplied))) fail(403, '请刷新页面后重试');
    }
    const publicPaths = ['/api/meta','/api/login', ...(portal === 'admin' ? ['/api/setup'] : [])];
    if (!publicPaths.includes(request.url.split('?')[0]) && !usernameOf(request)) fail(401, '请先登录');
    reply.header('Cache-Control', 'no-store');
  });
  app.addHook('onSend', async (_request, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Referrer-Policy', 'same-origin');
    reply.header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  });
  app.get('/api/meta', async (request, reply) => {
    const csrf = usernameOf(request)?.csrfToken ?? request.cookies[`${cookieName}_csrf`] ?? token();
    reply.setCookie(`${cookieName}_csrf`, csrf, { httpOnly: true, sameSite: 'strict', path: '/', maxAge: 3600 });
    return { portal, needsSetup: !store.db.prepare("SELECT 1 FROM users WHERE role='admin'").get(), csrfToken: csrf };
  });
  async function login(request: FastifyRequest, reply: any, user: any) {
    if ((portal === 'admin') !== (user.role === 'admin')) fail(401, '账号或密码错误');
    const sessionToken = token(), csrf = token();
    store.db.prepare('DELETE FROM sessions WHERE expires<?').run(Date.now());
    store.db.prepare('INSERT INTO sessions VALUES(?,?,?,?,?)').run(digest(sessionToken), user.id, portal, csrf, Date.now() + 8 * 3600_000);
    reply.setCookie(cookieName, sessionToken, { path: '/', httpOnly: true, sameSite: 'strict', maxAge: 8 * 3600, secure: request.protocol === 'https' });
    return { user: { id: user.id, username: user.username, role: user.role }, csrfToken: csrf };
  }
  app.post('/api/login', { config: { rateLimit: { max: 8, timeWindow: '1 minute' } } }, async (request, reply) => {
    const body = credentials.parse(request.body);
    const user = store.db.prepare('SELECT * FROM users WHERE username=?').get(body.username) as any;
    const ok = await verifyPassword(body.password, user?.password ?? '00000000000000000000000000000000:' + '00'.repeat(64));
    const current = user ? store.db.prepare('SELECT * FROM users WHERE id=?').get(user.id) as any : undefined;
    if (!user?.enabled || !ok || !current?.enabled || current.password !== user.password || current.role !== user.role) fail(401, '账号或密码错误');
    return login(request, reply, current);
  });
  if (portal === 'admin') app.post('/api/setup', { config: { rateLimit: { max: 3, timeWindow: '1 minute' } } }, async (request, reply) => {
    const body = credentials.parse(request.body); const password = await hashPassword(body.password); const id = randomUUID();
    store.transaction(() => {
      if (store.db.prepare("SELECT 1 FROM users WHERE role='admin'").get()) fail(409, '管理员已经初始化');
      store.db.prepare('INSERT INTO users VALUES(?,?,?,?,1,?)').run(id, body.username, password, 'admin', new Date().toISOString());
      store.audit(id, 'setup', id);
    });
    return login(request, reply, { id, username: body.username, role: 'admin' });
  });
  app.get('/api/me', async request => ({ user: { ...usernameOf(request), csrfToken: undefined }, csrfToken: usernameOf(request).csrfToken }));
  app.post('/api/logout', async (request, reply) => {
    store.db.prepare('DELETE FROM sessions WHERE token=?').run(digest(request.cookies[cookieName] ?? ''));
    reply.clearCookie(cookieName, { path: '/' }); return { ok: true };
  });
  app.get('/api/projects', async request => portal === 'admin'
    ? store.db.prepare('SELECT id,name,description,path,enabled FROM projects ORDER BY name').all().map((p: any) => ({ ...p, enabled: !!p.enabled }))
    : store.db.prepare('SELECT p.id,p.name,p.description,p.enabled FROM projects p JOIN grants g ON g.project_id=p.id WHERE g.user_id=? AND p.enabled=1 ORDER BY name').all(usernameOf(request).id).map((p: any) => ({ ...p, enabled: true })));
  function getQuestion(id: string, request: FastifyRequest) {
    const row = store.db.prepare(`SELECT q.*,p.name project_name,u.username FROM questions q JOIN projects p ON p.id=q.project_id JOIN users u ON u.id=q.user_id WHERE q.id=? AND ${recordVisibility()}`).get(id, usernameOf(request).id) as any;
    if (!row) fail(404, '问题不存在');
    if (portal === 'client' && (row.user_id !== usernameOf(request).id || !store.db.prepare('SELECT 1 FROM grants g JOIN projects p ON p.id=g.project_id WHERE g.user_id=? AND g.project_id=? AND p.enabled=1').get(usernameOf(request).id, row.project_id))) fail(404, '问题不存在');
    return row;
  }
  function present(row: any) {
    return { id: row.id, conversationId: row.conversation_id, turnIndex: row.turn_index, parentQuestionId: row.parent_question_id, ...(portal === 'admin' ? { contextSnapshot: contextSnapshotSchema.parse(JSON.parse(row.context_snapshot)) } : {}), projectId: row.project_id, projectName: row.project_name, username: row.username, question: row.question, status: row.status, answer: row.status === 'answered' ? row.answer : undefined, ...(portal === 'admin' ? { draftAnswer: row.draft_answer, error: row.error } : { error: row.status === 'failed' ? '处理失败，请联系管理员' : row.status === 'rejected' ? (row.error || '管理员拒绝了此问题') : undefined }), archived: !!row.archived, createdAt: row.created_at, updatedAt: row.updated_at };
  }
  app.get('/api/questions', async request => {
    const query = z.object({ page: z.coerce.number().int().min(1).max(10000).default(1), status: z.string().max(50).optional() }).parse(request.query);
    const clauses = [recordVisibility()], params: any[] = [usernameOf(request).id];
    if (portal === 'client') { clauses.push('q.user_id=?'); clauses.push('EXISTS(SELECT 1 FROM grants g JOIN projects ap ON ap.id=g.project_id WHERE g.user_id=q.user_id AND g.project_id=q.project_id AND ap.enabled=1)'); params.push(usernameOf(request).id); }
    if (query.status) { clauses.push('q.status=?'); params.push(query.status); }
    const where = clauses.length ? 'WHERE ' + clauses.join(' AND ') : '';
    const total = (store.db.prepare(`SELECT COUNT(*) count FROM questions q ${where}`).get(...params) as any).count;
    const rows = store.db.prepare(`SELECT q.*,p.name project_name,u.username FROM questions q JOIN projects p ON p.id=q.project_id JOIN users u ON u.id=q.user_id ${where} ORDER BY q.created_at DESC LIMIT 30 OFFSET ?`).all(...params, (query.page - 1) * 30);
    return { items: rows.map(present), total, page: query.page };
  });
  registerHistoryRoutes(app, store, service, portal, usernameOf);
  const visibleQuestions = `WITH visible_questions AS (SELECT * FROM questions q WHERE ${recordVisibility()})`;
  const conversationSelect = `${visibleQuestions} SELECT c.*,p.name project_name,u.username,
    (SELECT question FROM visible_questions WHERE conversation_id=c.id ORDER BY turn_index LIMIT 1) title,
    (SELECT MIN(turn_index) FROM visible_questions WHERE conversation_id=c.id) title_turn_index,
    (SELECT question FROM visible_questions WHERE conversation_id=c.id ORDER BY turn_index DESC LIMIT 1) latest_question,
    (SELECT MAX(turn_index) FROM visible_questions WHERE conversation_id=c.id) latest_visible_turn_index,
    (SELECT COUNT(*) FROM visible_questions WHERE conversation_id=c.id AND turn_index>1) followup_count,
    (SELECT status FROM questions WHERE conversation_id=c.id ORDER BY turn_index DESC LIMIT 1) status,
    (SELECT id FROM questions WHERE conversation_id=c.id ORDER BY turn_index DESC LIMIT 1) latest_turn_id,
    (SELECT COUNT(*) FROM visible_questions WHERE conversation_id=c.id) turn_count,
    (SELECT MAX(updated_at) FROM visible_questions WHERE conversation_id=c.id) updated_at,
    (SELECT MIN(archived) FROM visible_questions WHERE conversation_id=c.id) archived
    FROM conversations c JOIN projects p ON p.id=c.project_id JOIN users u ON u.id=c.user_id`;
  const conversationVisibility = `EXISTS(SELECT 1 FROM visible_questions WHERE conversation_id=c.id) AND ` + (portal === 'client' ? `c.user_id=? AND EXISTS(SELECT 1 FROM grants g JOIN projects ap ON ap.id=g.project_id WHERE g.user_id=c.user_id AND g.project_id=c.project_id AND ap.enabled=1)` : '1=1');
  const conversationSummary = (row: any, turns: any[] = []) => ({ id: row.id, projectId: row.project_id, projectName: row.project_name, username: row.username, title: row.title, titleTurnIndex: row.title_turn_index, latestQuestion: row.latest_question, latestVisibleTurnIndex: row.latest_visible_turn_index, followupCount: row.followup_count, turnPreviews: turns.map(q => ({ id: q.id, turnIndex: q.turn_index, question: q.question, status: q.status })), status: row.status, latestTurnId: row.latest_turn_id, turnCount: row.turn_count, createdAt: row.created_at, updatedAt: row.updated_at, archived: !!row.archived });
  app.get('/api/conversations', async request => {
    const query = z.object({ page: z.coerce.number().int().min(1).max(10000).default(1), status: z.enum(['', 'pending_question_review', 'queued', 'running', 'pending_answer_review', 'answered', 'rejected', 'failed', 'cancelled']).optional() }).parse(request.query);
    const params = portal === 'client' ? [usernameOf(request).id, usernameOf(request).id] : [usernameOf(request).id];
    let visibility = conversationVisibility;
    if (query.status) { visibility += ' AND (SELECT status FROM questions WHERE conversation_id=c.id ORDER BY turn_index DESC LIMIT 1)=?'; params.push(query.status); }
    const total = (store.db.prepare(`${visibleQuestions} SELECT COUNT(*) count FROM conversations c WHERE ${visibility}`).get(...params) as any).count;
    const rows = store.db.prepare(`${conversationSelect} WHERE ${visibility} ORDER BY updated_at DESC,c.id LIMIT 30 OFFSET ?`).all(...params, (query.page - 1) * 30);
    const turnGroups = new Map<string, any[]>();
    if (rows.length) {
      const ids = rows.map((row: any) => row.id);
      // Fetch each visible turn once for this page; never include deleted text or drafts.
      const turns = store.db.prepare(`${visibleQuestions} SELECT id,conversation_id,turn_index,question,status FROM visible_questions WHERE conversation_id IN (${ids.map(() => '?').join(',')}) ORDER BY turn_index`).all(usernameOf(request).id, ...ids);
      for (const turn of turns as any[]) { const group = turnGroups.get(turn.conversation_id) ?? []; group.push(turn); turnGroups.set(turn.conversation_id, group); }
    }
    return { items: rows.map((row: any) => conversationSummary(row, turnGroups.get(row.id))), total, page: query.page };
  });
  app.get('/api/conversations/:id', async request => {
    const params = portal === 'client' ? [usernameOf(request).id, usernameOf(request).id] : [usernameOf(request).id];
    const row = store.db.prepare(`${conversationSelect} WHERE ${conversationVisibility} AND c.id=?`).get(...params, (request.params as any).id) as any;
    if (!row) fail(404, '对话不存在');
    const questions = store.db.prepare(`${visibleQuestions} SELECT q.*,p.name project_name,u.username FROM visible_questions q JOIN projects p ON p.id=q.project_id JOIN users u ON u.id=q.user_id WHERE q.conversation_id=? ORDER BY q.turn_index`).all(usernameOf(request).id, row.id);
    return { ...conversationSummary(row, questions), questions: questions.map(present) };
  });
  app.get('/api/questions/:id', async request => {
    const q = getQuestion((request.params as any).id, request);
    return present(q);
  });
  if (portal === 'client') app.post('/api/questions', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async request => {
    const body = z.object({ projectId: z.string().uuid(), question: z.string().trim().min(2).max(4000), conversationId: z.string().uuid().optional(), latestTurnId: z.string().uuid().optional() }).refine(value => !!value.conversationId === !!value.latestTurnId, { message: '追问必须同时提供对话与最新轮次' }).parse(request.body);
    const id = randomUUID(), now = new Date().toISOString();
    store.transaction(() => {
      if (!store.db.prepare('SELECT 1 FROM projects p JOIN grants g ON g.project_id=p.id WHERE p.id=? AND g.user_id=? AND p.enabled=1').get(body.projectId, usernameOf(request).id)) fail(403, '没有项目权限');
      if (store.db.prepare("SELECT 1 FROM questions WHERE user_id=? AND status IN ('pending_question_review','queued','running','pending_answer_review')").get(usernameOf(request).id)) fail(409, '请等待当前问题完成后再提交');
      if ((store.db.prepare("SELECT COUNT(*) count FROM questions WHERE status IN ('pending_question_review','queued','running','pending_answer_review')").get() as any).count >= 100) fail(429, '待处理队列已满，请稍后再试');
      const conversationId = body.conversationId ?? randomUUID();
      let turnIndex = 1;
      let parentQuestionId: string | null = null;
      if (body.conversationId) {
        const conversation = store.db.prepare('SELECT * FROM conversations c WHERE id=? AND user_id=? AND EXISTS(SELECT 1 FROM questions q WHERE q.conversation_id=c.id AND NOT EXISTS(SELECT 1 FROM question_deletions d WHERE d.question_id=q.id AND d.user_id=?))').get(body.conversationId, usernameOf(request).id, usernameOf(request).id) as any;
        if (!conversation) fail(404, '对话不存在');
        if (conversation.project_id !== body.projectId) fail(409, '追问不能更换对话项目');
        const latest = store.db.prepare('SELECT id,turn_index,status FROM questions WHERE conversation_id=? ORDER BY turn_index DESC LIMIT 1').get(conversationId) as any;
        if (!latest || latest.id !== body.latestTurnId) fail(409, '对话最新轮次已经变更，请刷新后重试');
        if (!['answered','rejected','failed','cancelled'].includes(latest.status)) fail(409, '请等待当前轮次完成后再追问');
        turnIndex = latest.turn_index + 1;
        parentQuestionId = latest.id;
      }
      const turns = store.db.prepare("SELECT id questionId,turn_index turnIndex,question,answer FROM questions WHERE conversation_id=? AND status='answered' ORDER BY turn_index").all(conversationId) as any[];
      const snapshot = contextSnapshotSchema.parse({ formatVersion: 1, sourceIds: turns.map(turn => turn.questionId), turns });
      const settings = store.settings();
      try { validatePromptInput(renderQuestionInput(body.question, snapshot), settings.extraPrompt, settings.claudePath, settings.fixedPrompt); }
      catch (error) { fail(413, error instanceof Error ? error.message : '对话上下文过长，请开启新对话'); }
      if (!body.conversationId) store.db.prepare('INSERT INTO conversations(id,user_id,project_id,created_at) VALUES(?,?,?,?)').run(conversationId, usernameOf(request).id, body.projectId, now);
      store.db.prepare('INSERT INTO questions(id,user_id,project_id,question,status,created_at,updated_at,conversation_id,turn_index,parent_question_id,context_snapshot) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(id, usernameOf(request).id, body.projectId, body.question, 'pending_question_review', now, now, conversationId, turnIndex, parentQuestionId, JSON.stringify(snapshot));
      store.audit(usernameOf(request).id, 'submit', id);
    }); service.notify(); return present(getQuestion(id, request));
  });
  app.get('/api/events', async (request, reply) => {
    if (service.listeners.size >= 100) fail(429, '实时连接已满');
    const user = usernameOf(request); const sessionHash = digest(request.cookies[cookieName] ?? '');
    if ((eventCounts.get(user.id) ?? 0) >= 3) fail(429, '此账号的实时连接已满，请关闭多余页面');
    eventCounts.set(user.id, (eventCounts.get(user.id) ?? 0) + 1);
    reply.hijack(); reply.raw.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    eventSockets.add(reply.raw);
    let closed = false;
    const update = (heartbeat = false) => {
      if (closed) return;
      const valid = store.db.prepare('SELECT 1 FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=? AND s.expires>? AND u.enabled=1').get(sessionHash, Date.now());
      if (!valid) { reply.raw.end(); return; }
      if (reply.raw.writableLength > 64_000) { reply.raw.end(); return; }
      reply.raw.write(heartbeat ? ': heartbeat\n\n' : `data: ${JSON.stringify({ type: 'refresh' })}\n\n`);
    };
    service.listeners.add(update); update();
    const interval = setInterval(() => update(true), 15000);
    request.raw.on('close', () => { closed = true; clearInterval(interval); service.listeners.delete(update); eventSockets.delete(reply.raw); const remaining = (eventCounts.get(user.id) ?? 1) - 1; if (remaining > 0) eventCounts.set(user.id, remaining); else eventCounts.delete(user.id); });
    void user;
  });
  if (portal === 'admin') {
    app.get('/api/stats', async () => {
      const count = (status: string) => (store.db.prepare('SELECT COUNT(*) count FROM questions WHERE status=?').get(status) as any).count;
      return { pendingQuestions: count('pending_question_review'), pendingAnswers: count('pending_answer_review'), running: count('running'), queued: count('queued'), total: (store.db.prepare('SELECT COUNT(*) count FROM questions').get() as any).count };
    });
    app.post('/api/questions/:id/:action', { bodyLimit: 128 * 1024 }, async request => {
      const { id, action } = request.params as any; const body = (request.body ?? {}) as any;
      const q = getQuestion(id, request); const now = new Date().toISOString();
      if (action === 'cancel' && q.status === 'running') { const current = service.current; if (current && current.questionId === id) current.controller.abort(); return { ok: true }; }
      store.transaction(() => {
        if (action === 'approve') {
          if (q.status === 'queued' || q.status === 'running') return;
          if (q.status !== 'pending_question_review') fail(409, '问题状态已经变更');
          store.db.prepare("UPDATE questions SET status='queued',updated_at=? WHERE id=? AND status='pending_question_review'").run(now, id);
        } else if (action === 'publish') {
          const answer = z.string().trim().min(1).max(20000).parse(body.answer);
          validateBusinessAnswer(answer);
          if (q.status === 'answered' && q.answer === answer) return;
          if (q.status !== 'pending_answer_review') fail(409, '回答状态已经变更');
          store.db.prepare("UPDATE questions SET status='answered',answer=?,updated_at=? WHERE id=? AND status='pending_answer_review'").run(answer, now, id);
          const run = store.db.prepare("SELECT session_id,input_snapshot FROM runs WHERE question_id=? AND status='completed' ORDER BY started_at DESC,rowid DESC LIMIT 1").get(id) as any;
          if (run?.session_id && z.string().uuid().safeParse(run.session_id).success) {
            const input = JSON.parse(run.input_snapshot ?? '{}');
            if (typeof input.projectPath === 'string') store.db.prepare('UPDATE conversations SET claude_session_id=?,claude_session_path=? WHERE id=?').run(run.session_id, input.projectPath, q.conversation_id);
          }
        } else if (action === 'reject') {
          if (!['pending_question_review','pending_answer_review'].includes(q.status)) fail(409, '此问题当前不能拒绝');
          const reason = z.string().trim().min(1).max(1000).parse(body.reason ?? '管理员拒绝');
          store.db.prepare("UPDATE questions SET status='rejected',error=?,updated_at=? WHERE id=?").run(reason, now, id);
        } else if (action === 'cancel') {
          if (!activeStates.includes(q.status)) fail(409, '此问题已结束');
          store.db.prepare("UPDATE questions SET status='cancelled',updated_at=? WHERE id=?").run(now, id);
        } else if (action === 'retry') {
          if (!['failed','cancelled'].includes(q.status)) fail(409, '只有失败或取消的问题可重试');
          if (store.db.prepare("SELECT 1 FROM questions WHERE user_id=? AND id<>? AND status IN ('pending_question_review','queued','running','pending_answer_review')").get(q.user_id, id)) fail(409, '用户已经有其他未完成问题');
          if (q.conversation_id && (store.db.prepare('SELECT id FROM questions WHERE conversation_id=? ORDER BY turn_index DESC LIMIT 1').get(q.conversation_id) as any)?.id !== id) fail(409, '只有对话最新的失败或取消轮次可重试');
          store.db.prepare("UPDATE questions SET status='pending_question_review',draft_answer=NULL,error=NULL,archived=0,updated_at=? WHERE id=?").run(now, id);
        } else if (action === 'archive') {
          if (activeStates.includes(q.status)) fail(409, '不能归档正在处理的问题');
          store.db.prepare('UPDATE questions SET archived=1,updated_at=? WHERE id=?').run(now, id);
        } else fail(404, '操作不存在');
        store.audit(usernameOf(request).id, action, id);
      }); service.notify(); service.tick(); return { ok: true };
    });
    app.get('/api/users', async () => store.db.prepare("SELECT id,username,enabled FROM users WHERE role='client' ORDER BY created_at DESC").all().map((u: any) => ({ ...u, enabled: !!u.enabled, projectIds: store.db.prepare('SELECT project_id FROM grants WHERE user_id=?').all(u.id).map((g: any) => g.project_id) })));
    const grants = (id: string, ids: string[]) => { store.db.prepare('DELETE FROM grants WHERE user_id=?').run(id); for (const p of ids) { if (!store.db.prepare('SELECT 1 FROM projects WHERE id=?').get(p)) fail(400, '项目不存在'); store.db.prepare('INSERT INTO grants VALUES(?,?)').run(id, p); } };
    app.post('/api/users', async request => {
      const body = credentials.extend({ projectIds: z.array(z.string().uuid()).max(100).default([]) }).parse(request.body); const id = randomUUID(), password = await hashPassword(body.password);
      store.transaction(() => { store.db.prepare('INSERT INTO users VALUES(?,?,?,?,1,?)').run(id, body.username, password, 'client', new Date().toISOString()); grants(id, body.projectIds); store.audit(usernameOf(request).id, 'create-user', id); });
      return { id };
    });
    app.post('/api/users/:id', async request => {
      const id = (request.params as any).id;
      const body = z.object({ enabled: z.boolean().optional(), password: z.string().min(1).max(128).optional(), projectIds: z.array(z.string().uuid()).max(100).optional() }).parse(request.body);
      const password = body.password ? await hashPassword(body.password) : undefined;
      store.transaction(() => {
        if (!store.db.prepare("SELECT 1 FROM users WHERE id=? AND role='client'").get(id)) fail(404, '账号不存在');
        if (body.enabled !== undefined) store.db.prepare('UPDATE users SET enabled=? WHERE id=?').run(Number(body.enabled), id);
        if (password) store.db.prepare('UPDATE users SET password=? WHERE id=?').run(password, id);
        if (body.projectIds) grants(id, body.projectIds);
        store.db.prepare("UPDATE questions SET status='cancelled',error='账号、项目或授权已停用',updated_at=? WHERE user_id=? AND status IN ('pending_question_review','queued','pending_answer_review') AND (NOT EXISTS(SELECT 1 FROM users u WHERE u.id=questions.user_id AND u.enabled=1) OR NOT EXISTS(SELECT 1 FROM grants g JOIN projects p ON p.id=g.project_id WHERE g.user_id=questions.user_id AND g.project_id=questions.project_id AND p.enabled=1))").run(new Date().toISOString(), id);
        store.db.prepare('DELETE FROM sessions WHERE user_id=?').run(id); store.audit(usernameOf(request).id, 'update-user', id);
      });
      if (service.current) { const q = store.db.prepare('SELECT user_id,project_id FROM questions WHERE id=?').get(service.current.questionId) as any; if (q?.user_id === id && (body.enabled === false || (body.projectIds && !body.projectIds.includes(q.project_id)))) service.current.controller.abort(); }
      service.notify(); return { ok: true };
    });
    const projectSchema = z.object({ name: z.string().trim().min(1).max(100), description: z.string().max(500).default(''), path: z.string().min(1).max(500), enabled: z.boolean().optional() });
    app.post('/api/projects', async request => {
      const body = projectSchema.parse(request.body), id = randomUUID(), path = projectPath(body.path);
      store.transaction(() => { store.db.prepare('INSERT INTO projects VALUES(?,?,?,?,1)').run(id, body.name, body.description, path); store.audit(usernameOf(request).id, 'create-project', id); }); return { id };
    });
    app.post('/api/projects/:id', async request => {
      const id = (request.params as any).id, body = projectSchema.partial().parse(request.body); const current = store.db.prepare('SELECT * FROM projects WHERE id=?').get(id) as any;
      if (!current) fail(404, '项目不存在');
      store.transaction(() => { store.db.prepare('UPDATE projects SET name=?,description=?,path=?,enabled=? WHERE id=?').run(body.name ?? current.name, body.description ?? current.description, body.path ? projectPath(body.path) : current.path, body.enabled === undefined ? current.enabled : Number(body.enabled), id); if (body.enabled === false) store.db.prepare("UPDATE questions SET status='cancelled',error='项目已停用',updated_at=? WHERE project_id=? AND status IN ('pending_question_review','queued','pending_answer_review')").run(new Date().toISOString(), id); store.audit(usernameOf(request).id, 'update-project', id); });
      if (body.enabled === false && service.current) { const q = store.db.prepare('SELECT project_id FROM questions WHERE id=?').get(service.current.questionId) as any; if (q?.project_id === id) service.current.controller.abort(); }
      service.notify(); return { ok: true };
    });
    app.get('/api/settings/prompt', async () => { const settings = store.settings(); return { fixedPrompt: settings.fixedPrompt, combinedPrompt: buildBusinessPrompt(settings.extraPrompt, settings.fixedPrompt) }; });
    app.get('/api/settings', async () => ({ ...store.settings(), clientError: service.clientError }));
    app.post('/api/settings', async request => {
      const currentSettings = store.settings();
      const settings = settingsSchema.parse(request.body);
      if (!Object.hasOwn(request.body as object, 'fixedPrompt')) settings.fixedPrompt = currentSettings.fixedPrompt;
      if (!Object.hasOwn(request.body as object, 'adminNotificationMode')) settings.adminNotificationMode = store.settings().adminNotificationMode;
      if (settings.adminPort === settings.clientPort) fail(400, '管理端与客户端端口不能相同');
      if (settings.adminPort === 4309 || settings.clientPort === 4309) fail(400, '4309 为本机单实例保护保留端口');
      if (!['127.0.0.1','::1'].includes(settings.clientHost) && !settings.allowInsecureLan) fail(400, '开启内网监听前，请明确确认HTTP风险或配置HTTPS代理');
      store.transaction(() => { store.db.prepare('UPDATE settings SET value=? WHERE id=1').run(JSON.stringify(settings)); store.audit(usernameOf(request).id, 'settings', 'settings'); }); return { ok: true, restartRequired: true };
    });
    app.post('/api/settings/probe', async () => probeClaude(store.settings().claudePath));
    app.get('/api/export', async (_request, reply) => { reply.header('Content-Disposition', 'attachment; filename="desk-history.json"'); return { version: 3, formatVersion: 3, deletions: store.db.prepare('SELECT * FROM question_deletions').all(), conversations: store.db.prepare('SELECT * FROM conversations').all(), exportedAt: new Date().toISOString(), questions: store.db.prepare('SELECT * FROM questions').all(), runs: store.db.prepare('SELECT * FROM runs').all(), audit: store.db.prepare('SELECT * FROM audit').all() }; });
    app.get('/api/backup', async (_request, reply) => {
      const path = join(store.directory, `backup-${randomUUID()}.sqlite`);
      await backup(store.db, path);
      const bytes = readFileSync(path); const { unlinkSync } = await import('node:fs'); unlinkSync(path);
      reply.header('Content-Disposition', 'attachment; filename="desk-backup.sqlite"'); reply.type('application/octet-stream'); return bytes;
    });
    app.get('/api/launcher/events', async request => {
      const supplied = request.headers['x-launcher-token'];
      if (!launcherToken || typeof supplied !== 'string' || digest(supplied) !== digest(launcherToken)) fail(401, '启动器认证失败');
      const count = (status: string) => (store.db.prepare('SELECT COUNT(*) count FROM questions WHERE status=?').get(status) as any).count;
      let clientUrl: string | null = null;
      try { const connection = JSON.parse(readFileSync(join(store.directory, 'connection.json'), 'utf8')); if (connection.pid === process.pid) clientUrl = connection.clientUrl; } catch { /* service may be starting */ }
      const items = store.db.prepare("SELECT id,status,updated_at updatedAt FROM questions WHERE status IN ('pending_question_review','pending_answer_review') ORDER BY updated_at ASC").all();
      return { pendingQuestions: count('pending_question_review'), pendingAnswers: count('pending_answer_review'), clientUrl, adminNotificationMode: store.settings().adminNotificationMode, items };
    });
  }
  const webRoot = resolve('dist/web');
  if (existsSync(join(webRoot, 'index.html'))) {
    await app.register(staticFiles, { root: webRoot, prefix: '/' });
    app.setNotFoundHandler((request, reply) => request.url.startsWith('/api/') ? reply.code(404).send({ message: '接口不存在' }) : reply.sendFile('index.html'));
  }
  return app;
}
