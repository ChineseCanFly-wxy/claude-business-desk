import assert from 'node:assert/strict';
import { readdir, readFile, stat } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const directory = resolve(root, process.argv[2] || 'release');
const source = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const packaged = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
assert.equal(packaged.version, source.version, 'Packaged version must match package.json');
assert.equal(packaged.type, 'module');
for (const file of ['ClaudeBusinessDesk.Launcher.exe', 'ClaudeBusinessDesk.Launcher.dll', 'ClaudeBusinessDesk.Launcher.runtimeconfig.json', 'runtime/node.exe', 'dist/native/ClaudeTerminalHost.exe', 'dist/server/main.js', 'dist/web/index.html', 'README.md', 'CHANGELOG.md', 'LICENSE', 'docs/deployment.md', 'docs/RELEASING.md', 'scripts/启动.cmd', 'scripts/start.ps1']) {
  assert.ok((await stat(join(directory, file))).size > 0, 'Missing or empty release file: ' + file);
}
let files = 0;
async function inspect(path) {
  for (const entry of await readdir(path, { withFileTypes: true })) {
    assert.ok(!entry.isSymbolicLink(), 'Release must be self-contained: ' + join(path, entry.name));
    assert.ok(!['.git', '.claude', '.codex', 'launcher.token', 'connection.json'].includes(entry.name), 'Local configuration or credentials in release: ' + entry.name);
    assert.ok(!/^\.env(?:\.|$)/i.test(entry.name) && !/\.(?:sqlite3?|db)(?:-(?:wal|shm|journal))?$|\.log$/i.test(entry.name), 'Local data or logs in release: ' + entry.name);
    if (entry.isDirectory()) await inspect(join(path, entry.name));
    else files++;
  }
}
await inspect(directory);
const runtime = spawnSync(join(directory, 'runtime/node.exe'), ['--input-type=module', '-e', "await import('./dist/server/app.js'); await import('./dist/server/service.js'); console.log(JSON.stringify({node:process.version,arch:process.arch}));"], { cwd: directory, shell: false, windowsHide: true, encoding: 'utf8', timeout: 30000 });
if (runtime.error) throw runtime.error;
assert.equal(runtime.status, 0, runtime.stderr || runtime.stdout);
const loaded = JSON.parse(runtime.stdout.trim());
assert.equal(loaded.arch, 'x64');
const html = await readFile(join(directory, 'dist/web/index.html'), 'utf8');
const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^"?]+)"/g)].map(match => match[1]);
assert.ok(assets.some(file => file.endsWith('.js')) && assets.some(file => file.endsWith('.css')));
for (const asset of assets) assert.ok((await stat(join(directory, 'dist/web', asset.slice(1)))).size > 0);
console.log('Release v' + packaged.version + ' verified: ' + files + ' files, bundled ' + loaded.node + ', server dependencies and frontend assets load; no local data, credentials or logs.');
