import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../apps/server/src/store.js';
import { Service, type Executor } from '../apps/server/src/service.js';
import { createApp } from '../apps/server/src/app.js';
import { digest } from '../apps/server/src/auth.js';
import { renderQuestionInput, contextSnapshotSchema } from '../apps/server/src/context.js';

test('saved interactive mode survives restart without changing accounts or network settings', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'desk-mode-migration-'));
  const store = new Store(directory);
  const saved = { ...store.settings(), mode: 'visible', clientHost: '192.0.2.123', extraPrompt: '保留业务指令' };
  store.db.prepare('UPDATE settings SET value=? WHERE id=1').run(JSON.stringify(saved));
  store.db.prepare('INSERT INTO users VALUES(?,?,?,?,1,?)').run('retained-admin', 'admin', 'unchanged-password-hash', 'admin', new Date().toISOString());
  store.close();
  const reopened = new Store(directory);
  try {
    assert.deepEqual(reopened.settings(), saved);
    assert.equal((reopened.db.prepare('SELECT password FROM users WHERE id=?').get('retained-admin') as any).password, 'unchanged-password-hash');
  } finally { reopened.close(); await rm(directory, { recursive: true, force: true }); }
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'desk-conversations-'));
  const store = new Store(directory), owner = randomUUID(), other = randomUUID(), admin = randomUUID(), project = randomUUID(), project2 = randomUUID();
  const now = new Date().toISOString();
  for (const [id, role] of [[owner,'client'],[other,'client'],[admin,'admin']]) store.db.prepare('INSERT INTO users VALUES(?,?,?,?,1,?)').run(id, id, 'unused', role, now);
  for (const id of [project,project2]) { store.db.prepare('INSERT INTO projects VALUES(?,?,?,?,1)').run(id, id, '', directory); for (const user of [owner,other]) store.db.prepare('INSERT INTO grants VALUES(?,?)').run(user,id); }
  for (const [user,portal] of [[owner,'client'],[other,'client'],[admin,'admin']]) store.db.prepare('INSERT INTO sessions VALUES(?,?,?,?,?)').run(digest(user),user,portal,'csrf',Date.now()+120000);
  const calls: Parameters<Executor>[0][] = [];
  const service = new Service(store, async options => { calls.push(options); return { answer: 'UNPUBLISHED PRIVATE DRAFT', exitCode: 0 }; });
  const client = await createApp(store,service,'client'), management = await createApp(store,service,'admin');
  let requestIndex = 1;
  const request = (portal: 'client'|'admin', method: 'GET'|'POST', url: string, payload?: object, user = portal === 'admin' ? admin : owner) => (portal === 'admin' ? management : client).inject({method,url,remoteAddress:`127.0.0.${requestIndex++}`,headers:{host:'127.0.0.1',cookie:`desk_${portal}=${user}`,'x-csrf-token':'csrf'},...(payload ? {payload}: {})});
  const submit = (question: string, conversationId?: string, latestTurnId?: string, projectId = project) => request('client','POST','/api/questions',{projectId,question,...(conversationId ? {conversationId,latestTurnId}: {})});
  const action = (id: string, action: string, payload?: object) => request('admin','POST',`/api/questions/${id}/${action}`,payload);
  const complete = async (id: string, answer: string) => { assert.equal((await action(id,'approve')).statusCode,200); await service.current?.promise; await new Promise(resolve => setImmediate(resolve)); assert.equal((await action(id,'publish',{answer})).statusCode,200); };
  return {store,owner,other,project,project2,calls,service,request,submit,action,complete,dispose:async () => { await service.stop(); await client.close(); await management.close(); store.close(); await rm(directory,{recursive:true,force:true}); }};
}

