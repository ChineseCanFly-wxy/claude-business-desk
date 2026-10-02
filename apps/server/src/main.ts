import { join } from 'node:path';
import { homedir, networkInterfaces } from 'node:os';
import { readFileSync, writeFileSync, existsSync, openSync, closeSync, unlinkSync } from 'node:fs';
import { Store } from './store.js';
import { Service } from './service.js';
import { createApp } from './app.js';
import { token } from './auth.js';
import { createServer } from 'node:net';
// A kernel-owned loopback socket serializes startup and is released on crashes.
// Acquire it before opening the database or recovering interrupted jobs.
const instanceGuard = createServer(socket => socket.destroy());
await new Promise<void>((resolve, reject) => {
  instanceGuard.once('error', reject);
  instanceGuard.listen({ host: '127.0.0.1', port: 4309, exclusive: true }, () => { instanceGuard.removeListener('error', reject); resolve(); });
});
const directory = process.env.DESK_DATA_DIR ?? join(process.env.LOCALAPPDATA ?? join(homedir(), '.local', 'share'), 'ClaudeBusinessDesk');
const store = new Store(directory);
const lockPath = join(directory, 'server.lock');
try {
  if (existsSync(lockPath)) {
    const pid = Number(readFileSync(lockPath, 'utf8'));
    let alive = false; try { process.kill(pid, 0); alive = true; } catch { /* stale lock */ }
    if (alive) throw new Error('已有服务实例正在运行');
    unlinkSync(lockPath);
  }
  const fd = openSync(lockPath, 'wx', 0o600); writeFileSync(fd, String(process.pid)); closeSync(fd);
} catch (error) { store.close(); throw error; }
const tokenPath = join(directory, 'launcher.token');
const launcherToken = token(); writeFileSync(tokenPath, launcherToken, { mode: 0o600 });
const settings = store.settings();
const service = new Service(store);
const admin = await createApp(store, service, 'admin', launcherToken);
const client = await createApp(store, service, 'client');
let closed = false;
const timer = setInterval(() => service.tick(), 1000);
async function stop() {
  if (closed) return; closed = true; clearInterval(timer);
  await service.stop();
  for (const app of [admin, client]) await app.close();
  store.close(); try { if (readFileSync(lockPath, 'utf8') === String(process.pid)) unlinkSync(lockPath); } catch { /* already removed */ }
  await new Promise<void>(resolve => instanceGuard.close(() => resolve()));
}
process.on('SIGINT', () => { void stop().then(() => process.exit(0)); });
process.on('SIGTERM', () => { void stop().then(() => process.exit(0)); });
try {
  await admin.listen({ host: '127.0.0.1', port: settings.adminPort });
  const connection = { adminPort: settings.adminPort, clientUrl: null as string | null, clientError: '', pid: process.pid };
  const publishConnection = () => writeFileSync(join(directory, 'connection.json'), JSON.stringify(connection), { mode: 0o600 });
  publishConnection(); // The local management entry remains available to repair client settings.
  try {
    if (!['127.0.0.1','::1'].includes(settings.clientHost) && !settings.allowInsecureLan) throw new Error('未授权非加密内网监听');
    await client.listen({ host: settings.clientHost, port: settings.clientPort });
    const lanAddress = Object.values(networkInterfaces()).flat().find(address => address?.family === 'IPv4' && !address.internal)?.address;
    const clientAddress = settings.clientHost === '0.0.0.0' ? (lanAddress ?? '127.0.0.1') : settings.clientHost;
    connection.clientUrl = `http://${clientAddress.includes(':') ? `[${clientAddress}]` : clientAddress}:${settings.clientPort}`;
  } catch (error) {
    service.clientError = connection.clientError = `客户入口未启动（${settings.clientHost}:${settings.clientPort}）：${error instanceof Error ? error.message : '监听失败'}。管理台仍可使用，请修改客户监听地址或端口，保存后从托盘停止并重新启动服务。`;
    console.error(connection.clientError);
    await client.close();
  }
  publishConnection();
  console.log(`管理页面：http://127.0.0.1:${settings.adminPort}\n客户页面：${connection.clientUrl ?? '未启动，请在管理台修正设置'}\n数据目录：${directory}\nClaude 调用需要双重人工审核；内网 HTTP 仅在明确授权时启用。`);
  service.tick();
} catch (error) { await stop(); throw error; }
