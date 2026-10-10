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
import { buildBusinessPrompt } from '../apps/server/src/claude/runner.js';

test('saved mode and edited fixed prompt survive restart without changing accounts or network settings', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'desk-mode-migration-'));
  const store = new Store(directory);
  const saved = { ...store.settings(), mode: 'visible', clientHost: '192.0.2.123', fixedPrompt: '保留已修改的固定业务提示词', extraPrompt: '保留业务指令' };
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
  const service = new Service(store, async options => { calls.push(options); return { answer: 'UNPUBLISHED PRIVATE DRAFT', sessionId: options.resumeSessionId ?? randomUUID(), exitCode: 0 }; });
  const client = await createApp(store,service,'client'), management = await createApp(store,service,'admin');
  let requestIndex = 1;
  const request = (portal: 'client'|'admin', method: 'GET'|'POST', url: string, payload?: object, user = portal === 'admin' ? admin : owner) => (portal === 'admin' ? management : client).inject({method,url,remoteAddress:`127.0.0.${requestIndex++}`,headers:{host:'127.0.0.1',cookie:`desk_${portal}=${user}`,'x-csrf-token':'csrf'},...(payload ? {payload}: {})});
  const submit = (question: string, conversationId?: string, latestTurnId?: string, projectId = project) => request('client','POST','/api/questions',{projectId,question,...(conversationId ? {conversationId,latestTurnId}: {})});
  const action = (id: string, action: string, payload?: object) => request('admin','POST',`/api/questions/${id}/${action}`,payload);
  const complete = async (id: string, answer: string) => { assert.equal((await action(id,'approve')).statusCode,200); await service.current?.promise; await new Promise(resolve => setImmediate(resolve)); assert.equal((await action(id,'publish',{answer})).statusCode,200); };
  return {store,owner,other,admin,project,project2,calls,service,request,submit,action,complete,dispose:async () => { await service.stop(); await client.close(); await management.close(); store.close(); await rm(directory,{recursive:true,force:true}); }};
}

test('conversation replay is frozen published Q/A, independent new turns, isolation and latest retry', async () => {
  const f = await fixture();
  try {
    const initialPrompt = 'INITIAL SAVED FIXED BUSINESS PROMPT';
    const updatedPrompt = 'UPDATED FIXED BUSINESS PROMPT FOR NEW CALLS';
    assert.equal((await f.request('admin','POST','/api/settings',{ ...f.store.settings(), mode: 'visible', fixedPrompt: initialPrompt, extraPrompt: 'EXTRA BUSINESS CONTEXT' })).statusCode,200);
    const first = (await f.submit('First business question')).json();
    assert.equal(first.turnIndex,1); assert.equal(first.parentQuestionId,null);
    await f.complete(first.id,'Administrator edited published answer');
    assert.equal(f.calls[0].question,'First business question');
    assert.equal(f.calls[0].mode,'visible');
    assert.equal(f.calls[0].fixedPrompt,initialPrompt);
    const initialRun = f.store.db.prepare('SELECT session_id,input_snapshot FROM runs WHERE question_id=?').get(first.id) as any;
    assert.equal(JSON.parse(initialRun.input_snapshot).systemPrompt,buildBusinessPrompt('EXTRA BUSINESS CONTEXT',initialPrompt));
    assert.equal((await f.request('admin','POST','/api/settings',{ ...f.store.settings(), fixedPrompt: updatedPrompt })).statusCode,200);
    const followed = await f.submit('Followup business question',first.conversationId,first.id);
    assert.equal(followed.statusCode,200,followed.body); const second = followed.json();
    assert.equal(second.turnIndex,2); assert.equal(second.parentQuestionId,first.id);
    const reviewed = (await f.request('admin','GET',`/api/questions/${second.id}`)).json();
    assert.deepEqual(reviewed.contextSnapshot.sourceIds,[first.id]);
    assert.equal(reviewed.contextSnapshot.turns[0].answer,'Administrator edited published answer');
    assert.ok(!JSON.stringify(reviewed.contextSnapshot).includes('UNPUBLISHED'));
    f.store.db.prepare('UPDATE questions SET answer=? WHERE id=?').run('Later mutation must not affect frozen input',first.id);
    await f.complete(second.id,'Second published answer');
    assert.equal(f.calls[1].fixedPrompt,updatedPrompt);
    assert.equal(f.calls[1].resumeSessionId,initialRun.session_id, 'editing the prompt retains the published conversation session');
    assert.ok(f.calls[1].question.includes('Administrator edited published answer'));
    assert.ok(!f.calls[1].question.includes('Later mutation'));
    const run = f.store.db.prepare('SELECT input_snapshot FROM runs WHERE question_id=?').get(second.id) as any;
    assert.equal(JSON.parse(run.input_snapshot).question,f.calls[1].question);
    assert.equal(JSON.parse(run.input_snapshot).fixedPrompt,updatedPrompt);
    assert.equal(JSON.parse(run.input_snapshot).systemPrompt,buildBusinessPrompt('EXTRA BUSINESS CONTEXT',updatedPrompt));
    assert.ok(JSON.parse(run.input_snapshot).systemPrompt.startsWith('【业务问答只读规则】'), 'resumed followups must receive the current read-only question guidance');
    assert.equal(JSON.parse((f.store.db.prepare('SELECT input_snapshot FROM runs WHERE question_id=?').get(first.id) as any).input_snapshot).fixedPrompt,initialPrompt);
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
    assert.equal(f.calls[2].fixedPrompt,updatedPrompt);
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
    assert.equal(exported.formatVersion,4); assert.equal(exported.conversations.length,2);
    f.store.db.prepare('DELETE FROM grants WHERE user_id=?').run(f.owner);
    assert.equal((await f.request('client','GET','/api/conversations')).json().total,0);
    assert.equal((await f.request('client','GET',`/api/conversations/${first.conversationId}`)).statusCode,404);
    assert.equal((await f.submit('Revoked followup',first.conversationId,afterReject.id)).statusCode,403);
  } finally { await f.dispose(); }
});

