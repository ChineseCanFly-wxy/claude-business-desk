import { spawn } from 'node:child_process';
import { realpath, stat, mkdtemp, rm } from 'node:fs/promises';
import { delimiter, isAbsolute, join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { runNative } from './native.js';
import { materializeAttachments, attachmentPrompt, type ExecutionAttachment, type AttachmentInput } from '../attachments.js';
import { validateBusinessInput } from './limits.js';
import { buildBusinessPrompt } from './prompt.js';
export { buildBusinessPrompt } from './prompt.js';
import { redactLog, type ClaudeResult } from './protocol.js';

export interface RunnerOptions {
  claudePath: string;
  projectPath: string;
  question: string;
  attachments?: ExecutionAttachment[];
  attachmentInputs?: AttachmentInput[];
  attachmentDirectory?: string;
  extraPrompt: string;
  /** Omitted by standalone tools to retain the default business instructions. */
  fixedPrompt?: string;
  mode: 'hidden' | 'visible';
  /** Only a previously published turn of this user and conversation may supply a session. */
  resumeSessionId?: string;
  timeoutSeconds: number;
  /** Administrative diagnostics only. Caller must enforce admin authorization; may contain project data. */
  onLog: (text: string) => void;
  signal: AbortSignal;
}
const REQUIRED = ['--output-format', '--verbose', '--include-partial-messages', '--session-id', '--resume', '--system-prompt-snapshot', '--permission-mode', '--permission-prompts', '--append-system-prompt'];
const windows = process.platform === 'win32';
export function validatePromptInput(question: string, extraPrompt: string, claudePath: string, fixedPrompt?: string): void {
  validateBusinessInput(question, buildBusinessPrompt(extraPrompt, fixedPrompt), claudePath);
}
function localPath(path: string): void {
  if (!isAbsolute(path) || /^(?:\\\\|\/\/)/.test(path) || path.includes('\0')) throw new Error('Absolute local path required; UNC/device paths are forbidden');
}
async function executable(path: string): Promise<string> {
  localPath(path);
  const resolved = await realpath(path);
  localPath(resolved);
  if (windows && !resolved.toLowerCase().endsWith('.exe')) throw new Error('Native CLI .exe required, not a command shim');
  if (!(await stat(resolved)).isFile()) throw new Error('CLI is not a regular file');
  return resolved;
}
function systemExecutable(name: string): string {
  const root = process.env.SystemRoot;
  if (!root || !/^[A-Za-z]:[\\/]/.test(root) || root.includes('\0')) throw new Error('Invalid Windows system directory');
  return join(root, 'System32', name);
}
function capture(path: string, args: string[], timeout: number): Promise<{ code: number; text: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(path, args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let text = '', bytes = 0, failure: Error | undefined;
    const timer = setTimeout(() => { failure = new Error('CLI inspection timed out'); child.kill(); }, timeout);
    for (const stream of [child.stdout, child.stderr]) stream.on('data', (data: Buffer) => {
      bytes += data.length;
      if (bytes > 512 * 1024) { failure = new Error('CLI inspection output exceeded limit'); child.kill(); } else text += data.toString('utf8');
    });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => { clearTimeout(timer); if (failure) reject(failure); else resolve({ code: code ?? -1, text }); });
  });
}
export async function probeClaude(path: string): Promise<{ ok: boolean; version: string; message: string }> {
  let version = '';
  try {
    const cli = await executable(path);
    const v = await capture(cli, ['--version'], 10000);
    version = redactLog(v.text.trim()).slice(0, 200);
    if (v.code !== 0 || !/^\d+\.\d+\.\d+\b/.test(version)) throw new Error('Could not verify Claude version');
    const help = await capture(cli, ['--help'], 10000);
    if (help.code !== 0) throw new Error('Could not inspect Claude help');
    const missing = REQUIRED.filter(flag => !help.text.includes(flag));
    if (missing.length) throw new Error(`Unsupported CLI flags: ${missing.join(', ')}`);
    const permissionHelp = help.text.slice(help.text.indexOf('--permission-mode'), help.text.indexOf('--permission-mode') + 1000);
    const missingModes = ['auto', 'bypassPermissions'].filter(mode => !new RegExp(`\\b${mode}\\b`).test(permissionHelp));
    if (missingModes.length) throw new Error(`Unsupported CLI permission modes: ${missingModes.join(', ')}`);
    return { ok: true, version, message: 'Required CLI flags verified; authentication and model access are not probed.' };
  } catch (error) {
    return { ok: false, version, message: redactLog(error instanceof Error ? error.message : 'CLI inspection failed') };
  }
}

