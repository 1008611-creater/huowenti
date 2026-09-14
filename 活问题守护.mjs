/* 活问题 · 守护进程（node 版）
   作用：让「网页」和「公网演示地址」始终保持可用。
   - 每 12 秒检查一次本机网页服务；中断就自动重启（会先清掉占用端口的僵尸进程）。
   - 同时检查公网演示地址；中断就自动重连。
   公网地址是固定的专属域名，不会变：
     https://zaichang.cauai.fun
   启动方式：双击「活问题守护.cmd」。窗口保持最小化即可，不要关闭。 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname);
const logs = path.join(root, 'logs');
const port = Number(process.env.PORT || 4173);
const healthUrl = 'http://127.0.0.1:' + port + '/api/health';
const stateFile = path.join(logs, 'public-url.txt');
const serverLog = path.join(logs, 'server-run.log');
const daemonLog = path.join(logs, 'daemon.log');
const exePath = path.join(logs, 'tools', 'cloudflared.exe');
const tokenFile = path.join(logs, 'tools', 'zaichang-tunnel-token.txt');
const tunnelLog = path.join(logs, 'tunnel-fixed.log');

/* 专属固定域名：由 Cloudflare 托管，指向本机 4173 端口。
   只要这个窗口开着，别人随时都能通过这个地址访问，地址永远不变。 */
const FIXED_URL = 'https://zaichang.cauai.fun';

fs.mkdirSync(logs, { recursive: true });

function stamp() {
  return new Date().toLocaleTimeString('zh-CN', { hour12: false });
}

function appendLog(text) {
  try {
    if (fs.existsSync(daemonLog) && fs.statSync(daemonLog).size > 1024 * 1024) {
      fs.writeFileSync(daemonLog, '');
    }
    fs.appendFileSync(daemonLog, text + '\n');
  } catch {}
}

/* 同一份内容既显示在这个窗口里，也写进 logs/daemon.log，方便事后排查。 */
function say(msg) {
  const line = '[' + stamp() + '] ' + msg;
  console.log(line);
  appendLog(line);
}

function banner(lines) {
  console.log('');
  lines.forEach(function (l) { console.log(l); });
  console.log('');
  appendLog(lines.join('\n'));
}

function loadState() {
  try { return JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { return {}; }
}

function saveState(patch) {
  const next = { ...loadState(), ...patch };
  fs.writeFileSync(stateFile, JSON.stringify(next, null, 2));
  /* 前端页面通过 /assets/public-url.json 拿到公网地址，用于生成分享链接与二维码。 */
  try {
    const assetsDir = path.join(root, 'assets');
    fs.mkdirSync(assetsDir, { recursive: true });
    fs.writeFileSync(path.join(assetsDir, 'public-url.json'), JSON.stringify({
      url: next.url || null,
      updatedAt: new Date().toISOString()
    }, null, 2));
  } catch (error) {
    say('同步公网地址到页面失败：' + error.message);
  }
}

async function isUp(url, timeout) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeout) });
    return res.ok;
  } catch {
    return false;
  }
}

/* 找出占用端口的进程。网页没响应但端口被占住时，多半是上一次没退干净的进程。 */
function pidsOnPort() {
  return new Promise(function (resolve) {
    let buf = '';
    let child;
    try {
      child = spawn('netstat', ['-ano', '-p', 'tcp'], { windowsHide: true });
    } catch (error) {
      /* 某些受限环境下不允许创建子进程，此时跳过清理，不影响守护主循环。 */
      resolve([]);
      return;
    }
    child.stdout.on('data', function (d) { buf += d.toString(); });
    child.on('error', function () { resolve([]); });
    child.on('close', function () {
      const pids = new Set();
      buf.split('\n').forEach(function (line) {
        const parts = line.trim().split(/\s+/);
        if (parts.length >= 5 && parts[0].toUpperCase() === 'TCP' && parts[3] === 'LISTENING' && parts[1].endsWith(':' + port)) {
          const pid = Number(parts[4]);
          if (Number.isInteger(pid) && pid > 0 && pid !== process.pid) pids.add(pid);
        }
      });
      resolve([...pids]);
    });
  });
}

