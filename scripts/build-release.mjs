import { cp, mkdir, access, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workspaceDir = name => {
  const target = path.resolve(root, name);
  if (path.dirname(target) !== root) throw new Error(`Packaging path must stay directly inside the workspace: ${target}`);
  return target;
};
const release = workspaceDir('release');
const staging = workspaceDir('release-staging');
const backup = workspaceDir('release-backup');
const exists = async p => { try { await access(p); return true; } catch { return false; } };
const run = (command, args, label) => {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${label} failed (${result.status}).`);
};
if (!(await exists(path.join(root, 'apps/server/src/main.ts')))) throw new Error('Server source is not ready. Packaging does not run until apps/server/src/main.ts exists.');
if (!(await exists(path.join(root, 'node_modules')))) throw new Error('Run npm install in the source checkout first.');
if (process.platform !== 'win32') throw new Error('Build this Windows release on Windows so runtime/node.exe and native dependencies match.');
if (process.arch !== 'x64') throw new Error(`This release targets win-x64, not ${process.arch}.`);
const dist = path.join(root, 'dist');
for (const name of ['server', 'web']) {
  const generated = path.resolve(dist, name);
  if (path.dirname(generated) !== dist) throw new Error(`Invalid generated output path: ${generated}`);
  await rm(generated, { recursive: true, force: true });
}
// npm.cmd requires cmd.exe on Windows. No user-controlled shell arguments.
run(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'npm run build'], 'npm build');
if (!(await exists(path.join(root, 'dist/server/main.js')))) throw new Error('Build did not produce dist/server/main.js.');
if (await exists(backup) && !(await exists(release))) {
  await rename(backup, release);
  console.log(`Recovered the previous release from ${backup}.`);
}
await rm(staging, { recursive: true, force: true });
await mkdir(path.join(staging, 'runtime'), { recursive: true });
await cp(process.execPath, path.join(staging, 'runtime/node.exe'));
for (const name of ['server', 'web']) await cp(path.join(root, 'dist', name), path.join(staging, 'dist', name), { recursive: true });
run('dotnet', ['publish', 'apps/native-host/ClaudeTerminalHost.csproj', '-c', 'Release', '-r', 'win-x64', '--self-contained', 'true', '-p:PublishSingleFile=true', '-o', path.join(staging, 'dist/native')], 'native host publish');
run('dotnet', ['publish', 'apps/launcher/ClaudeBusinessDesk.Launcher.csproj', '-c', 'Release', '-r', 'win-x64', '--self-contained', 'true', '-o', staging], 'launcher publish');
// Copy the complete dependency tree, including native bindings and transitive dependencies.
await cp(path.join(root, 'node_modules'), path.join(staging, 'node_modules'), { recursive: true, dereference: true });
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
await writeFile(path.join(staging, 'package.json'), JSON.stringify({ name: pkg.name, version: pkg.version, private: true, type: pkg.type ?? 'module' }, null, 2));
await mkdir(path.join(staging, 'scripts'), { recursive: true });
for (const name of ['启动.cmd', 'start.ps1']) await cp(path.join(root, 'scripts', name), path.join(staging, 'scripts', name));
await cp(path.join(root, 'README.md'), path.join(staging, 'README.md'));
if (await exists(path.join(root, 'docs'))) await cp(path.join(root, 'docs'), path.join(staging, 'docs'), { recursive: true });
for (const artifact of ['runtime/node.exe', 'dist/server/main.js', 'dist/web/index.html', 'dist/native/ClaudeTerminalHost.exe', 'ClaudeBusinessDesk.Launcher.exe']) {
  if (!(await exists(path.join(staging, artifact)))) throw new Error(`Incomplete staged release. Missing: ${artifact}`);
}

let previousRelease = false;
try {
  await rm(backup, { recursive: true, force: true });
  if (await exists(release)) {
    await rename(release, backup);
    previousRelease = true;
  }
  await rename(staging, release);
} catch (error) {
  if (previousRelease && !(await exists(release)) && await exists(backup)) {
    try { await rename(backup, release); }
    catch (rollbackError) { throw new AggregateError([error, rollbackError], `Release replacement failed; recover ${backup} manually.`); }
  }
  throw error;
}
if (previousRelease) console.log(`Previous release retained at ${backup}.`);
console.log(`Release: ${release}\nNode: ${process.version} (${process.arch}). No data, .env, tokens or Claude login credentials copied.`);
