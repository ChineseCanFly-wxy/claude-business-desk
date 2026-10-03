import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { runClaude } from '../apps/server/src/claude/runner.js';

const directory = await mkdtemp(join(tmpdir(), 'desk-visible-example-'));
try {
  await writeFile(join(directory, 'business.md'), '示例业务：员工提交报销申请后，直属主管审批；金额超过5000元还需要财务主管审批。审批通过后由财务付款。该文档为人工生成的测试资料，不是公司数据。');
  const result = await runClaude({ claudePath: join(homedir(), '.local', 'bin', 'claude.exe'), projectPath: directory, question: '请读取business.md，用两句话简要解释超过5000元的报销需要谁审批，不输出代码。', extraPrompt: '', mode: 'visible', timeoutSeconds: 1800, signal: new AbortController().signal, onLog: () => {} });
  assert.ok(result.sessionId);
  const followup = await runClaude({ claudePath: join(homedir(), '.local', 'bin', 'claude.exe'), projectPath: directory, question: '刚才资料中的额外审批金额门槛是多少？只回答金额，不重新读取文件。', extraPrompt: '', mode: 'visible', resumeSessionId: result.sessionId, timeoutSeconds: 1800, signal: new AbortController().signal, onLog: () => {} });
  assert.equal(followup.sessionId, result.sessionId);
  assert.match(followup.answer, /5[,.]?000|五千/);
  console.log(JSON.stringify({ answer: result.answer, followup: followup.answer, sameSession: true, automaticExit: true, exitCode: followup.exitCode }, null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await rm(directory, { recursive: true, force: true });
}