test('conversation replay is frozen published Q/A, independent new turns, isolation and latest retry', async () => {
  const f = await fixture();
  try {
    f.store.db.prepare('UPDATE settings SET value=? WHERE id=1').run(JSON.stringify({ ...f.store.settings(), mode: 'visible' }));
    const first = (await f.submit('First business question')).json();
    assert.equal(first.turnIndex,1); assert.equal(first.parentQuestionId,null);
    await f.complete(first.id,'Administrator edited published answer');
    assert.equal(f.calls[0].question,'First business question');
    assert.equal(f.calls[0].mode,'visible');
    const followed = await f.submit('Followup business question',first.conversationId,first.id);
    assert.equal(followed.statusCode,200,followed.body); const second = followed.json();
    assert.equal(second.turnIndex,2); assert.equal(second.parentQuestionId,first.id);
    const reviewed = (await f.request('admin','GET',`/api/questions/${second.id}`)).json();
    assert.deepEqual(reviewed.contextSnapshot.sourceIds,[first.id]);
    assert.equal(reviewed.contextSnapshot.turns[0].answer,'Administrator edited published answer');
    assert.ok(!JSON.stringify(reviewed.contextSnapshot).includes('UNPUBLISHED'));
    f.store.db.prepare('UPDATE questions SET answer=? WHERE id=?').run('Later mutation must not affect frozen input',first.id);
    await f.complete(second.id,'Second published answer');
    assert.ok(f.calls[1].question.includes('Administrator edited published answer'));
    assert.ok(!f.calls[1].question.includes('Later mutation'));
    const run = f.store.db.prepare('SELECT input_snapshot FROM runs WHERE question_id=?').get(second.id) as any;
    assert.equal(JSON.parse(run.input_snapshot).question,f.calls[1].question);
    const detail = await f.request('client','GET',`/api/conversations/${first.conversationId}`);
    assert.deepEqual(detail.json().questions.map((q: any) => q.turnIndex),[1,2]);
    for (const q of detail.json().questions) { assert.ok(!('draftAnswer' in q)); assert.ok(!('contextSnapshot' in q)); }
    assert.equal((await f.request('client','GET',`/api/conversations/${first.conversationId}`,undefined,f.other)).statusCode,404);
    assert.equal((await f.request('client','POST','/api/questions',{projectId:f.project,question:'Other user attack',conversationId:first.conversationId,latestTurnId:second.id},f.other)).statusCode,404);
    assert.equal((await f.submit('Stale followup',first.conversationId,first.id)).statusCode,409);
    assert.equal((await f.submit('Changed project',first.conversationId,second.id,f.project2)).statusCode,409);
    assert.equal((await f.request('client','POST','/api/questions',{projectId:f.project,question:'Missing parent',conversationId:first.conversationId})).statusCode,400);
    const third = (await f.submit('Independent new question')).json();
    await f.complete(third.id,'Independent answer');
    assert.equal(f.calls[2].question,'Independent new question'); assert.notEqual(third.conversationId,first.conversationId);
    const concurrent = await Promise.all([f.submit('Concurrent followup A',first.conversationId,second.id),f.submit('Concurrent followup B',first.conversationId,second.id)]);
    assert.deepEqual(concurrent.map(r => r.statusCode).sort(),[200,409]);
    const latest = concurrent.find(r => r.statusCode === 200)!.json();
    await f.action(latest.id,'cancel'); await f.action(latest.id,'archive');
    assert.equal((await f.action(latest.id,'retry')).statusCode,200);
    assert.equal((f.store.db.prepare('SELECT archived FROM questions WHERE id=?').get(latest.id) as any).archived,0);
    await f.action(latest.id,'cancel');
    const next = (await f.submit('Continue after cancelled turn',first.conversationId,latest.id)).json();
    assert.equal(next.turnIndex,4); assert.equal((await f.action(latest.id,'retry')).statusCode,409);
    await f.action(next.id,'reject',{reason:'Rejected round'});
    const afterReject = (await f.submit('Continue after rejected turn',first.conversationId,next.id)).json();
    assert.equal(afterReject.turnIndex,5);
    const snapshot = (await f.request('admin','GET',`/api/questions/${afterReject.id}`)).json().contextSnapshot;
    assert.deepEqual(snapshot.sourceIds,[first.id,second.id]);
    const exported = (await f.request('admin','GET','/api/export')).json();
    assert.equal(exported.formatVersion,2); assert.equal(exported.conversations.length,2);
    f.store.db.prepare('DELETE FROM grants WHERE user_id=?').run(f.owner);
    assert.equal((await f.request('client','GET','/api/conversations')).json().total,0);
    assert.equal((await f.request('client','GET',`/api/conversations/${first.conversationId}`)).statusCode,404);
    assert.equal((await f.submit('Revoked followup',first.conversationId,afterReject.id)).statusCode,403);
  } finally { await f.dispose(); }
});

