/* 在场 · 公网演示隧道
   用途：把本机正在运行的服务（默认 4173）临时映射到一个 https 公网地址，方便评委直接打开。
   前提：先在另一个终端运行 npm.cmd start。
   说明：使用 Cloudflare 的免账号快速隧道，地址每次启动都会变化，仅供演示，不承诺长期可用。
       工具文件下载在 logs/tools/ 下（logs 已被 gitignore），不进入仓库。 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const toolDir = path.join(root, 'logs', 'tools');
const exePath = path.join(toolDir, 'cloudflared.exe');
const port = process.env.PORT || 4173;
const target = process.env.TUNNEL_TARGET || ('http://127.0.0.1:' + port);
const url = 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe';

fs.mkdirSync(toolDir, { recursive: true });

if (!fs.existsSync(exePath)) {
  console.log('首次使用，正在下载隧道工具（约 55MB，只需一次）…');
  const res = await fetch(url);
  if (!res.ok) {
    console.error('下载失败：HTTP ' + res.status + '。可稍后重试，不影响本机演示。');
    process.exit(1);
  }
  fs.writeFileSync(exePath, Buffer.from(await res.arrayBuffer()));
  console.log('下载完成：' + exePath);
}

console.log('正在把 ' + target + ' 映射到公网，请稍候…\n');

const child = spawn(exePath, ['tunnel', '--url', target, '--no-autoupdate'], {
  cwd: root,
  stdio: ['ignore', 'pipe', 'pipe']
});

let announced = false;
function scan(chunk) {
  const text = chunk.toString('utf8');
  process.stdout.write(text);
  const hit = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
  if (hit && !announced) {
    announced = true;
    console.log('\n================ 公网演示地址 ================');
    console.log(hit[0]);
    console.log('=============================================\n');
    console.log('把这个地址发给评委即可。按 Ctrl + C 关闭。');
  }
}
child.stdout.on('data', scan);
child.stderr.on('data', scan);
child.on('exit', function (code) {
  if (!announced) console.log('隧道已退出（退出码 ' + code + '），请确认本机服务已启动。');
  process.exit(code == null ? 0 : code);
});
process.on('SIGINT', function () { child.kill(); process.exit(0); });
