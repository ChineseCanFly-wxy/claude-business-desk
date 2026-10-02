import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { runClaude } from '../apps/server/src/claude/runner.js';
const directory = await mkdtemp(join(tmpdir(), 'desk-approved-example-'));
try {
  await writeFile(join(directory, 'business.md'), '示例业务：员工提交报销申请后，直属主管审批；金额超过5000元还需要财务主管审批。审批通过后由财务付款。该文档为人工生成的测试资料，不是公司数据。');
  const logs: string[] = [];
  const result = await runClaude({ claudePath: join(homedir(), '.local', 'bin', 'claude.exe'), projectPath: directory, question: '请读取business.md，用两句话简要解释超过5000元的报销需要谁审批，不输出代码。', extraPrompt: '', mode: 'hidden', timeoutSeconds: 120, signal: new AbortController().signal, onLog: text => logs.push(text) });
  console.log(JSON.stringify({ answer: result.answer, exitCode: result.exitCode, costUsd: result.costUsd, events: logs.length }, null, 2));
} catch (error) { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; }
finally { await rm(directory, { recursive: true, force: true }); }