test('cleanup retains entire conversation until every round is archived terminal and old', async () => {
  const f = await fixture();
  try {
    const first = (await f.submit('Cleanup first question')).json(); await f.action(first.id,'reject');
    const second = (await f.submit('Cleanup second question',first.conversationId,first.id)).json(); await f.action(second.id,'cancel');
    const before = '2024-01-01T00:00:00.000Z';
    f.store.db.prepare('UPDATE questions SET created_at=? WHERE conversation_id=?').run('2023-01-01T00:00:00.000Z',first.conversationId);
    await f.action(first.id,'archive');
    const preview = () => f.request('admin','POST','/api/cleanup/preview',{before});
    assert.equal((await preview()).json().count,0);
    await f.action(second.id,'archive'); assert.equal((await preview()).json().count,2);
    f.store.db.prepare('UPDATE questions SET created_at=? WHERE id=?').run(before,second.id);
    assert.equal((await preview()).json().count,0);
    f.store.db.prepare('UPDATE questions SET created_at=? WHERE id=?').run('2023-01-01T00:00:00.000Z',second.id);
    assert.equal((await f.request('admin','POST','/api/cleanup',{before,confirmation:'DELETE',expectedCount:1})).statusCode,409);
    const deleted = await f.request('admin','POST','/api/cleanup',{before,confirmation:'DELETE',expectedCount:2});
    assert.equal(deleted.statusCode,200,deleted.body);
    assert.equal((f.store.db.prepare('SELECT COUNT(*) n FROM conversations').get() as any).n,0);
    assert.deepEqual(f.store.db.prepare('PRAGMA foreign_key_check').all(),[]);
  } finally { await f.dispose(); }
});

test('context schema rejects wrong sources; oversized replay is rejected without partial conversation turn', async () => {
  assert.equal(renderQuestionInput('original question',{formatVersion:1,sourceIds:[],turns:[]}),'original question');
  assert.throws(() => contextSnapshotSchema.parse({formatVersion:1,sourceIds:[randomUUID()],turns:[]}));
  const f = await fixture();
  try {
    const first = (await f.submit('Long history first question')).json(); await f.action(first.id,'reject');
    f.store.db.prepare("UPDATE questions SET status='answered',answer=? WHERE id=?").run('汉'.repeat(40000),first.id);
    const rejected = await f.submit('Long history followup',first.conversationId,first.id);
    assert.equal(rejected.statusCode,413,rejected.body); assert.match(rejected.json().message,/对话|输入|长|上限/);
    assert.equal((f.store.db.prepare('SELECT COUNT(*) n FROM questions').get() as any).n,1);
  } finally { await f.dispose(); }
});

test('revoked pending work and disabled project review release the global active slot without execution', async () => {
  const f = await fixture();
  try {
    const first = (await f.submit('Pending revoked project question')).json();
    assert.equal((await f.request('admin','POST',`/api/users/${f.owner}`,{projectIds:[f.project2]})).statusCode,200);
    assert.equal((f.store.db.prepare('SELECT status FROM questions WHERE id=?').get(first.id) as any).status,'cancelled');
    // Grant update intentionally invalidates sessions; seed a fresh test session like a new login.
    f.store.db.prepare('INSERT INTO sessions VALUES(?,?,?,?,?)').run(digest(f.owner),f.owner,'client','csrf',Date.now()+120000);
    const secondResponse = await f.submit('Other authorized project question',undefined,undefined,f.project2);
    assert.equal(secondResponse.statusCode,200,secondResponse.body);
    const second = secondResponse.json();
    await f.action(second.id,'approve'); await f.service.current?.promise; await new Promise(resolve => setImmediate(resolve));
    assert.equal((f.store.db.prepare('SELECT status FROM questions WHERE id=?').get(second.id) as any).status,'pending_answer_review');
    assert.equal((await f.request('admin','POST',`/api/projects/${f.project2}`,{enabled:false})).statusCode,200);
    assert.equal((f.store.db.prepare('SELECT status FROM questions WHERE id=?').get(second.id) as any).status,'cancelled');
    assert.equal(f.calls.length,1);
    assert.equal((await f.request('admin','POST',`/api/projects/${f.project2}`,{enabled:true})).statusCode,200);
    assert.equal((await f.submit('New authorized question',undefined,undefined,f.project2)).statusCode,200);
  } finally { await f.dispose(); }
});

