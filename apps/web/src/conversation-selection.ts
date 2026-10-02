const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const validConversationId = (value: unknown): value is string => typeof value === 'string' && uuid.test(value);
const key = (userId: string) => `business-desk:conversation:${userId}`;
export function restoreConversation(userId: string, search: string, storage?: Pick<Storage, 'getItem'>): string | undefined {
  const params = new URLSearchParams(search);
  if (params.has('conversation')) { const id = params.get('conversation'); return validConversationId(id) ? id : undefined; }
  if (params.has('new') || params.has('question')) return undefined;
  try { const id = storage?.getItem(key(userId)); return validConversationId(id) ? id : undefined; } catch { return undefined; }
}
export function persistConversation(userId: string, id: string | undefined, storage?: Pick<Storage, 'setItem'>) {
  try { storage?.setItem(key(userId), validConversationId(id) ? id : ''); } catch { /* Storage is optional. */ }
}
