import { StringDecoder } from 'node:string_decoder';

export interface ClaudeResult { answer: string; sessionId?: string; costUsd?: number; exitCode: number }
const object = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Bounded NDJSON protocol reader. Partial messages are progress only; result is authoritative. */
export class ClaudeProtocol {
  private decoder = new StringDecoder('utf8');
  private pending = '';
  private bytes = 0;
  private result?: Record<string, unknown>;
  private initialized = false;
  private ended = false;
  constructor(private log: (text: string) => void = () => {}, private maxBytes = 16 * 1024 * 1024, private maxLineBytes = 1024 * 1024, private expectedSessionId?: string) {}
  push(chunk: Buffer): void {
    if (this.ended) throw new Error('Protocol already ended');
    this.bytes += chunk.length;
    if (this.bytes > this.maxBytes) throw new Error('Claude output limit exceeded');
    this.consume(this.decoder.write(chunk));
  }
  private consume(text: string): void {
    this.pending += text;
    let end: number;
    while ((end = this.pending.indexOf('\n')) !== -1) {
      const line = this.pending.slice(0, end).replace(/\r$/, '');
      this.pending = this.pending.slice(end + 1);
      this.line(line);
    }
    if (Buffer.byteLength(this.pending) > this.maxLineBytes) throw new Error('Claude line limit exceeded');
  }
  private line(line: string): void {
    if (Buffer.byteLength(line) > this.maxLineBytes) throw new Error('Claude line limit exceeded');
    if (!line.trim()) return;
    let value: unknown;
    try { value = JSON.parse(line); } catch { throw new Error('Invalid Claude NDJSON'); }
    if (!object(value) || typeof value.type !== 'string') throw new Error('Invalid Claude event');
    if (this.result) throw new Error('Event after final Claude result');
    if (value.type === 'system' && value.subtype === 'init') {
      if (this.initialized) throw new Error('Duplicate Claude initialization');
      if (value.permissionMode !== 'auto') throw new Error('Claude permission mode was not auto');
      if (!Array.isArray(value.tools) || !Array.isArray(value.mcp_servers)) throw new Error('Invalid Claude capabilities');
      if (this.expectedSessionId && value.session_id !== this.expectedSessionId) throw new Error('Claude initialization session mismatch');
      this.initialized = true;
    }
    if (value.type === 'result') {
      if (!this.initialized) throw new Error('Missing Claude initialization');
      if (Array.isArray(value.permission_denials) && value.permission_denials.length) {
        const tools = [...new Set(value.permission_denials.flatMap(denial => object(denial) && typeof denial.tool_name === 'string' && /^[a-zA-Z0-9_:-]{1,80}$/.test(denial.tool_name) ? [denial.tool_name] : []))].slice(0, 10);
        throw new Error(`后台自动处理遇到需要人工授权的工具${tools.length ? `（${tools.join('、')}）` : ''}，请切换“可见 Claude 终端”，或在 Claude 配置中预先授权这些工具`);
      }
      if (this.expectedSessionId && value.session_id !== this.expectedSessionId) throw new Error('Claude result session mismatch');
      if (value.subtype !== 'success' || value.is_error !== false || typeof value.result !== 'string') throw new Error('Claude result was not successful');
      if (value.session_id !== undefined && (typeof value.session_id !== 'string' || !/^[a-zA-Z0-9-]{1,128}$/.test(value.session_id))) throw new Error('Invalid session id');
      if (value.total_cost_usd !== undefined && (typeof value.total_cost_usd !== 'number' || !Number.isFinite(value.total_cost_usd) || value.total_cost_usd < 0)) throw new Error('Invalid Claude cost');
      this.result = value;
    }
    // Never reconstruct the answer by concatenating partial and full assistant messages.
    this.log(redactLog(line));
  }
  finish(exitCode: number): ClaudeResult {
    this.consume(this.decoder.end());
    if (this.pending.trim()) this.line(this.pending);
    this.pending = '';
    this.ended = true;
    if (exitCode !== 0 || !this.result) throw new Error(`Claude did not complete successfully (exit ${exitCode})`);
    const answer = (this.result.result as string).trim();
    if (!answer || answer.length > 20000) throw new Error('Claude answer is empty or exceeds 20000 characters');
    if (/```|~~~/u.test(answer)) this.log('[admin-review] Answer contains a fenced code block; review before publication.');
    return { answer, exitCode, ...(typeof this.result.session_id === 'string' ? { sessionId: this.result.session_id } : {}), ...(typeof this.result.total_cost_usd === 'number' ? { costUsd: this.result.total_cost_usd } : {}) };
  }
}

/** Best-effort defense, not a guarantee that arbitrary project data contains no secrets. */
export function redactLog(text: string): string {
  return text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/sk-ant-[a-zA-Z0-9_-]+/g, '[REDACTED]')
    .replace(/(Bearer\s+)[a-zA-Z0-9._~+\/-]+/gi, '$1[REDACTED]')
    .replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|password)\s*["']?\s*[:=]\s*["']?)[^\s,"'}]+/gi, '$1[REDACTED]')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
}