async function removeHistory(f: Awaited<ReturnType<typeof fixture>>, portal: 'admin' | 'client', selection: object, user?: string) {
  const response = await f.request(portal, 'POST', '/api/history/delete/preview', selection, user);
  assert.equal(response.statusCode, 200, response.body);
  const preview = response.json();
  return f.request(portal, 'POST', '/api/history/delete', { selection, before: preview.before, expectedCount: preview.count }, user);
}

test('history groups followups once, filters by the latest status and never previews a viewer-deleted turn', async () => {
  const f = await fixture();
  try {
    const first = (await f.submit('Original shared business question')).json(); await f.complete(first.id, 'First published answer');
    const second = (await f.submit('Second followup question', first.conversationId, first.id)).json(); await f.complete(second.id, 'Second published answer');
    const third = (await f.submit('Third followup question', first.conversationId, second.id)).json();
    for (const portal of ['admin', 'client'] as const) {
      const pending = (await f.request(portal, 'GET', '/api/conversations?status=pending_question_review')).json();
      assert.equal(pending.total, 1); assert.equal(pending.items[0].turnCount, 3);
      assert.deepEqual(pending.items[0].turnPreviews, [
        { id: first.id, turnIndex: 1, question: first.question, status: 'answered' },
        { id: second.id, turnIndex: 2, question: second.question, status: 'answered' },
        { id: third.id, turnIndex: 3, question: third.question, status: 'pending_question_review' },
      ]);
      assert.equal((await f.request(portal, 'GET', '/api/conversations?status=answered')).json().total, 0);
      assert.equal((await f.request(portal, 'GET', '/api/conversations?status=unknown')).statusCode, 400);
    }
    assert.equal((await f.action(third.id, 'approve')).statusCode, 200);
    await f.service.current?.promise; await new Promise(resolve => setImmediate(resolve));
    for (const portal of ['admin', 'client'] as const) {
      const awaiting = (await f.request(portal, 'GET', '/api/conversations')).json().items[0];
      assert.equal(awaiting.status, 'pending_answer_review');
      assert.deepEqual(awaiting.turnPreviews.map((q: any) => q.status), ['answered', 'answered', 'pending_answer_review']);
      assert.ok(!JSON.stringify(awaiting).includes('UNPUBLISHED PRIVATE DRAFT'));
    }
    assert.equal((await f.action(third.id, 'publish', { answer: 'Third published answer' })).statusCode, 200);
    const unrelated = (await f.submit(first.question)).json(); await f.action(unrelated.id, 'reject');
    const foreign = (await f.request('client', 'POST', '/api/questions', { projectId: f.project, question: first.question }, f.other)).json();
    const own = (await f.request('client', 'GET', '/api/conversations')).json();
    assert.equal(own.total, 2); assert.equal(own.items.filter((c: any) => c.id === first.conversationId).length, 1);
    assert.equal((await f.request('admin', 'GET', '/api/conversations')).json().total, 3);
    assert.deepEqual((await f.request('client', 'GET', '/api/conversations', undefined, f.other)).json().items.map((c: any) => c.id), [foreign.conversationId]);
    const original = (await f.request('client', 'GET', '/api/conversations?status=answered')).json().items[0];
    assert.equal(original.title, first.question); assert.equal(original.titleTurnIndex, 1);
    assert.equal(original.latestQuestion, third.question); assert.equal(original.latestVisibleTurnIndex, 3);
    assert.equal(original.turnCount, 3); assert.equal(original.followupCount, 2);
    assert.deepEqual(original.turnPreviews.map((q: any) => q.status), ['answered', 'answered', 'answered']);
    assert.ok(!JSON.stringify(original).includes('UNPUBLISHED PRIVATE DRAFT'));
    assert.equal((await removeHistory(f, 'client', { questionIds: [first.id, third.id] })).statusCode, 200);
    const visible = (await f.request('client', 'GET', '/api/conversations?status=answered')).json().items[0];
    assert.equal(visible.title, second.question); assert.equal(visible.titleTurnIndex, 2);
    assert.equal(visible.latestQuestion, second.question); assert.equal(visible.latestVisibleTurnIndex, 2);
    assert.equal(visible.latestTurnId, third.id); assert.equal(visible.turnCount, 1); assert.equal(visible.followupCount, 1);
    assert.deepEqual(visible.turnPreviews, [{ id: second.id, turnIndex: 2, question: second.question, status: 'answered' }]);
    assert.ok(!JSON.stringify(visible).includes(first.question)); assert.ok(!JSON.stringify(visible).includes(third.question));
    const admin = (await f.request('admin', 'GET', '/api/conversations?status=answered')).json().items[0];
    assert.equal(admin.title, first.question); assert.equal(admin.latestQuestion, third.question); assert.equal(admin.turnCount, 3);
    assert.deepEqual(admin.turnPreviews.map((q: any) => q.id), [first.id, second.id, third.id]);
  } finally { await f.dispose(); }
});

