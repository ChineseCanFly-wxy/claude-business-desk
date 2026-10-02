import { cp, access } from 'node:fs/promises';
import { resolve } from 'node:path';
const source = resolve('apps/launcher/publish');
await access(resolve(source, 'ClaudeBusinessDesk.Launcher.exe'));
await cp(source, resolve('release'), { recursive: true });
console.log('Copied published Windows launcher into existing release.');
