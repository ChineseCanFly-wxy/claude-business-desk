import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

let busy = false;
export async function selectNativePath(kind: 'file' | 'directory', initialPath: string): Promise<string | null> {
  if (busy) throw Object.assign(new Error('已有路径选择窗口，请先完成或取消'), { statusCode: 409 });
  const bundled = fileURLToPath(new URL('../../native/DeskDialogHost.exe', import.meta.url));
  const executable = existsSync(bundled) ? bundled : resolve('dist/native/DeskDialogHost.exe');
  if (process.platform !== 'win32' || !existsSync(executable)) throw Object.assign(new Error('本机路径选择程序未安装，请先构建原生工具'), { statusCode: 503 });
  busy = true;
  try {
    return await new Promise<string | null>((resolve, reject) => {
      const child = spawn(executable, [kind, initialPath], { shell: false, windowsHide: false, stdio: ['ignore', 'pipe', 'ignore'] });
      let output = '', timedOut = false;
      const timer = setTimeout(() => { timedOut = true; child.kill(); }, 120_000);
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', text => { output += text; if (output.length > 8192) child.kill(); });
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('close', code => {
        clearTimeout(timer);
        if (timedOut) return reject(Object.assign(new Error('路径选择超时，请重新选择'), { statusCode: 408 }));
        if (code !== 0) return reject(new Error('路径选择程序异常退出'));
        try {
          const result = JSON.parse(output.replace(/^﻿/, '').trim());
          if (result.path !== null && (typeof result.path !== 'string' || result.path.length > 500 || /[\x00-\x1f]/.test(result.path))) throw new Error('无效路径');
          resolve(result.path);
        } catch { reject(new Error('路径选择程序返回无效结果')); }
      });
    });
  } finally { busy = false; }
}
