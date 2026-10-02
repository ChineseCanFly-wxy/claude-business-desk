import { test } from 'node:test';
import assert from 'node:assert/strict';
import { persistConversation, restoreConversation } from './conversation-selection';
const id = '12345678-1234-1234-1234-123456789abc';
const other = 'abcdefab-1234-1234-1234-123456789abc';
const memory = () => { const map = new Map<string, string>(); return { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => { map.set(k, v); } }; };
test('selection storage is user-specific and URL selection wins', () => { const s = memory(); persistConversation('alice', id, s); assert.equal(restoreConversation('alice', '', s), id); assert.equal(restoreConversation('bob', '', s), undefined); assert.equal(restoreConversation('alice', `?conversation=${other}`, s), other); });
test('blank and old question views do not silently restore another conversation', () => { const s = memory(); persistConversation('alice', id, s); for (const query of ['?new=1', `?question=${other}`, '?conversation=invalid', '?conversation=%2Fapi%2Fusers']) assert.equal(restoreConversation('alice', query, s), undefined); persistConversation('alice', undefined, s); assert.equal(restoreConversation('alice', '', s), undefined); });
test('unavailable storage is safe', () => { const s = { getItem() { throw Error('denied'); }, setItem() { throw Error('denied'); } }; persistConversation('alice', id, s); assert.equal(restoreConversation('alice', '', s), undefined); assert.equal(restoreConversation('alice', `?conversation=${id}`, s), id); });