test('conversation pagination counts conversations instead of their individual turns', async () => {
  const f = await fixture();
  try {
    for (let index = 0; index < 31; index++) {
      const conversation = randomUUID(), first = randomUUID(), second = randomUUID();
      const now = new Date(Date.UTC(2026, 9, 1, 0, index)).toISOString();
      f.store.db.prepare('INSERT INTO conversations(id,user_id,project_id,created_at) VALUES(?,?,?,?)').run(conversation, f.owner, f.project, now);
      const insert = f.store.db.prepare('INSERT INTO questions(id,user_id,project_id,question,status,answer,created_at,updated_at,conversation_id,turn_index,parent_question_id,context_snapshot) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)');
      const context = JSON.stringify({ formatVersion: 1, sourceIds: [], turns: [] });
      insert.run(first, f.owner, f.project, 'Original question ' + index, 'answered', 'Published answer', now, now, conversation, 1, null, context);
      insert.run(second, f.owner, f.project, 'Followup question ' + index, 'answered', 'Published answer', now, now, conversation, 2, first, context);
    }
    for (const portal of ['admin', 'client'] as const) {
      const first = (await f.request(portal, 'GET', '/api/conversations?page=1')).json();
      const second = (await f.request(portal, 'GET', '/api/conversations?page=2')).json();
      assert.equal(first.total, 31); assert.equal(first.items.length, 30); assert.equal(second.items.length, 1);
      assert.equal(new Set([...first.items, ...second.items].map(c => c.id)).size, 31);
      assert.ok(first.items.every((c: any) => c.turnCount === 2 && c.followupCount === 1));
      assert.equal(first.items[0].title, 'Original question 30'); assert.equal(second.items[0].title, 'Original question 0');
    }
  } finally { await f.dispose(); }
});

