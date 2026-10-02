import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { runClaude } from '../apps/server/src/claude/runner.js';

const directory = await mkdtemp(join(tmpdir(), 'desk-visible-example-'));
try {
  await writeFile(join(directory, 'business.md'), '示例业务：员工提交报销申请后，直属主管审批；金额超过5000元还需要财务主管审批。审批通过后由财务付款。该文档为人工生成的测试资料，不是公司数据。');
  const result = await runClaude({ claudePath: join(homedir(), '.local', 'bin', 'claude.exe'), projectPath: directory, question: '请读取business.md，用两句话简要解释超过5000元的报销需要谁审批，不输出代码。', extraPrompt: '', mode: 'visible', timeoutSeconds: 1800, signal: new AbortController().signal, onLog: () => {} });
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await rm(directory, { recursive: true, force: true });
}
