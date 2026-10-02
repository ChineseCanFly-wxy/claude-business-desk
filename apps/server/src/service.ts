import { randomUUID, createHash } from 'node:crypto';
import { Store } from './store.js';
import { runClaude, validatePromptInput, buildBusinessPrompt, type RunnerOptions } from './claude/runner.js';
import { contextSnapshotSchema, renderQuestionInput } from './context.js';
export type Executor = (options: RunnerOptions) => ReturnType<typeof runClaude>;
export class Service {
  listeners = new Set<() => void>();
  current?: { questionId: string; controller: AbortController; promise: Promise<void> };
  stopping = false;
  clientError = '';
  constructor(public store: Store, private executor: Executor = runClaude) {
    const now = new Date().toISOString();
    store.transaction(() => {
      store.db.prepare("UPDATE questions SET status='failed',error='服务在执行中中断；请管理员确认旧进程已退出后重试',updated_at=? WHERE status='running'").run(now);
      store.db.prepare("UPDATE runs SET status='interrupted',ended_at=?,error='服务中断，未自动重试' WHERE status='running'").run(now);
    });
  }
  notify() { for (const listener of this.listeners) listener(); }
  tick() {
    if (this.current || this.stopping) return;
    const q = this.store.db.prepare("SELECT q.*,p.path,p.enabled project_enabled,u.enabled user_enabled FROM questions q JOIN projects p ON p.id=q.project_id JOIN users u ON u.id=q.user_id WHERE q.status='queued' ORDER BY q.created_at LIMIT 1").get() as any;
    if (!q) return;
    const grant = this.store.db.prepare('SELECT 1 FROM grants WHERE user_id=? AND project_id=?').get(q.user_id, q.project_id);
    if (!q.project_enabled || !q.user_enabled || !grant) {
      this.store.db.prepare("UPDATE questions SET status='failed',error='账号、项目或授权已停用',updated_at=? WHERE id=? AND status='queued'").run(new Date().toISOString(), q.id);
      this.notify(); queueMicrotask(() => this.tick()); return;
    }
    const id = randomUUID(); const now = new Date().toISOString();
    this.store.transaction(() => {
      this.store.db.prepare("UPDATE questions SET status='running',error=NULL,updated_at=? WHERE id=? AND status='queued'").run(now, q.id);
      this.store.db.prepare("INSERT INTO runs(id,question_id,status,started_at) VALUES(?,?,'running',?)").run(id, q.id, now);
    });
    const controller = new AbortController();
    // Install the slot before execute can synchronously reject snapshot/input validation.
    const current = { questionId: q.id, controller, promise: Promise.resolve() };
    this.current = current;
    current.promise = this.execute(q, id, controller);
    this.notify();
  }
  private async execute(q: any, id: string, controller: AbortController) {
    let logs = ''; let lastWrite = 0;
    const flush = () => { this.store.db.prepare('UPDATE runs SET logs=? WHERE id=?').run(logs, id); };
    try {
      const settings = this.store.settings();
      const snapshot = contextSnapshotSchema.parse(JSON.parse(q.context_snapshot));
      const input = renderQuestionInput(q.question, snapshot);
      this.store.db.prepare('UPDATE runs SET input_snapshot=? WHERE id=?').run(JSON.stringify({ formatVersion: 1, question: input, inputSha256: createHash('sha256').update(JSON.stringify({ question: input, systemPrompt: buildBusinessPrompt(settings.extraPrompt) })).digest('hex'), contextSnapshot: snapshot, systemPrompt: buildBusinessPrompt(settings.extraPrompt), extraPrompt: settings.extraPrompt, claudePath: settings.claudePath, mode: settings.mode }), id);
      validatePromptInput(input, settings.extraPrompt, settings.claudePath);
      const result = await this.executor({ claudePath: settings.claudePath, projectPath: q.path, question: input, extraPrompt: settings.extraPrompt, mode: settings.mode, timeoutSeconds: settings.timeoutSeconds, signal: controller.signal, onLog: text => {
        logs = (logs + text + '\n').slice(-200_000);
        if (Date.now() - lastWrite > 500) { flush(); lastWrite = Date.now(); }
      } });
      if (controller.signal.aborted) throw new Error('已取消');
      const now = new Date().toISOString();
      this.store.transaction(() => {
        flush();
        this.store.db.prepare("UPDATE runs SET status='completed',ended_at=?,exit_code=?,session_id=?,cost_usd=? WHERE id=?").run(now, result.exitCode, result.sessionId ?? null, result.costUsd ?? null, id);
        this.store.db.prepare("UPDATE questions SET status='pending_answer_review',draft_answer=?,updated_at=? WHERE id=? AND status='running'").run(result.answer, now, q.id);
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : '调用失败'; const now = new Date().toISOString();
      const status = controller.signal.aborted ? 'cancelled' : 'failed';
      this.store.transaction(() => {
        flush();
        this.store.db.prepare('UPDATE runs SET status=?,ended_at=?,error=? WHERE id=?').run(status, now, message.slice(0, 2000), id);
        this.store.db.prepare('UPDATE questions SET status=?,error=?,updated_at=? WHERE id=? AND status=\'running\'').run(status, message.slice(0, 2000), now, q.id);
      });
    } finally {
      this.current = undefined; this.notify(); queueMicrotask(() => this.tick());
    }
  }
  async stop() { this.stopping = true; this.current?.controller.abort(); await this.current?.promise; }
}
