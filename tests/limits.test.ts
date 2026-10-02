import test from 'node:test';
import assert from 'node:assert/strict';
import { quoteWindowsArgument, validateWindowsCommand } from '../apps/server/src/claude/limits.js';
import { validatePromptInput } from '../apps/server/src/claude/runner.js';

test('Windows arguments quote Unicode, trailing slashes and embedded quotes like native host', () => {
  assert.equal(quoteWindowsArgument('中文 空格'), '"中文 空格"');
  assert.equal(quoteWindowsArgument('a"b'), '"a\\"b"');
  assert.equal(quoteWindowsArgument('C:\\test\\'), '"C:\\test\\\\"');
  assert.equal(quoteWindowsArgument(''), '""');
});
test('shared prompt bounds count UTF16 argument escapes and reserve native startup space', () => {
  assert.doesNotThrow(() => validatePromptInput('正常业务问题', '补充说明', 'C:\\Claude\\claude.exe'));
  assert.throws(() => validatePromptInput('汉'.repeat(32000), '', 'C:\\claude.exe'), /开启新问题/);
  assert.throws(() => validatePromptInput('"'.repeat(17000), '', 'C:\\claude.exe'), /开启新问题/);
  assert.throws(() => validatePromptInput('a\0b', '', 'C:\\claude.exe'), /无效/);
  assert.throws(() => validatePromptInput('a'.repeat(256 * 1024), '', ''), /开启新问题/);
});
test('final actual command is checked against Windows hard limit including terminator', () => {
  assert.doesNotThrow(() => validateWindowsCommand('C:\\claude.exe', ['--', '短问题']));
  assert.throws(() => validateWindowsCommand('C:\\claude.exe', ['--', 'x'.repeat(32760)]), /终端启动上限/);
});