async function freePort() {
  const pids = await pidsOnPort();
  if (!pids.length) return false;
  say('发现旧进程占着网页端口（' + pids.join('、') + '），正在清理…');
  pids.forEach(function (pid) { try { process.kill(pid); } catch {} });
  await new Promise(function (r) { setTimeout(r, 1200); });
  const left = await pidsOnPort();
  left.forEach(function (pid) { try { process.kill(pid, 'SIGKILL'); } catch {} });
  return true;
}

function startServer() {
  try {
    const fd = fs.openSync(serverLog, 'a');
    const child = spawn(process.execPath, ['server.js'], {
      cwd: root, detached: true, stdio: ['ignore', fd, fd], windowsHide: true,
    });
    child.unref();
    return true;
  } catch (error) {
    say('启动网页服务失败：' + error.message);
    return false;
  }
}

async function ensureServer() {
  if (await isUp(healthUrl, 4000)) return true;
  say('网页服务没有响应，正在自动重启…');
  await freePort();
  startServer();
  for (let i = 0; i < 25; i++) {
    await new Promise((r) => setTimeout(r, 800));
    if (await isUp(healthUrl, 3000)) { say('网页服务已恢复。'); return true; }
  }
  /* 再试一次：有些机器上前一次清理后端口释放得慢。 */
  await freePort();
  startServer();
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 800));
    if (await isUp(healthUrl, 3000)) { say('网页服务已恢复。'); return true; }
  }
  say('自动重启没有成功，请把 logs/server-run.log 发给 Codex。');
  return false;
}

let tunnelChild = null;

function publishUrl() {
  const changed = loadState().url !== FIXED_URL;
  saveState({ url: FIXED_URL, startedAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  if (!changed) return;
  banner([
    '================ 公网演示地址 ================',
    FIXED_URL,
    '=============================================',
  ]);
}

async function ensureTunnel() {
  if (await isUp(FIXED_URL + '/api/health', 12000)) {
    publishUrl();
    return true;
  }
  if (!fs.existsSync(exePath) || !fs.existsSync(tokenFile)) {
    say('缺少公网通道配置，本机网页仍可正常使用。');
    return false;
  }
  /* 通道进程还活着时先等它自愈，避免无谓地重建。 */
  if (tunnelChild && tunnelChild.exitCode === null) {
    for (let i = 0; i < 6; i++) {
      await new Promise((r) => setTimeout(r, 3000));
      if (await isUp(FIXED_URL + '/api/health', 10000)) {
        say('公网地址已恢复。');
        publishUrl();
        return true;
      }
    }
    try { tunnelChild.kill(); } catch {}
    await new Promise((r) => setTimeout(r, 800));
  }
  say('公网地址暂时不通，正在重新连接…');
  try {
    const token = fs.readFileSync(tokenFile, 'utf8').trim();
    const tfd = fs.openSync(tunnelLog, 'a');
    tunnelChild = spawn(exePath, ['tunnel', '--no-autoupdate', 'run', '--token', token], {
      cwd: root, detached: true, stdio: ['ignore', tfd, tfd], windowsHide: true,
    });
    tunnelChild.unref();
  } catch (error) {
    say('公网通道启动失败：' + error.message + '（本机网页不受影响）');
    tunnelChild = null;
    return false;
  }
  for (let i = 0; i < 25; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    if (await isUp(FIXED_URL + '/api/health', 12000)) {
      publishUrl();
      say('公网地址已恢复。');
      return true;
    }
  }
  say('公网地址暂时连不上，会继续自动重试。');
  return false;
}

banner([
  '  活问题 · 一个会主动寻找回答者的问题',
  '  守护已启动：网页或公网地址中断时会自动恢复。',
  '  这个窗口最小化即可，不要关闭。',
  '',
  '  公网演示地址（固定不变）：',
  '  ' + FIXED_URL,
]);

publishUrl();

let round = 0;
while (true) {
  const serverOk = await ensureServer();
  const tunnelOk = await ensureTunnel();
  round += 1;
  if (round % 5 === 0) {
    say('运行中 · 本机网页' + (serverOk ? '正常' : '异常') + ' · 公网地址' + (tunnelOk ? '正常' : '重连中'));
  }
  await new Promise((r) => setTimeout(r, 12000));
}
