/** Match the native host's Windows CreateProcess argument quoting, measured in UTF-16 units. */
export function quoteWindowsArgument(value: string): string {
  let result = '"', slashes = 0;
  for (const character of value) {
    if (character === '\\') { slashes++; continue; }
    result += '\\'.repeat(character === '"' ? slashes * 2 + 1 : slashes) + character;
    slashes = 0;
  }
  return result + '\\'.repeat(slashes * 2) + '"';
}
export function validateWindowsCommand(executable: string, args: string[]): void {
  const command = [executable, ...args].map(quoteWindowsArgument).join(' ');
  if (command.length + 1 >= 32767) throw new Error('对话上下文过长，超过 Windows 终端启动上限，请开启新问题');
}
export function validateBusinessInput(question: string, combinedPrompt: string, claudePath: string): void {
  if (typeof question !== 'string' || !question.trim() || question.includes('\0') || combinedPrompt.includes('\0')) throw new Error('问题或业务指令无效');
  if (Buffer.byteLength(question) + Buffer.byteLength(combinedPrompt) > 256 * 1024) throw new Error('对话上下文过长，请开启新问题');
  // Reserve enough space for the UUID, flags and realpath differences.
  const length = [claudePath, question, combinedPrompt].map(quoteWindowsArgument).join(' ').length;
  if (length + 4096 >= 32767) throw new Error('对话上下文过长，超过 Windows 终端启动上限，请开启新问题');
}
