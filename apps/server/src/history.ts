import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { Store, activeStates } from './store.js';
import { Service } from './service.js';

const ids = z.array(z.string().uuid()).min(1).max(100);
const selectionSchema = z.union([
  z.object({ questionIds: ids }).strict(),
  z.object({ conversationIds: ids }).strict(),
  z.object({ all: z.literal(true) }).strict(),
]);
function fail(code: number, message: string): never { throw Object.assign(new Error(message), { statusCode: code }); }
export const recordVisibility = (alias = 'q') => `NOT EXISTS(SELECT 1 FROM question_deletions d WHERE d.question_id=${alias}.id AND d.user_id=?)`;

/** Deletion belongs to the signed-in viewer; execution, other viewers and frozen context keep their records. */
export function registerHistoryRoutes(app: FastifyInstance, store: Store, service: Service, portal: 'admin' | 'client', userOf: (request: FastifyRequest) => { id: string }) {
  function scope(request: FastifyRequest, selection: z.infer<typeof selectionSchema>) {
    const actor = userOf(request).id;
    const params: string[] = [actor];
    const clauses = [recordVisibility()];
    if (portal === 'client') {
      clauses.push('q.user_id=?', 'EXISTS(SELECT 1 FROM grants g JOIN projects p ON p.id=g.project_id WHERE g.user_id=q.user_id AND g.project_id=q.project_id AND p.enabled=1)');
      params.push(actor);
    }
    const base = clauses.join(' AND ');
    const key = 'questionIds' in selection ? 'id' : 'conversationIds' in selection ? 'conversation_id' : undefined;
    if (key) {
      const selectedIds = [...new Set('questionIds' in selection ? selection.questionIds : 'conversationIds' in selection ? selection.conversationIds : [])];
      for (const id of selectedIds) {
        if (!store.db.prepare(`SELECT 1 FROM questions q WHERE ${base} AND q.${key}=?`).get(...params, id)) fail(404, '记录不存在，请刷新后重试');
      }
      clauses.push(`q.${key} IN (${selectedIds.map(() => '?').join(',')})`);
      params.push(...selectedIds);
    }
    return { actor, where: clauses.join(' AND '), params };
  }
  function preview(request: FastifyRequest, selection: z.infer<typeof selectionSchema>, before: string) {
    const selected = scope(request, selection);
    const rows = store.db.prepare(`SELECT q.id,q.status,q.updated_at FROM questions q WHERE ${selected.where}`).all(...selected.params) as { id: string; status: string; updated_at: string }[];
    const deletable = rows.filter(q => !activeStates.includes(q.status) && q.updated_at <= before);
    return { ...selected, deletable, skipped: rows.length - deletable.length };
  }
  app.post('/api/history/delete/preview', async request => {
    const selection = selectionSchema.parse(request.body);
    const before = new Date().toISOString();
    const result = preview(request, selection, before);
    return { count: result.deletable.length, skipped: result.skipped, before };
  });
  app.post('/api/history/delete', async request => {
    const body = z.object({ selection: selectionSchema, before: z.string().datetime(), expectedCount: z.number().int().min(1) }).strict().parse(request.body);
    if (body.before > new Date().toISOString()) fail(400, '删除预览时间无效');
    let deleted = 0;
    store.transaction(() => {
      const result = preview(request, body.selection, body.before);
      if (result.deletable.length !== body.expectedCount) fail(409, '记录已经变更，请重新确认删除范围');
      const insert = store.db.prepare('INSERT INTO question_deletions VALUES(?,?,?)');
      for (const q of result.deletable) insert.run(result.actor, q.id, new Date().toISOString());
      deleted = result.deletable.length;
      store.audit(result.actor, 'delete_history', JSON.stringify({ questionIds: result.deletable.map(q => q.id) }));
    });
    service.notify();
    return { ok: true, deleted };
  });
}
