import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { zipSync, strToU8 } from 'fflate';
import { PDFDocument } from 'pdf-lib';
import { prepareFile } from '../apps/server/src/attachment-worker.js';
import { prepareAttachment, materializeAttachments, MAX_FILE_BYTES, type ExecutionAttachment } from '../apps/server/src/attachments.js';
import { AttachmentReads } from '../apps/server/src/claude/attachment-reads.js';
import { ClaudeProtocol } from '../apps/server/src/claude/protocol.js';
import { buildNativeArguments } from '../apps/server/src/claude/native.js';
import { Store } from '../apps/server/src/store.js';
import { Service, type Executor } from '../apps/server/src/service.js';
import { createApp } from '../apps/server/src/app.js';
import { digest } from '../apps/server/src/auth.js';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jC14AAAAASUVORK5CYII=', 'base64');
function docx(extra: Record<string, Uint8Array> = {}) {
  return Buffer.from(zipSync({
    '[Content_Types].xml': strToU8('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'),
    'word/document.xml': strToU8('<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><w:body><w:p><w:r><w:t>业务附件示例</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>金额</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>500 元</w:t></w:r></w:p></w:tc></w:tr></w:tbl><w:p><w:r><w:drawing><wp:inline><a:graphic><a:graphicData><pic:pic><pic:blipFill><a:blip r:embed="img1"/></pic:blipFill></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p></w:body></w:document>'),
    'word/_rels/document.xml.rels': strToU8('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="img1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image.png"/></Relationships>'),
    'word/media/image.png': png, ...extra,
  }));
}
const file = (data: Buffer, prepared: Awaited<ReturnType<typeof prepareFile>>, name: string): ExecutionAttachment => ({ id: randomUUID(), name, mime: prepared.mime, size: data.length, sha256: createHash('sha256').update(data).digest('hex'), data, prepared });
test('attachment conversion validates images, DOCX tables/images and PDF page limits in a worker', async () => {
  assert.equal((await prepareAttachment('图.png', png)).mime, 'image/png');
  await assert.rejects(prepareFile('fake.jpg', png), /格式/);
  await assert.rejects(prepareFile('legacy.doc', png), /DOCX/);
  await assert.rejects(prepareFile('broken.pdf', png), /PDF/);
  const word = await prepareAttachment('业务.docx', docx());
  assert.match(word.previewText!, /500 元/); assert.match(word.html!, /<table>/); assert.equal(word.images?.length, 1);
  assert.deepEqual(Buffer.from(word.images![0].base64, 'base64'), png);
  await assert.rejects(prepareFile('macro.docx', docx({ 'word/vbaProject.bin': png })), /宏/);
  await assert.rejects(prepareFile('zip-path.docx', docx({ '..\\escape': png })), /结构/);
  await assert.rejects(prepareFile('zip-bomb.docx', docx({ 'word/large.xml': new Uint8Array(17 * 1024 * 1024) })), /解压/);
  const pdf = await PDFDocument.create(); for (let i = 0; i < 12; i++) pdf.addPage();
  const data = Buffer.from(await pdf.save()), prepared = await prepareAttachment('报告.pdf', data);
  assert.equal(prepared.pageCount, 12); assert.deepEqual(prepared.pdfParts?.map(p => p.pageCount), [10, 2]);
  assert.equal((await PDFDocument.load(Buffer.from(prepared.pdfParts![1].base64, 'base64'))).getPageCount(), 2);
  for (let i = 12; i < 21; i++) pdf.addPage(); await assert.rejects(prepareFile('超长.pdf', Buffer.from(await pdf.save())), /20 页/);
});
test('materialized files include Word images and all PDF parts, leaving the original content unchanged', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'desk-attachment-files-'));
  try {
    const pdf = await PDFDocument.create(); for (let i = 0; i < 11; i++) pdf.addPage(); const data = Buffer.from(await pdf.save());
    const word = file(docx(), await prepareFile('word.docx', docx()), 'word.docx');
    const input = await materializeAttachments([word, file(data, await prepareFile('a.pdf', data), 'a.pdf')], directory);
    assert.equal(input[0].paths.length, 2); assert.match(await readFile(input[0].paths[0], 'utf8'), /500 元/);
    assert.deepEqual(await readFile(input[0].paths[1]), png); assert.deepEqual(input[1].pageCounts, [10, 1]);
    assert.equal(input[1].paths.length, 2);
    const broken = file(png, { mime: 'image/png' }, 'a.png'); broken.sha256 = 'changed';
    await assert.rejects(materializeAttachments([broken], directory), /校验/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
function readEvents(tracker: AttachmentReads, path: string, input: Record<string, unknown> = {}, error = false) {
  const id = randomUUID(); tracker.observe({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', id, input: { file_path: path, ...input } }] } });
  tracker.observe({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: error, content: error ? 'Error: unreadable' : 'Actual file content' }] } });
}
test('read receipts require successful tools for every file and every PDF page; partial reads do not pass', () => {
  const tracker = new AttachmentReads([{ id: 'word', name: 'a.docx', paths: ['C:\\private\\word.html', 'C:\\private\\image.png'] }, { id: 'pdf', name: 'a.pdf', paths: ['part1.pdf', 'part2.pdf'], pageCounts: [10, 2] }]);
  readEvents(tracker, 'C:/private/word.html', { limit: 2 }); readEvents(tracker, 'C:/private/image.png', {}, true); assert.deepEqual(tracker.completedIds(), []);
  readEvents(tracker, 'C:/private/word.html'); readEvents(tracker, 'c:/PRIVATE/image.png'); assert.deepEqual(tracker.completedIds(), ['word']);
  readEvents(tracker, 'part1.pdf', { pages: '1-5' }); readEvents(tracker, 'part2.pdf'); assert.deepEqual(tracker.completedIds(), ['word']);
  readEvents(tracker, 'part1.pdf', { pages: '6-10' }); assert.deepEqual(tracker.completedIds(), ['word', 'pdf']);
  tracker.reset(); assert.deepEqual(tracker.completedIds(), []);
});
test('protocol receipt observer sees tools while administrator logs omit image base64', () => {
  const observed: unknown[] = [], logs: string[] = [];
  const protocol = new ClaudeProtocol(text => logs.push(text), undefined, undefined, 'session', event => observed.push(event));
  protocol.push(Buffer.from(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'session', permissionMode: 'auto', tools: ['Read'], mcp_servers: [] }) + '\n'));
  const event = { type: 'user', message: { content: [{ type: 'tool_result', content: [{ type: 'image', source: { type: 'base64', data: 'PRIVATE_BINARY_IMAGE', media_type: 'image/png' } }] }] } };
  protocol.push(Buffer.from(JSON.stringify(event) + '\n'));
  assert.equal(observed.length, 2); assert.ok(!logs.join('').includes('PRIVATE_BINARY_IMAGE'));
});
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'desk-attachments-api-'));
  const store = new Store(directory); const owner = randomUUID(), other = randomUUID(), admin = randomUUID(), project = randomUUID(), project2 = randomUUID();
  const now = new Date().toISOString();
  for (const [id, role] of [[owner, 'client'], [other, 'client'], [admin, 'admin']]) store.db.prepare('INSERT INTO users VALUES(?,?,?,?,1,?)').run(id, id, 'unused', role, now);
  for (const id of [project, project2]) { store.db.prepare('INSERT INTO projects VALUES(?,?,?,?,1)').run(id, id, '', directory); for (const user of [owner, other]) store.db.prepare('INSERT INTO grants VALUES(?,?)').run(user, id); }
  for (const [user, portal] of [[owner, 'client'], [other, 'client'], [admin, 'admin']]) store.db.prepare('INSERT INTO sessions VALUES(?,?,?,?,?)').run(digest(user), user, portal, 'csrf', Date.now() + 120000);
  const calls: Parameters<Executor>[0][] = []; let skipReads = false;
  const service = new Service(store, async options => { calls.push(options); return { answer: '基于附件的业务答案', exitCode: 0, readAttachmentIds: skipReads ? [] : options.attachments?.map(file => file.id) }; });
  const client = await createApp(store, service, 'client'), management = await createApp(store, service, 'admin'); let requestIndex = 1;
  const request = (portal: 'client' | 'admin', method: 'GET' | 'POST', url: string, payload?: object | Buffer, user = portal === 'admin' ? admin : owner, csrf = 'csrf') => (portal === 'admin' ? management : client).inject({ method, url, remoteAddress: `127.0.0.${requestIndex++}`, headers: { host: '127.0.0.1', cookie: `desk_${portal}=${user}`, 'x-csrf-token': csrf, ...(Buffer.isBuffer(payload) ? { 'content-type': 'application/octet-stream' } : {}) }, ...(payload ? { payload } : {}) });
  const upload = (name = '图.png', bytes = png, projectId = project, user = owner) => request('client', 'POST', `/api/attachments?${new URLSearchParams({ name, projectId })}`, bytes, user);
  const action = (id: string, operation: string, payload: object = {}) => request('admin', 'POST', `/api/questions/${id}/${operation}`, payload);
  const submit = (attachments: string[], rest: Record<string, unknown> = {}) => request('client', 'POST', '/api/questions', { projectId: project, question: '请分析业务附件', attachmentIds: attachments, ...rest });
  const complete = async (id: string) => { const response = await action(id, 'approve'); assert.equal(response.statusCode, 200, response.body); await service.current?.promise; await new Promise(resolve => setImmediate(resolve)); };
  return { directory, store, owner, other, admin, project, project2, calls, request, upload, action, submit, complete, skipReads: () => { skipReads = true; }, dispose: async () => { await service.stop(); await client.close(); await management.close(); store.close(); await rm(directory, { recursive: true, force: true }); } };
}
test('upload API enforces CSRF, ownership, project isolation, size, expiry and immutable binding', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.request('client', 'POST', `/api/attachments?projectId=${f.project}&name=a.png`, png, f.owner, 'bad')).statusCode, 403);
    assert.equal((await f.upload('fake.jpg')).statusCode, 400);
    assert.equal((await f.upload('a.png', Buffer.alloc(MAX_FILE_BYTES + 1))).statusCode, 413);
    const response = await f.upload(); assert.equal(response.statusCode, 200, response.body); const attachment = response.json();
    assert.equal((await f.request('client', 'GET', `/api/attachments/${attachment.id}/file`, undefined, f.other)).statusCode, 404);
    assert.equal((await f.request('admin', 'GET', `/api/attachments/${attachment.id}/preview`)).statusCode, 404);
    assert.equal((await f.submit([attachment.id], { projectId: f.project2 })).statusCode, 400);
    assert.equal((f.store.db.prepare('SELECT COUNT(*) n FROM questions').get() as any).n, 0);
    const submitted = await f.submit([attachment.id]); assert.equal(submitted.statusCode, 200, submitted.body); const question = submitted.json();
    assert.equal(question.attachments[0].readByAi, false); assert.equal((await f.request('admin', 'GET', `/api/attachments/${attachment.id}/preview`)).statusCode, 200);
    const downloaded = await f.request('client', 'GET', `/api/attachments/${attachment.id}/file`); assert.deepEqual(downloaded.rawPayload, png); assert.match(String(downloaded.headers['content-security-policy']), /sandbox/);
    assert.equal((await f.request('client', 'POST', `/api/attachments/${attachment.id}/remove`, {})).statusCode, 409);
    await f.action(question.id, 'reject'); assert.equal((await f.submit([attachment.id])).statusCode, 400);
    const pending = (await f.upload()).json(); f.store.db.prepare('UPDATE attachments SET created_at=? WHERE id=?').run('2020-01-01T00:00:00.000Z', pending.id);
    assert.equal((await f.submit([pending.id])).statusCode, 400);
    f.store.db.prepare('DELETE FROM grants WHERE user_id=? AND project_id=?').run(f.owner, f.project);
    assert.equal((await f.request('client', 'GET', `/api/attachments/${attachment.id}/file`)).statusCode, 404);
    assert.equal((await f.upload()).statusCode, 403);
  } finally { await f.dispose(); }
});
test('approval sends original files, publishes verified receipts, freezes follow-up references and includes blobs in SQLite backup', async () => {
  const f = await fixture();
  try {
    const original = docx(); const response = await f.upload('业务.docx', original); assert.equal(response.statusCode, 200, response.body); const word = response.json();
    const first = (await f.submit([word.id])).json(); assert.equal(f.calls.length, 0);
    assert.deepEqual((await f.request('admin', 'GET', `/api/attachments/${word.id}/images/0`)).rawPayload, png);
    await f.complete(first.id); assert.deepEqual(f.calls[0].attachments?.[0].data, original);
    const detail = (await f.request('admin', 'GET', `/api/questions/${first.id}`)).json(); assert.equal(detail.status, 'pending_answer_review'); assert.equal(detail.attachments[0].readByAi, true);
    assert.equal((await f.action(first.id, 'publish', { answer: '人工审核后发布' })).statusCode, 200);
    const follow = (await f.submit([], { conversationId: first.conversationId, latestTurnId: first.id })).json();
    assert.equal(follow.referenceAttachments[0].id, word.id); assert.deepEqual(JSON.parse((f.store.db.prepare('SELECT context_snapshot FROM questions WHERE id=?').get(follow.id) as any).context_snapshot).attachmentIds, [word.id]);
    // Viewer deletion keeps the submitted context and its attachments available to the visible follow-up.
    f.store.db.prepare('INSERT INTO question_deletions VALUES(?,?,?)').run(f.owner, first.id, new Date().toISOString());
    assert.equal((await f.request('client', 'GET', `/api/attachments/${word.id}/preview`)).statusCode, 200);
    await f.complete(follow.id); assert.equal(f.calls[1].attachments?.[0].id, word.id);
    await f.action(follow.id, 'publish', { answer: '追问回复' });
    const independent = (await f.submit([])).json(); await f.complete(independent.id); assert.equal(f.calls[2].attachments?.length, 0);
    const backup = await f.request('admin', 'GET', '/api/backup'); assert.equal(backup.statusCode, 200); const path = join(f.directory, 'attachment-backup.sqlite'); await writeFile(path, backup.rawPayload);
    const db = new DatabaseSync(path, { readOnly: true }); try { assert.deepEqual(Buffer.from((db.prepare('SELECT data FROM attachments WHERE id=?').get(word.id) as any).data), original); assert.equal((db.prepare('PRAGMA user_version').get() as any).user_version, 4); } finally { db.close(); }
  } finally { await f.dispose(); }
});
test('missing AI read receipt fails the question instead of sending an ungrounded draft for approval', async () => {
  const f = await fixture();
  try {
    f.skipReads(); const uploaded = (await f.upload()).json(); const question = (await f.submit([uploaded.id])).json(); await f.complete(question.id);
    const detail = (await f.request('admin', 'GET', `/api/questions/${question.id}`)).json(); assert.equal(detail.status, 'failed'); assert.match(detail.error, /AI 未成功读取附件/); assert.equal(detail.attachments[0].readByAi, false); assert.ok(!detail.draftAnswer);
    assert.equal((await f.action(question.id, 'publish', { answer: '不应发布' })).statusCode, 409);
  } finally { await f.dispose(); }
});
test('database v3 migration preserves accounts and settings; native args only add the run-private attachment directory', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'desk-attachment-migration-')); let store = new Store(directory);
  try {
    const settings = store.settings(); settings.extraPrompt = '保留原业务配置'; store.db.prepare('UPDATE settings SET value=? WHERE id=1').run(JSON.stringify(settings));
    store.db.exec('DROP TABLE attachments; ALTER TABLE runs DROP COLUMN attachment_reads; PRAGMA user_version=3;'); store.close(); store = new Store(directory);
    assert.equal(store.settings().extraPrompt, '保留原业务配置'); assert.equal((store.db.prepare('PRAGMA user_version').get() as any).user_version, 4);
    assert.deepEqual(store.db.prepare('SELECT * FROM attachments').all(), []);
    const args = await buildNativeArguments({ mode: 'hidden', claudePath: 'claude.exe', projectPath: directory, question: '业务提问', extraPrompt: '', timeoutSeconds: 30, signal: new AbortController().signal, onLog: () => {}, attachmentDirectory: join(directory, 'private', 'attachments') }, 'id', directory, 'host.exe');
    assert.equal(args[args.indexOf('--add-dir') + 1], join(directory, 'private', 'attachments')); assert.ok(!args.includes('--dangerously-skip-permissions'));
  } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
});

test('visible transcript verification ignores earlier turns and resets at the exact current prompt', () => {
  const tracker = new AttachmentReads([{ id: 'image', name: 'a.png', paths: ['image.png'] }]);
  const tool = { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', id: 'tool', input: { file_path: 'image.png' } }] } };
  const result = { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tool', content: 'image' }] } };
  const prompt = { type: 'user', message: { content: [{ type: 'text', text: 'Exact question and attachment manifest' }] } };
  tracker.observeTranscript([tool, result, prompt].map(row => JSON.stringify(row)).join('\n'), 'Exact question and attachment manifest');
  assert.deepEqual(tracker.completedIds(), []);
  tracker.observeTranscript([prompt, tool, result].map(row => JSON.stringify(row)).join('\n'), 'Exact question and attachment manifest');
  assert.deepEqual(tracker.completedIds(), ['image']);
});
