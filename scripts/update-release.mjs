import { cp, access } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
await access(resolve(root, 'release/runtime/node.exe'));
for (const path of ['dist', 'docs', 'README.md']) await cp(resolve(root, path), resolve(root, 'release', path), { recursive: true });
console.log('Updated existing release application and documentation; no user data touched.');
