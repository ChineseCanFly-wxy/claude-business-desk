import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { isAbsolute, resolve } from 'node:path';

function nativeTool(relative: string, fallback: string): string | undefined {
  if (process.platform !== 'win32') return;
  const bundled = fileURLToPath(new URL(relative, import.meta.url));
  return [bundled, resolve(fallback)].find(existsSync);
}

function runTool(executable: string, args: string[], timeout: number, visible = false): Promise<any> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { shell: false, windowsHide: !visible, stdio: ['ignore', 'pipe', 'ignore'] });
    let output = '', failure: Error | undefined;
    const timer = setTimeout(() => { failure = Object.assign(new Error('操作超时，请重试'), { statusCode: 408 }); child.kill(); }, timeout);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', text => { output += text; if (output.length > 8192) { failure = new Error('原生工具返回内容过长'); child.kill(); } });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => {
      clearTimeout(timer);
      if (failure) return reject(failure);
      try {
        const result = JSON.parse(output.replace(/^\uFEFF/, '').trim());
        if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('原生工具返回无效结果');
        if (code !== 0) return reject(Object.assign(new Error(typeof result.message === 'string' ? result.message : '原生工具异常退出'), { statusCode: 400 }));
        resolve(result);
      } catch { reject(new Error('原生工具返回无效结果')); }
    });
  });
}

let busy = false;
export async function selectNativePath(kind: 'file' | 'directory', initialPath: string): Promise<string | null> {
  if (busy) throw Object.assign(new Error('已有路径选择窗口，请先完成或取消'), { statusCode: 409 });
  const executable = nativeTool('../native/DeskDialogHost.exe', 'dist/native/DeskDialogHost.exe');
  if (!executable) throw Object.assign(new Error('本机路径选择程序未安装，请先构建原生工具'), { statusCode: 503 });
  busy = true;
  try {
    const { path } = await runTool(executable, [kind, initialPath], 120_000, true);
    if (path !== null && (typeof path !== 'string' || path.length > 500 || /[\x00-\x1f]/.test(path) || !isAbsolute(path) || /^(?:\\\\|\/\/)/.test(path))) throw new Error('路径选择程序返回无效路径');
    return path;
  } finally { busy = false; }
}

export type StartupStatus = { available: boolean; enabled: boolean; currentLocation: boolean };
export async function startupStatus(enabled?: boolean): Promise<StartupStatus> {
  const executable = nativeTool('../../ClaudeBusinessDesk.Launcher.exe', 'dist/launcher/ClaudeBusinessDesk.Launcher.exe');
  if (!executable) {
    if (enabled !== undefined) throw Object.assign(new Error('请使用完整 Windows 发行包设置开机自启'), { statusCode: 400 });
    return { available: false, enabled: false, currentLocation: false };
  }
  const result = await runTool(executable, enabled === undefined ? ['--startup-status'] : ['--startup', enabled ? 'enable' : 'disable'], 10_000);
  if (result.available !== true || typeof result.enabled !== 'boolean' || typeof result.currentLocation !== 'boolean') throw new Error('启动程序返回无效配置');
  return { available: true, enabled: result.enabled, currentLocation: result.currentLocation };
}
