import type { Page, Question } from './api';

export const answerKey = (userId: string, question: Pick<Question, 'id' | 'updatedAt'>) => `answer-notice:${userId}:${question.id}:${question.updatedAt}`;

// Scan all answered pages independently of history pagination. The first browser
// snapshot is silent; a saved baseline lets returning clients receive offline replies.
export async function answeredSnapshot(request: (path: string) => Promise<Page>): Promise<Question[]> {
  const items: Question[] = [];
  for (let page = 1; ; page++) {
    const result = await request(`/questions?status=answered&page=${page}`);
    items.push(...result.items);
    if (!result.items.length || items.length >= result.total) return items;
  }
}
export class AnswerNotifications {
  private baseline = false;
  private seen = new Set<string>();
  constructor(private userId: string, private storage?: Pick<Storage, 'getItem' | 'setItem'>) { try { this.baseline = storage?.getItem(`answer-notice:${userId}:baseline`) === '1'; } catch { /* Restricted storage still permits an in-memory baseline. */ } }
  private key(item: Pick<Question, 'id'>) { return `answer-notice:${this.userId}:${item.id}`; }
  acknowledge(item: Question) { this.seen.add(item.id); try { this.storage?.setItem(this.key(item), '1'); } catch { /* In-memory deduplication still works when storage is unavailable. */ } }
  consume(items: Question[]): Question[] {
    const fresh: Question[] = [];
    for (const item of items) {
      if (!item.answer || this.seen.has(item.id)) continue;
      let stored = false;
      try { stored = this.storage?.getItem(this.key(item)) === '1' || this.storage?.getItem(answerKey(this.userId, item)) === '1'; } catch { /* Restricted WebView storage. */ }
      if (this.baseline && !stored) { fresh.push(item); this.seen.add(item.id); }
      else this.acknowledge(item);
    }
    this.baseline = true;
    try { this.storage?.setItem(`answer-notice:${this.userId}:baseline`, '1'); } catch { /* Storage is optional. */ }
    return fresh;
  }
}
