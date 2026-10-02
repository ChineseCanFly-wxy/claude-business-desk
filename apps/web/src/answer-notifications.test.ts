import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AnswerNotifications, answeredSnapshot } from './answer-notifications';
import type { Question } from './api';
const question = (id: string, updatedAt = '2026-10-01T00:00:00.000Z'): Question => ({ id, conversationId: id, turnIndex: 1, updatedAt, status: 'answered', answer: '正式答案', question: '业务问题', projectId: 'project', projectName: '项目', username: '客户', createdAt: updatedAt, archived: false });
const memory = () => { const values = new Map<string, string>(); return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } }; };
test('first answered snapshot is silent; published answer appears only once', () => {
  const state = new AnswerNotifications('alice', memory());
  assert.deepEqual(state.consume([question('old')]), []);
  assert.deepEqual(state.consume([question('new'), question('old')]).map(q => q.id), ['new']);
  assert.deepEqual(state.consume([question('new')]), []);
});
test('acknowledged replies stay read across refresh and archiving, with separate users', () => {
  const storage = memory(); const first = new AnswerNotifications('alice', storage);
  first.consume([]); first.consume([question('one')]); first.acknowledge(question('one'));
  const refreshed = new AnswerNotifications('alice', storage); refreshed.consume([]);
  assert.deepEqual(refreshed.consume([question('one')]), []);
  assert.equal(refreshed.consume([question('one', '2026-10-02T00:00:00.000Z')]).length, 0); // Archiving updates updatedAt but does not publish another answer.
  const other = new AnswerNotifications('bob', storage); other.consume([]);
  assert.equal(other.consume([question('one')]).length, 1);
});
test('offline replies and reminders interrupted by refresh remain available until acknowledged', () => {
  const storage = memory(); const first = new AnswerNotifications('alice', storage);
  first.consume([question('old')]);
  const returned = new AnswerNotifications('alice', storage);
  assert.deepEqual(returned.consume([question('offline'), question('old')]).map(q => q.id), ['offline']);
  assert.deepEqual(returned.consume([question('offline')]), []);
  const reloaded = new AnswerNotifications('alice', storage);
  assert.deepEqual(reloaded.consume([question('offline')]).map(q => q.id), ['offline']);
  reloaded.acknowledge(question('offline'));
  const read = new AnswerNotifications('alice', storage);
  assert.deepEqual(read.consume([question('offline', '2026-10-03T00:00:00.000Z')]), []);
});
test('baseline fetches every answered page independently of history pagination', async () => {
  const paths: string[] = [];
  const items = await answeredSnapshot(async path => { paths.push(path); return { page: paths.length, total: 3, items: paths.length === 1 ? [question('a'), question('b')] : [question('c')] }; });
  assert.equal(items.length, 3);
  assert.deepEqual(paths, ['/questions?status=answered&page=1', '/questions?status=answered&page=2']);
  const state = new AnswerNotifications('alice', memory()); assert.deepEqual(state.consume(items), []);
  assert.deepEqual(state.consume([question('c')]), []);
});
test('storage denial still deduplicates within the session', () => {
  const state = new AnswerNotifications('alice', { getItem() { throw Error('denied'); }, setItem() { throw Error('denied'); } });
  state.consume([]); assert.equal(state.consume([question('a')]).length, 1); assert.equal(state.consume([question('a')]).length, 0);
});
