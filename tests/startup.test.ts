import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { Store, defaultSettings } from '../apps/server/src/store.js';

test('client recovers when the network returns while admin and the backend stay running', { timeout: 90_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'desk-startup-test-'));
  const root = fileURLToPath(new URL('../', import.meta.url));
  const reservations = [createServer(), createServer(), createServer()];
  let child: ChildProcess | undefined, output = '', launchError: Error | undefined;
  let cookie = '', csrf = '';
  const occupied = createServer();
  const networkState = join(directory, 'network-state.json');
  async function until(check: () => unknown | Promise<unknown>, description: string, timeout = 10_000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) { if (await check()) return; await delay(50); }
    assert.fail(`${description}\n${output}`);
  }
  async function stop() {
    if (!child) return;
    const current = child;
    if (current.exitCode === null && current.signalCode === null) current.kill('SIGTERM');
    const force = setTimeout(() => current.kill('SIGKILL'), 1000);
    try { await until(() => current.exitCode !== null || current.signalCode !== null, 'Server did not exit', 5000); }
    finally { clearTimeout(force); }
    child = undefined;
  }
  function seed(clientHost: string, allowInsecureLan: boolean, adminPort: number, clientPort: number) {
    const store = new Store(directory);
    try { store.db.prepare('UPDATE settings SET value=? WHERE id=1').run(JSON.stringify({ ...defaultSettings, clientHost, allowInsecureLan, adminPort, clientPort })); }
    finally { store.close(); }
  }
  try {
    await Promise.all(reservations.map(server => new Promise<void>((resolve, reject) => {
      server.once('error', reject); server.listen({ host: '127.0.0.1', port: 0 }, resolve);
    })));
    const [adminPort, clientPort, guardPort] = reservations.map(server => (server.address() as { port: number }).port);
    await Promise.all(reservations.map(server => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))));
    assert.notEqual(adminPort, 4309); assert.notEqual(clientPort, 4309);
    // Keep the real startup path while isolating its OS-level single-instance port.
    // The installed workbench may be running on 4309 during local verification.
    const source = await readFile(new URL('../apps/server/src/main.ts', import.meta.url), 'utf8');
    assert.equal(source.match(/port: 4309/g)?.length, 1);
    const entry = join(directory, 'server-fixture.mts');
    await writeFile(entry, source
      .replace(/from '(\.\/[^']+)\.js'/g, (_match, module) => `from '${new URL(`../apps/server/src/${module.slice(2)}.ts`, import.meta.url).href}'`)
      .replace('port: 4309', `port: ${guardPort}`)
      .replace('homedir, networkInterfaces', 'homedir, networkInterfaces as systemNetworkInterfaces')
      + `\nfunction networkInterfaces() { return existsSync(${JSON.stringify(networkState)}) && !JSON.parse(readFileSync(${JSON.stringify(networkState)}, 'utf8')) ? {} : systemNetworkInterfaces(); }\n`);
    const adminUrl = `http://127.0.0.1:${adminPort}`;
    const clientUrl = `http://127.0.0.1:${clientPort}`;
    const api = (path: string, body?: unknown) => fetch(`${adminUrl}/api${path}`, {
      method: body === undefined ? 'GET' : 'POST', signal: AbortSignal.timeout(10_000),
      headers: { cookie, ...(body === undefined ? {} : { 'Content-Type': 'application/json', 'x-csrf-token': csrf }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }).catch((error: unknown) => {
      throw new Error(`Admin ${body === undefined ? 'GET' : 'POST'} ${path} failed: ${String(error)}\n${output}`, { cause: error });
    });
    async function start() {
      output = ''; launchError = undefined;
      child = spawn(process.execPath, ['--import', 'tsx', entry], {
        cwd: root, env: { ...process.env, DESK_DATA_DIR: directory }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      });
      child.once('error', error => { launchError = error; });
      for (const stream of [child.stdout, child.stderr]) stream?.on('data', chunk => { output = (output + chunk.toString()).slice(-16_000); });
      await until(async () => {
        assert.equal(launchError, undefined);
        assert.equal(child!.exitCode, null, output);
        try { const response = await api('/meta'); await response.arrayBuffer(); return response.status === 200; }
        catch { return false; }
      }, 'Admin did not become available');
      const connection = JSON.parse(await readFile(join(directory, 'connection.json'), 'utf8'));
      assert.equal(connection.adminPort, adminPort); assert.equal(connection.pid, child.pid);
    }
    async function settings() {
      const response = await api('/settings'); assert.equal(response.status, 200, await response.clone().text());
      return await response.json() as typeof defaultSettings & { clientError: string };
    }
    async function clientReady() {
      try {
        const response = await fetch(`${clientUrl}/api/meta`, { signal: AbortSignal.timeout(1000) });
        const body = await response.json() as { portal: string };
        return response.status === 200 && body.portal === 'client';
      } catch { return false; }
    }
    async function connection() {
      return JSON.parse(await readFile(join(directory, 'connection.json'), 'utf8')) as { pid: number; clientUrl: string | null; clientError: string };
    }
    async function recover() {
      const saved = await settings();
      const response = await api('/settings', { ...saved, clientHost: '127.0.0.1', allowInsecureLan: false });
      assert.equal(response.status, 200, await response.clone().text());
      assert.equal((await response.json() as { restartRequired: boolean }).restartRequired, true);
      await stop(); await start();
      await until(async () => {
        try { const response = await fetch(`${clientUrl}/api/meta`, { signal: AbortSignal.timeout(1000) });
          const body = await response.json() as { portal: string }; return response.status === 200 && body.portal === 'client'; }
        catch { return false; }
      }, 'Corrected client did not become available');
      assert.equal((await settings()).clientHost, '127.0.0.1');
      await stop();
    }

    seed('192.0.2.123', true, adminPort, clientPort);
    await start();
    await until(() => output.includes('等待公司网络'), 'Unavailable client address was not reported');
    const meta = await api('/meta'); assert.equal(meta.status, 200);
    cookie = meta.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
    const initial = await meta.json() as { needsSetup: boolean; csrfToken: string };
    assert.equal(initial.needsSetup, true); csrf = initial.csrfToken;
    const setup = await api('/setup', { username: 'freshadmin', password: 'startup-test-password' });
    assert.equal(setup.status, 200, await setup.clone().text());
    cookie = setup.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
    csrf = (await setup.json() as { csrfToken: string }).csrfToken;
    assert.equal((await settings()).clientHost, '192.0.2.123', 'Startup must preserve the saved client address');
    await recover();

    // Simulate network-interface changes without touching the host VPN or IP settings.
    seed('127.0.0.1', false, adminPort, clientPort);
    await writeFile(networkState, 'false');
    await start();
    const originalPid = child!.pid;
    assert.equal((await connection()).clientUrl, null);
    assert.match((await settings()).clientError, /等待公司网络/);
    assert.equal(await clientReady(), false);
    await writeFile(networkState, 'true');
    await until(clientReady, 'Client did not recover after the network connected');
    assert.equal((await connection()).pid, originalPid);
    assert.equal((await connection()).clientUrl, clientUrl);
    assert.equal((await settings()).clientError, '');
    assert.equal((await settings()).clientHost, '127.0.0.1');
    await writeFile(networkState, 'false');
    await until(async () => (await connection()).clientUrl === null && !(await clientReady()), 'Client did not stop when its network address disappeared');
    assert.equal((await api('/meta')).status, 200, 'Admin must remain available while the network is disconnected');
    await writeFile(networkState, 'true');
    await until(clientReady, 'Client did not recover after reconnecting');
    assert.equal((await connection()).pid, originalPid, 'Network recovery must not restart the backend');
    await stop();

    seed('127.0.0.1', false, adminPort, clientPort);
    await new Promise<void>((resolve, reject) => { occupied.once('error', reject); occupied.listen({ host: '127.0.0.1', port: clientPort, exclusive: true }, resolve); });
    await start();
    await until(() => output.includes('EADDRINUSE'), 'Client port conflict was not reported');
    assert.equal((await settings()).clientPort, clientPort);
    await new Promise<void>((resolve, reject) => occupied.close(error => error ? reject(error) : resolve()));
    await until(clientReady, 'Client did not recover after the port became available');
    assert.equal((await settings()).clientError, '');
    await stop();

    seed('0.0.0.0', false, adminPort, clientPort);
    await start();
    const blocked = await settings(); assert.equal(blocked.clientHost, '0.0.0.0'); assert.equal(blocked.allowInsecureLan, false);
    await assert.rejects(fetch(`${clientUrl}/api/meta`, { signal: AbortSignal.timeout(1000) }));
    await recover();
  } finally {
    try { await stop(); }
    finally {
      for (const server of [...reservations, occupied]) if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    }
  }
});