test('synchronous input validation failure releases queue slot and later work still executes', async () => {
  const f = await fixture();
  try {
    const first = (await f.submit('Invalid frozen context question')).json();
    const secondResponse = await f.request('client','POST','/api/questions',{projectId:f.project,question:'Second customer question'},f.other);
    assert.equal(secondResponse.statusCode,200); const second = secondResponse.json();
    f.store.db.prepare("UPDATE questions SET status='queued' WHERE id IN (?,?)").run(first.id,second.id);
    f.store.db.prepare('UPDATE questions SET context_snapshot=? WHERE id=?').run('{invalid JSON',first.id);
    f.service.tick();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal((f.store.db.prepare('SELECT status FROM questions WHERE id=?').get(first.id) as any).status,'failed');
    await f.service.current?.promise; await new Promise(resolve => setImmediate(resolve));
    assert.equal((f.store.db.prepare('SELECT status FROM questions WHERE id=?').get(second.id) as any).status,'pending_answer_review');
    assert.equal(f.calls.length,1); assert.equal(f.service.current,undefined);
  } finally { await f.dispose(); }
});

test('legacy v1 migration preserves all rows and creates independent first turns; future schema rejected', async () => {
  const directory = await mkdtemp(join(tmpdir(),'desk-migrate-'));
  let store: Store | undefined;
  try {
    const db = new DatabaseSync(join(directory,'desk.sqlite'));
    db.exec(`CREATE TABLE users(id TEXT PRIMARY KEY,username TEXT,password TEXT,role TEXT,enabled INTEGER,created_at TEXT);
      CREATE TABLE projects(id TEXT PRIMARY KEY,name TEXT,description TEXT,path TEXT,enabled INTEGER);
      CREATE TABLE questions(id TEXT PRIMARY KEY,user_id TEXT,project_id TEXT,question TEXT,status TEXT,draft_answer TEXT,answer TEXT,error TEXT,archived INTEGER,created_at TEXT,updated_at TEXT);
      CREATE TABLE runs(id TEXT PRIMARY KEY,question_id TEXT,status TEXT,started_at TEXT,ended_at TEXT,exit_code INTEGER,logs TEXT,session_id TEXT,cost_usd REAL,error TEXT);
      CREATE TABLE settings(id INTEGER PRIMARY KEY,value TEXT); CREATE TABLE audit(id TEXT PRIMARY KEY,actor TEXT,action TEXT,target TEXT,created_at TEXT); PRAGMA user_version=1;`);
    const owner = randomUUID(), project = randomUUID(), q1 = randomUUID(), q2 = randomUUID();
    db.prepare('INSERT INTO users VALUES(?,?,?,?,?,?)').run(owner,'Legacy customer','password','client',1,'2020');
    db.prepare('INSERT INTO projects VALUES(?,?,?,?,?)').run(project,'Legacy project','Description',directory,1);
    for (const id of [q1,q2]) db.prepare('INSERT INTO questions VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(id,owner,project,'Legacy question','answered','Private draft','Published','Error',1,'2020','2021');
    db.prepare('INSERT INTO runs VALUES(?,?,?,?,?,?,?,?,?,?)').run('run',q1,'completed','2020','2021',0,'logs','session',0.1,null);
    db.prepare('INSERT INTO settings VALUES(1,?)').run(JSON.stringify({extraPrompt:'Preserved settings'}));
    db.prepare('INSERT INTO audit VALUES(?,?,?,?,?)').run('audit',owner,'legacy',q1,'2020'); db.close();
    store = new Store(directory);
    const rows = store.db.prepare('SELECT * FROM questions').all() as any[];
    assert.equal(rows.length,2); assert.notEqual(rows[0].conversation_id,rows[1].conversation_id);
    for (const q of rows) { assert.equal(q.turn_index,1); assert.equal(q.parent_question_id,null); assert.equal(q.answer,'Published'); assert.equal(q.draft_answer,'Private draft'); }
    assert.equal(store.settings().extraPrompt,'Preserved settings'); assert.equal((store.db.prepare('SELECT logs FROM runs').get() as any).logs,'logs');
    assert.equal((store.db.prepare('SELECT COUNT(*) n FROM audit').get() as any).n,1);
    const snapshot = rows.map(q => q.conversation_id); store.close(); store = new Store(directory);
    assert.deepEqual((store.db.prepare('SELECT conversation_id FROM questions ORDER BY rowid').all() as any[]).map(q => q.conversation_id),snapshot);
    store.db.exec('PRAGMA user_version=3'); store.close(); store = undefined;
    assert.throws(() => new Store(directory),/高于当前支持版本/);
    const future = new DatabaseSync(join(directory,'desk.sqlite')); assert.equal((future.prepare('PRAGMA user_version').get() as any).user_version,3); future.close();
  } finally { store?.close(); await rm(directory,{recursive:true,force:true}); }
});