test('single and batch history deletion are private to each viewer and cannot delete another client history', async () => {
  const f = await fixture();
  try {
    const first = (await f.submit('First private question')).json(); await f.complete(first.id, 'First approved answer');
    const second = (await f.submit('Second private question', first.conversationId, first.id)).json(); await f.complete(second.id, 'Second approved answer');
    const third = (await f.submit('Other conversation')).json(); await f.action(third.id, 'reject');
    assert.equal((await removeHistory(f, 'client', { questionIds: [first.id] })).statusCode, 200);
    assert.equal((await f.request('client', 'GET', '/api/questions')).json().total, 2);
    assert.equal((await f.request('client', 'GET', '/api/questions/' + first.id)).statusCode, 404);
    const remaining = (await f.request('client', 'GET', '/api/conversations/' + first.conversationId)).json();
    assert.equal(remaining.title, second.question); assert.equal(remaining.turnCount, 1); assert.equal(remaining.questions[0].turnIndex, 2);
    assert.equal((await f.request('admin', 'GET', '/api/questions/' + first.id)).statusCode, 200);
    assert.equal((await f.request('client', 'POST', '/api/history/delete/preview', { questionIds: [second.id] }, f.other)).statusCode, 404);
    assert.equal((await f.request('client', 'POST', '/api/history/delete/preview', { conversationIds: [first.conversationId] }, f.other)).statusCode, 404);
    assert.equal((await removeHistory(f, 'admin', { questionIds: [first.id, second.id, second.id] })).json().deleted, 2);
    assert.equal((await f.request('admin', 'GET', '/api/conversations/' + first.conversationId)).statusCode, 404);
    const otherAdmin = randomUUID();
    f.store.db.prepare('INSERT INTO users VALUES(?,?,?,?,1,?)').run(otherAdmin,otherAdmin,'unused','admin',new Date().toISOString());
    f.store.db.prepare('INSERT INTO sessions VALUES(?,?,?,?,?)').run(digest(otherAdmin),otherAdmin,'admin','csrf',Date.now()+120000);
    assert.equal((await f.request('admin', 'GET', '/api/conversations/' + first.conversationId, undefined, otherAdmin)).json().turnCount, 2);
    assert.equal((await f.request('client', 'GET', '/api/questions/' + second.id)).statusCode, 200);
    assert.equal((f.store.db.prepare('SELECT COUNT(*) n FROM questions').get() as any).n, 3);
    assert.equal((f.store.db.prepare('SELECT COUNT(*) n FROM runs').get() as any).n, 2);
    assert.deepEqual(f.store.db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally { await f.dispose(); }
});

test('deleting a middle or latest turn preserves frozen context, resume session and latest-turn validation', async () => {
  const f = await fixture();
  try {
    const first = (await f.submit('Question to remember')).json(); await f.complete(first.id, 'Remember this published answer');
    const second = (await f.submit('Another question', first.conversationId, first.id)).json(); await f.complete(second.id, 'Another published answer');
    const session = f.calls[1].resumeSessionId;
    assert.ok(session); assert.equal(session, (f.store.db.prepare('SELECT session_id FROM runs WHERE question_id=?').get(first.id) as any).session_id);
    await removeHistory(f, 'client', { questionIds: [second.id] });
    const visible = (await f.request('client', 'GET', '/api/conversations/' + first.conversationId)).json();
    assert.equal(visible.latestTurnId, second.id); assert.equal(visible.questions.length, 1); assert.equal(visible.status, 'answered');
    assert.equal((await f.submit('Stale followup', first.conversationId, first.id)).statusCode, 409);
    const third = (await f.submit('Continue the same context', first.conversationId, visible.latestTurnId)).json();
    assert.equal(third.turnIndex, 3);
    const frozen = (await f.request('admin', 'GET', '/api/questions/' + third.id)).json().contextSnapshot;
    assert.deepEqual(frozen.sourceIds, [first.id, second.id]);
    await f.complete(third.id, 'Third published answer');
    assert.equal(f.calls[2].resumeSessionId, session);
    assert.ok(f.calls[2].question.includes('Remember this published answer'));
    assert.ok(f.calls[2].question.includes('Another published answer'));
    assert.ok(!f.calls[2].question.includes('UNPUBLISHED PRIVATE DRAFT'));
  } finally { await f.dispose(); }
});

test('clear history skips active work, is scoped to the current user and cannot include newly completed turns after preview', async () => {
  const f = await fixture();
  try {
    const old = (await f.submit('Clear only my finished question')).json(); await f.action(old.id, 'reject');
    const pending = (await f.submit('Keep the unfinished question')).json();
    const other = (await f.request('client', 'POST', '/api/questions', { projectId: f.project, question: 'Other user finished question' }, f.other)).json(); await f.action(other.id, 'reject');
    const selection = { all: true };
    const preview = (await f.request('client', 'POST', '/api/history/delete/preview', selection)).json();
    assert.equal(preview.count, 1); assert.equal(preview.skipped, 1);
    await new Promise(resolve => setTimeout(resolve, 5));
    await f.action(pending.id, 'reject');
    const clear = await f.request('client', 'POST', '/api/history/delete', { selection, before: preview.before, expectedCount: preview.count });
    assert.equal(clear.statusCode, 200, clear.body); assert.equal(clear.json().deleted, 1);
    assert.equal((await f.request('client', 'GET', '/api/questions')).json().total, 1);
    assert.equal((await f.request('client', 'GET', '/api/questions/' + pending.id)).statusCode, 200);
    assert.equal((await f.request('client', 'GET', '/api/questions/' + other.id, undefined, f.other)).statusCode, 200);
    const final = await removeHistory(f, 'client', { all: true }); assert.equal(final.statusCode, 200, final.body);
    assert.equal((await f.request('client', 'GET', '/api/conversations')).json().total, 0);
    assert.equal((await f.submit('Cannot restore deleted conversation', old.conversationId, old.id)).statusCode, 404);
    assert.equal((await f.request('admin', 'POST', '/api/cleanup/preview', { before: preview.before })).statusCode, 404);
  } finally { await f.dispose(); }
});

test('delete preview detects stale ranges and active records cannot be removed', async () => {
  const f = await fixture();
  try {
    const q = (await f.submit('Protected active question')).json();
    const blocked = (await f.request('client', 'POST', '/api/history/delete/preview', { questionIds: [q.id] })).json();
    assert.equal(blocked.count, 0); assert.equal(blocked.skipped, 1);
    assert.equal((await f.request('client', 'POST', '/api/history/delete', { selection: { questionIds: [q.id] }, before: blocked.before, expectedCount: 1 })).statusCode, 409);
    await f.action(q.id, 'cancel');
    const preview = (await f.request('client', 'POST', '/api/history/delete/preview', { all: true })).json();
    await removeHistory(f, 'client', { questionIds: [q.id] });
    assert.equal((await f.request('client', 'POST', '/api/history/delete', { selection: { all: true }, before: preview.before, expectedCount: preview.count })).statusCode, 409);
    assert.equal((await f.request('client', 'POST', '/api/history/delete/preview', { all: true, questionIds: [q.id] })).statusCode, 400);
  } finally { await f.dispose(); }
});

test('separate users, new conversations and unpublished executions never share resume sessions', async () => {
  const f = await fixture();
  try {
    const first = (await f.submit('Published session')).json(); await f.complete(first.id, 'Approved');
    const rejected = (await f.submit('Answer that will be rejected', first.conversationId, first.id)).json();
    await f.action(rejected.id, 'approve'); await f.service.current?.promise; await new Promise(resolve => setImmediate(resolve));
    assert.ok(f.calls[1].resumeSessionId);
    await f.action(rejected.id, 'reject');
    const follow = (await f.submit('Resume after rejection', first.conversationId, rejected.id)).json(); await f.complete(follow.id, 'After rejection');
    assert.equal(f.calls[2].resumeSessionId, undefined);
    assert.ok(!f.calls[2].question.includes('Answer that will be rejected'));
    const newQuestion = (await f.submit('New independent conversation')).json(); await f.complete(newQuestion.id, 'Independent');
    assert.equal(f.calls[3].resumeSessionId, undefined);
    const other = (await f.request('client', 'POST', '/api/questions', { projectId: f.project, question: 'Other client independent context' }, f.other)).json(); await f.complete(other.id, 'Other client');
    assert.equal(f.calls[4].resumeSessionId, undefined);
    const originalHead = (f.store.db.prepare('SELECT claude_session_id FROM conversations WHERE id=?').get(first.conversationId) as any).claude_session_id;
    const otherHead = (f.store.db.prepare('SELECT claude_session_id FROM conversations WHERE id=?').get(other.conversationId) as any).claude_session_id;
    assert.notEqual(originalHead, otherHead);
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
    store.db.exec('PRAGMA user_version=5'); store.close(); store = undefined;
    assert.throws(() => new Store(directory),/高于当前支持版本/);
    const future = new DatabaseSync(join(directory,'desk.sqlite')); assert.equal((future.prepare('PRAGMA user_version').get() as any).user_version,5); future.close();
  } finally { store?.close(); await rm(directory,{recursive:true,force:true}); }
});

test('v2 upgrade preserves history and per-user deletion persists across restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'desk-v2-history-'));
  let store = new Store(directory);
  const owner = randomUUID(), project = randomUUID(), conversation = randomUUID(), question = randomUUID();
  const now = new Date().toISOString();
  try {
    store.db.prepare('INSERT INTO users VALUES(?,?,?,?,1,?)').run(owner,'retained-client','retained-password','client',now);
    store.db.prepare('INSERT INTO projects VALUES(?,?,?,?,1)').run(project,'retained-project','retained-description',directory);
    store.db.prepare('INSERT INTO grants VALUES(?,?)').run(owner,project);
    store.db.prepare('INSERT INTO conversations(id,user_id,project_id,created_at) VALUES(?,?,?,?)').run(conversation,owner,project,now);
    store.db.prepare("INSERT INTO questions(id,user_id,project_id,conversation_id,question,status,answer,created_at,updated_at) VALUES(?,?,?,?,?,'answered',?,?,?)").run(question,owner,project,conversation,'Retained question','Retained answer',now,now);
    const saved = { ...store.settings(), mode: 'visible', extraPrompt: 'retained instructions' };
    store.db.prepare('UPDATE settings SET value=? WHERE id=1').run(JSON.stringify(saved));
    store.db.exec('DROP TABLE attachments; ALTER TABLE runs DROP COLUMN attachment_reads; DROP TABLE question_deletions; ALTER TABLE conversations DROP COLUMN claude_session_id; ALTER TABLE conversations DROP COLUMN claude_session_path; PRAGMA user_version=2;');
    store.close(); store = new Store(directory);
    assert.deepEqual(store.settings(), saved);
    assert.equal((store.db.prepare('SELECT answer FROM questions WHERE id=?').get(question) as any).answer,'Retained answer');
    assert.equal((store.db.prepare('SELECT claude_session_id FROM conversations WHERE id=?').get(conversation) as any).claude_session_id,null);
    assert.equal((store.db.prepare('PRAGMA user_version').get() as any).user_version,4);
    store.db.prepare('INSERT INTO question_deletions VALUES(?,?,?)').run(owner,question,now);
    store.close(); store = new Store(directory);
    assert.equal((store.db.prepare('SELECT COUNT(*) n FROM question_deletions WHERE user_id=? AND question_id=?').get(owner,question) as any).n,1);
    assert.deepEqual(store.db.prepare('PRAGMA foreign_key_check').all(),[]);
  } finally { store.close(); await rm(directory,{recursive:true,force:true}); }
});
