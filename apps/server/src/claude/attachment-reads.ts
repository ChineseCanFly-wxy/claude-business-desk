import type { AttachmentInput } from '../attachments.js';
const object = (value: unknown): value is Record<string, any> => value !== null && typeof value === 'object' && !Array.isArray(value);
const key = (path: string) => path.replace(/\\/g, '/').toLowerCase();
export class AttachmentReads {
  private pending = new Map<string, { path: string; pages?: string; partial: boolean }>();
  private readPaths = new Set<string>();
  private readPages = new Map<string, Set<number>>();
  constructor(private inputs: AttachmentInput[]) {}
  reset() { this.pending.clear(); this.readPaths.clear(); this.readPages.clear(); }
  observe(value: unknown) {
    if (!object(value) || !object(value.message) || !Array.isArray(value.message.content)) return;
    for (const block of value.message.content) {
      if (!object(block)) continue;
      if (value.type === 'assistant' && block.type === 'tool_use' && block.name === 'Read' && typeof block.id === 'string' && object(block.input) && typeof block.input.file_path === 'string') {
        this.pending.set(block.id, { path: key(block.input.file_path), pages: typeof block.input.pages === 'string' ? block.input.pages : undefined, partial: block.input.limit !== undefined || (block.input.offset !== undefined && block.input.offset > 1) });
      }
      if (value.type !== 'user' || block.type !== 'tool_result' || typeof block.tool_use_id !== 'string') continue;
      const call = this.pending.get(block.tool_use_id); this.pending.delete(block.tool_use_id);
      if (!call || call.partial || block.is_error === true || !block.content || (typeof block.content === 'string' && /^\s*(error[:\s]|<tool_use_error>)/i.test(block.content)) || (Array.isArray(block.content) && !block.content.length)) continue;
      this.readPaths.add(call.path);
      const input = this.inputs.find(input => input.pageCounts && input.paths.some(path => key(path) === call.path));
      const pageCount = input?.pageCounts?.[input.paths.findIndex(path => key(path) === call.path)];
      if (!pageCount) continue;
      const pages = this.readPages.get(call.path) ?? new Set<number>();
      if (!call.pages && pageCount <= 10) for (let page = 1; page <= pageCount; page++) pages.add(page);
      else if (call.pages && /^\d+(?:-\d+)?(?:,\s*\d+(?:-\d+)?)*$/.test(call.pages)) {
        for (const range of call.pages.split(',')) {
          const [start, end = start] = range.trim().split('-').map(Number);
          for (let page = Math.max(1, start); page <= Math.min(pageCount, end); page++) pages.add(page);
        }
      }
      this.readPages.set(call.path, pages);
    }
  }
  observeTranscript(text: string, question: string) {
    let currentTurn = false;
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      const event = JSON.parse(line);
      const content = event.type === 'user' ? event.message?.content : undefined;
      const message = typeof content === 'string' ? content : Array.isArray(content) ? content.filter(block => block.type === 'text').map(block => block.text).join('\n') : undefined;
      if (message === question) { currentTurn = true; this.reset(); }
      if (currentTurn) this.observe(event);
    }
  }
  completedIds() {
    return this.inputs.filter(input => input.paths.every(path => this.readPaths.has(key(path))) && (!input.pageCounts || input.paths.every((path, i) => this.readPages.get(key(path))?.size === input.pageCounts![i]))).map(input => input.id);
  }
}