export function claudeCandidates(environment: NodeJS.ProcessEnv = process.env): string[] {
  const home = environment.USERPROFILE || homedir();
  const paths = [join(home, '.local', 'bin'), environment.LOCALAPPDATA && join(environment.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links'), ...(environment.PATH || environment.Path || '').split(delimiter)];
  return [...new Set(paths.filter((path): path is string => !!path).map(path => path.trim().replace(/^"(.*)"$/, '$1')).filter(path => isAbsolute(path) && !/^(?:\\\\|\/\/)/.test(path) && !/[\x00-\x1f]/.test(path) && !/[\\/]WindowsApps(?:[\\/]|$)/i.test(path)).map(path => join(path, 'claude.exe')))];
}

export async function discoverClaude(candidates = claudeCandidates()): Promise<{ path: string | null; version: string; message: string }> {
  let incompatible = false;
  for (const candidate of candidates) {
    let path: string;
    try { path = await executable(candidate); } catch { continue; }
    const result = await probeClaude(path);
    if (result.ok) return { path, version: result.version, message: '已找到并验证 Claude Code，可保存此路径' };
    incompatible = true;
  }
  return { path: null, version: '', message: incompatible ? '找到了 Claude 程序，但当前版本不支持所需功能，请更新 Claude Code 后重新查找' : '未找到可用的 Claude Code，请先安装，或通过浏览选择已安装的 EXE' };
}

async function privateDirectory(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'claude-desk-'));
  try {
    localPath(await realpath(dir));
    // Set the ACL before any project/question content is written. SID is data, never interpolated into a command.
    const who = await capture(systemExecutable('whoami.exe'), ['/user', '/fo', 'csv', '/nh'], 5000);
    const sid = who.text.match(/S-1-5-(?:\d+-)*\d+/)?.[0];
    if (who.code !== 0 || !sid) throw new Error('Cannot identify log owner');
    const acl = await capture(systemExecutable('icacls.exe'), [dir, '/inheritance:r', '/grant:r', `*${sid}:(OI)(CI)F`, '*S-1-5-18:(OI)(CI)F'], 5000);
    if (acl.code !== 0) throw new Error('Cannot protect temporary log directory');
    return dir;
  } catch (error) { await rm(dir, { recursive: true, force: true }); throw error; }
}

export async function runClaude(options: RunnerOptions): Promise<ClaudeResult> {
  if (options.signal.aborted) throw new Error('Claude run aborted');
  if (!['hidden', 'visible'].includes(options.mode) || !Number.isFinite(options.timeoutSeconds) || options.timeoutSeconds <= 0 || options.timeoutSeconds > 86400) throw new Error('Invalid runner options');
  if (typeof options.question !== 'string' || !options.question.trim() || typeof options.extraPrompt !== 'string' || Buffer.byteLength(options.question) + Buffer.byteLength(options.extraPrompt) > 256 * 1024) throw new Error('Invalid or oversized prompt');
  if (options.fixedPrompt !== undefined && (typeof options.fixedPrompt !== 'string' || !options.fixedPrompt.trim())) throw new Error('Invalid fixed business prompt');
  validatePromptInput(options.question, options.extraPrompt, options.claudePath, options.fixedPrompt);
  if (options.resumeSessionId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(options.resumeSessionId)) throw new Error('Invalid resume session');
  const cli = await executable(options.claudePath);
  localPath(options.projectPath);
  const cwd = await realpath(options.projectPath);
  localPath(cwd);
  if (!(await stat(cwd)).isDirectory()) throw new Error('Project path is not a directory');
  const probe = await probeClaude(cli);
  if (!probe.ok) throw new Error(probe.message);
  const dir = await privateDirectory();
  try {
    const host = await executable(process.env.CLAUDE_DESK_NATIVE_HOST || join(process.cwd(), 'dist', 'native', 'ClaudeTerminalHost.exe'));
    const attachmentDirectory = join(dir, 'attachments');
    const attachmentInputs = await materializeAttachments(options.attachments ?? [], attachmentDirectory);
    const question = attachmentPrompt(options.question, attachmentInputs);
    validatePromptInput(question, options.extraPrompt, options.claudePath, options.fixedPrompt);
    return await runNative({ ...options, question, attachmentInputs, ...(attachmentInputs.length ? { attachmentDirectory } : {}) }, cli, cwd, dir, host);
  } finally { await rm(dir, { recursive: true, force: true }); }
}
