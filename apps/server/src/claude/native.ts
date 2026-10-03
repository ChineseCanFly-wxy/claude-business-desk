import { spawn } from 'node:child_process';
import { writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ClaudeProtocol, redactLog, type ClaudeResult } from './protocol.js';
import type { RunnerOptions } from './runner.js';
import { buildBusinessPrompt } from './prompt.js';
import { validateWindowsCommand } from './limits.js';
export async function buildNativeArguments(options: RunnerOptions, sessionId: string, dir: string, host: string): Promise<string[]> {
  const args = ['--permission-mode', options.mode === 'hidden' ? 'auto' : 'bypassPermissions', ...(options.resumeSessionId ? ['--resume', options.resumeSessionId] : ['--session-id', sessionId]), '--system-prompt-snapshot', 'off', '--append-system-prompt', buildBusinessPrompt(options.extraPrompt, options.fixedPrompt)];
  if (options.mode === 'hidden') args.unshift('-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--permission-prompts', 'none');
  else {
    const settings = join(dir, 'collector-settings.json');
    // Claude hooks use their documented shell command contract; executable/task invocation remains shell-free.
    if (/["%\r\n]/.test(host + dir)) throw new Error('Unsupported hook command path');
    const command = `"${host}" --collect "${dir}"`;
    await writeFile(settings, JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command }] }], StopFailure: [{ hooks: [{ type: 'command', command }] }] } }), { flag: 'wx' });
    args.push('--settings', settings, '--', options.question);
  }
  return args;
}

async function visibleResult(path: string, sessionId: string): Promise<ClaudeResult> {
  let value: unknown;
  try { value = JSON.parse(await readFile(path, 'utf8')); }
  catch { throw new Error('可见 Claude 终端未生成可验证的最终答案，请在终端正常完成回答，系统会自动收取答案'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid native completion');
  const result = value as Record<string, unknown>;
  if (result.sessionId !== sessionId || typeof result.answer !== 'string' || !result.answer.trim() || result.answer.length > 20000 || result.exitCode !== 0) throw new Error('Invalid native completion');
  if (result.costUsd !== undefined && (typeof result.costUsd !== 'number' || !Number.isFinite(result.costUsd) || result.costUsd < 0)) throw new Error('Invalid native completion');
  return { answer: result.answer.trim(), sessionId, exitCode: 0, ...(typeof result.costUsd === 'number' ? { costUsd: result.costUsd } : {}) };
}

export async function runNative(options: RunnerOptions, cli: string, cwd: string, dir: string, host: string): Promise<ClaudeResult> {
  const sessionId = options.resumeSessionId ?? randomUUID();
  const args = await buildNativeArguments(options, sessionId, dir, host);
  validateWindowsCommand(cli, args);
  const env = { ...process.env }; delete env.CLAUDECODE;
  const task = join(dir, 'task.json');
  await writeFile(task, JSON.stringify({ executable: cli, cwd, arguments: args, environment: env, sessionId, question: options.question, mode: options.mode }), { flag: 'wx' });
  const protocol = options.mode === 'hidden' ? new ClaudeProtocol(options.onLog, undefined, undefined, sessionId) : undefined;
  return await new Promise<ClaudeResult>((resolve, reject) => {
    const child = spawn(host, ['--task', task], { shell: false, windowsHide: options.mode === 'hidden', detached: options.mode === 'visible', stdio: options.mode === 'hidden' ? ['ignore', 'pipe', 'pipe'] : 'ignore' });
    let failure: Error | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const stop = (message: string) => {
      failure ||= new Error(message);
      // Closing a stuck host also closes its kill-on-close JobObject; only close releases the queue slot.
      killTimer ??= setTimeout(() => child.kill(), 10000);
      void writeFile(join(dir, 'cancel'), '').catch(() => child.kill());
    };
    const abort = () => stop('Claude run aborted');
    options.signal.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => stop('Claude run timed out'), options.timeoutSeconds * 1000);
    child.stdout?.on('data', (chunk: Buffer) => { try { protocol!.push(chunk); } catch (e) { stop(e instanceof Error ? e.message : 'Protocol failed'); } });
    const errors: Buffer[] = []; let size = 0;
    child.stderr?.on('data', (chunk: Buffer) => { size += chunk.length; if (size > 1024 * 1024) stop('Claude stderr limit exceeded'); else errors.push(chunk); });
    child.once('error', error => { clearTimeout(timer); clearTimeout(killTimer); options.signal.removeEventListener('abort', abort); reject(error); });
    child.once('close', async code => {
      clearTimeout(timer); clearTimeout(killTimer); options.signal.removeEventListener('abort', abort);
      try {
        if (failure) throw failure;
        if (code !== 0) {
          const detail = await readFile(join(dir, 'error.txt'), 'utf8').catch(() => '');
          throw new Error(redactLog(detail || Buffer.concat(errors).toString()).slice(0, 2000) || `Native Claude terminal failed (exit ${code})`);
        }
        resolve(options.mode === 'hidden' ? protocol!.finish(code) : await visibleResult(join(dir, 'result.json'), sessionId));
      } catch (error) { reject(error); }
    });
    if (options.signal.aborted) abort();
  });
}
