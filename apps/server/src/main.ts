import { join } from 'node:path';
import { homedir, networkInterfaces } from 'node:os';
import { readFileSync, writeFileSync, existsSync, openSync, closeSync, unlinkSync } from 'node:fs';
import { Store } from './store.js';
import { Service } from './service.js';
import { createApp } from './app.js';
import { token } from './auth.js';
import { createServer, isIPv4 } from 'node:net';
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
let client: Awaited<ReturnType<typeof createApp>> | undefined;
let clientCheck: Promise<void> | undefined;
let clientTimer: ReturnType<typeof setInterval> | undefined;
const connection = { adminPort: settings.adminPort, clientUrl: null as string | null, clientError: '', pid: process.pid };
const publishConnection = () => writeFileSync(join(directory, 'connection.json'), JSON.stringify(connection), { mode: 0o600 });
function updateClientConnection(url: string | null, error = '') {
  if (closed || (connection.clientUrl === url && connection.clientError === error)) return;
  connection.clientUrl = url; connection.clientError = service.clientError = error;
  publishConnection();
  console.log(error || `客户页面：${url}`);
  service.notify();
}
async function checkClient() {
  if (closed) return;
  if (!['127.0.0.1','::1'].includes(settings.clientHost) && !settings.allowInsecureLan) {
    updateClientConnection(null, '客户入口未启动：未授权非加密内网监听。请修改设置后重新启动服务。');
    return;
  }
  const addresses = Object.values(networkInterfaces()).flat();
  if (isIPv4(settings.clientHost) && settings.clientHost !== '0.0.0.0' && !addresses.some(address => address?.address === settings.clientHost)) {
    const previous = client; client = undefined;
    updateClientConnection(null, `等待公司网络（${settings.clientHost}:${settings.clientPort}）：请登录公司网络，连接后自动恢复；每 5 秒检查一次。`);
    await previous?.close();
    return;
  }
  if (client) return;
  const candidate = await createApp(store, service, 'client');
  try {
    await candidate.listen({ host: settings.clientHost, port: settings.clientPort });
    client = candidate;
    const lanAddress = addresses.find(address => address?.family === 'IPv4' && !address.internal && !address.address.startsWith('169.254.'))?.address;
    const clientAddress = settings.clientHost === '0.0.0.0' ? (lanAddress ?? '127.0.0.1') : settings.clientHost;
    updateClientConnection(`http://${clientAddress.includes(':') ? `[${clientAddress}]` : clientAddress}:${settings.clientPort}`);
  } catch (error) {
    await candidate.close();
    const waiting = (error as NodeJS.ErrnoException).code === 'EADDRNOTAVAIL';
    updateClientConnection(null, waiting
      ? `等待公司网络（${settings.clientHost}:${settings.clientPort}）：请登录公司网络，连接后自动恢复；每 5 秒检查一次。`
      : `客户入口未启动（${settings.clientHost}:${settings.clientPort}）：${error instanceof Error ? error.message : '监听失败'}。每 5 秒重试；请检查监听地址或端口，配置变更后重新启动服务。`);
  }
}
function refreshClient() {
  if (closed || clientCheck) return clientCheck;
  clientCheck = checkClient().finally(() => { clientCheck = undefined; });
  return clientCheck;
}
let closed = false;
const timer = setInterval(() => service.tick(), 1000);
async function stop() {
  if (closed) return; closed = true; clearInterval(timer);
  clearInterval(clientTimer);
  await clientCheck;
  await service.stop();
  await client?.close();
  await admin.close();
  store.close(); try { if (readFileSync(lockPath, 'utf8') === String(process.pid)) unlinkSync(lockPath); } catch { /* already removed */ }
  await new Promise<void>(resolve => instanceGuard.close(() => resolve()));
}
process.on('SIGINT', () => { void stop().then(() => process.exit(0)); });
process.on('SIGTERM', () => { void stop().then(() => process.exit(0)); });
try {
  await admin.listen({ host: '127.0.0.1', port: settings.adminPort });
  publishConnection(); // The local management entry remains available to repair client settings.
  await refreshClient();
  clientTimer = setInterval(() => { void refreshClient()?.catch(error => console.error('检查客户入口失败：', error)); }, 5000);
  console.log(`管理页面：http://127.0.0.1:${settings.adminPort}\n客户页面：${connection.clientUrl ?? connection.clientError}\n数据目录：${directory}\nClaude 调用需要双重人工审核；内网 HTTP 仅在明确授权时启用。`);
  service.tick();
} catch (error) { await stop(); throw error; }
