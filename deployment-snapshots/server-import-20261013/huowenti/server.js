import express from 'express';
import path from 'node:path';
import crypto from 'node:crypto';
import zlibModule from 'node:zlib';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { hydrate, getCorpus, corpusStatus } from './lib/corpus.js';
import { hydrateStore, questionSummary, roleDetail, startInterview, getDraft, submitInterview, applyFollowUpAnswer, confirmContribution, undoContribution, listContributions, buildConclusions, buildGraph, judgeNewQuestion, buildAnswerDraft, saveLlmConfig, testLlm, llmStatus } from './lib/huowenti.js';

const root = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(root, 'data');
const app = express();
const rateBuckets = new Map();

const RATE = {
  huowenti: { max: 60, windowMs: 60 * 1000 }
};

app.disable('x-powered-by');
/* 安全响应头：不引入第三方依赖，覆盖评审与真实部署都会检查的几项。
   script-src 只允许本站脚本：页面没有任何内联 script、没有内联事件处理器、没有 eval。
   style-src 保留 'unsafe-inline'，因为渲染层会输出少量行内尺寸与间距；这一点在文档里如实说明，
   不把它包装成「零内联」策略。是否允许被第三方页面嵌入由 HUOWENTI_EMBED 控制，默认禁止。 */
const EMBED = String(process.env.HUOWENTI_EMBED || '').trim() || "'none'";
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  'frame-ancestors ' + EMBED
].join('; ');
app.use(function (req, res, next) {
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Frame-Options', EMBED === "'none'" ? 'DENY' : 'SAMEORIGIN');
  res.setHeader('Permissions-Policy', 'geolocation=(), camera=(), microphone=(), payment=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  next();
});
app.use(express.json({ limit: '256kb' }));
/* 文本资源按需 gzip：现场网络不可控，压缩是零依赖的稳健收益（woff2 已是压缩格式，跳过）。 */
const gzipText = function (req, res, next) {
  const accept = String(req.headers['accept-encoding'] || '');
  if (!/\bgzip\b/.test(accept) || req.method === 'HEAD') return next();
  const chunks = [];
  const rawEnd = res.end.bind(res);
  const compressible = function () {
    const type = String(res.getHeader('Content-Type') || '');
    return /^(text\/|application\/(json|javascript|xml)|image\/svg)/.test(type);
  };
  res.write = function (chunk, encoding) {
    if (chunk && chunk.length) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, typeof encoding === 'string' ? encoding : 'utf8'));
    }
    return true;
  };
  res.end = function (chunk, encoding) {
    if (chunk && chunk.length) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, typeof encoding === 'string' ? encoding : 'utf8'));
    }
    const body = chunks.length === 1 ? chunks[0] : Buffer.concat(chunks);
    try {
      if (res.headersSent || res.getHeader('Content-Encoding') || !compressible() || body.length < 1024) {
        return rawEnd(body);
      }
      const gz = zlibModule.gzipSync(body, { level: 6 });
      if (gz.length >= body.length) return rawEnd(body);
      res.setHeader('Content-Encoding', 'gzip');
      res.setHeader('Vary', 'Accept-Encoding');
      res.setHeader('Content-Length', String(gz.length));
      return rawEnd(gz);
    } catch (error) {
      res.removeHeader('Content-Encoding');
      return rawEnd(body);
    }
  };
  next();
};

app.use(gzipText);

/* 版本化静态资源：页面里的 /huowenti.css、/huowenti.js 会被改写成带版本号的地址。
   文件内容一变，版本号就变，浏览器与 CDN 都不可能再拿到旧版本。
   页面 HTML 本身一律 no-store，确保每次打开都拿到最新引用。 */
const VERSIONED_ASSETS = ['/huowenti.css', '/huowenti.js'];
function fileStamp(relPath) {
  try {
    const st = fsSync.statSync(path.join(root, relPath));
    return st.size.toString(36) + '-' + Math.floor(st.mtimeMs).toString(36);
  } catch { return '0'; }
}
const pageCache = new Map();
function renderPage(file) {
  const full = path.join(root, file);
  let mtimeMs = 0;
  try { mtimeMs = fsSync.statSync(full).mtimeMs; } catch { return null; }
  const cached = pageCache.get(file);
  if (cached && cached.mtimeMs === mtimeMs) return cached.html;
  let html = fsSync.readFileSync(full, 'utf8');
  VERSIONED_ASSETS.forEach(function (url) {
    html = html.split('"' + url + '"').join('"' + url + '?v=' + fileStamp(url.slice(1)) + '"');
  });
  pageCache.set(file, { mtimeMs: mtimeMs, html: html });
  return html;
}
function sendPage(res, file) {
  const html = renderPage(file);
  if (html == null) return res.status(404).json({ error: 'not_found' });
  res.setHeader('Cache-Control', 'no-store, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  return res.type('html').send(html);
}
/* 只对外暴露前端页面与静态资源：源码、数据文件、脚本、日志一律不通过 HTTP 提供。 */
const PUBLIC_FILES = new Set([
  '/index.html', '/huowenti.css', '/huowenti.js',
  '/assets/vendor/three.module.min.js',
  '/robots.txt'
]);
const PUBLIC_PREFIXES = ['/assets/'];
const BLOCKED_PREFIXES = ['/data/', '/lib/', '/logs/', '/scripts/', '/docs/', '/node_modules/', '/.git/'];
const staticFiles = express.static(root, { extensions: ['html'], index: 'huowenti.html', dotfiles: 'deny' });
app.use(function (req, res, next) {
  let raw = '';
  try { raw = decodeURIComponent(String(req.path || '/')); }
  catch { return res.status(400).json({ error: 'bad_path' }); }
  raw = raw.replace(/\\/g, '/').replace(/\/+/g, '/');
  /* 手工折叠 . 与 .. ——URL 编码的 %2e%2e / %2f 会被解码成危险路径，必须先归一化再判断。 */
  const segments = [];
  for (const piece of raw.split('/')) {
    if (!piece || piece === '.') continue;
    if (piece === '..') { return res.status(404).json({ error: 'not_found' }); }
    segments.push(piece);
  }
  const pathname = '/' + segments.join('/');
  if (raw.includes('..')) return res.status(404).json({ error: 'not_found' });
  const blocked = BLOCKED_PREFIXES.some(function (p) { return (pathname + '/').startsWith(p); });
  const allowed = pathname === '/' || PUBLIC_FILES.has(pathname) || PUBLIC_PREFIXES.some(function (p) { return pathname.startsWith(p); });
  if (blocked || !allowed) return next();
  if (pathname === '/' || pathname === '/index.html') return sendPage(res, 'huowenti.html');
  if (VERSIONED_ASSETS.includes(pathname)) {
    res.setHeader('Cache-Control', req.query.v ? 'public, max-age=31536000, immutable' : 'no-cache, must-revalidate');
  }
  return staticFiles(req, res, next);
});

const id = function () { return crypto.randomUUID(); };
const text = function (value, max) { return String(value == null ? '' : value).trim().slice(0, max || 2000); };

function rateLimit(kind, key) {
  const rule = RATE[kind];
  const bucketKey = kind + ':' + key;
  const stamp = Date.now();
  const arr = (rateBuckets.get(bucketKey) || []).filter(function (time) { return stamp - time < rule.windowMs; });
  if (arr.length >= rule.max) return false;
  arr.push(stamp);
  rateBuckets.set(bucketKey, arr);
  return true;
}



/* 公网演示地址：由 活问题守护 写入 logs/public-url.txt。
   评委扫码必须走这个地址，局域网 IP 只在本机同一 WiFi 下才通。 */
function publicBaseUrl() {
  try {
    const raw = fsSync.readFileSync(path.join(root, 'logs', 'public-url.txt'), 'utf8');
    const parsed = JSON.parse(raw);
    const url = String(parsed && parsed.url ? parsed.url : '').trim();
    if (/^https:\/\/(?:[a-z0-9-]+\.)+[a-z]{2,}$/i.test(url)) return url;
  } catch (error) {}
  const env = String(process.env.PUBLIC_BASE_URL || '').trim();
  return env || null;
}

/* 演示现场：把本机局域网 IPv4 地址交给前端，便于评委用手机扫码直达。
   只保留手机真的能连上的地址：排除回环、169.254 链路本地、以及虚拟网卡段，私网地址优先。 */
function lanAddresses() {
  const seen = {};
  const out = [];
  const ifaces = os.networkInterfaces();
  Object.keys(ifaces).forEach(function (name) {
    (ifaces[name] || []).forEach(function (info) {
      if (!info || info.internal) return;
      const family = typeof info.family === 'string' ? info.family : (info.family === 4 ? 'IPv4' : '');
      if (family !== 'IPv4') return;
      const address = info.address;
      if (!address || address === '127.0.0.1') return;
      if (/^169\.254\./.test(address)) return;            // 链路本地，手机连不上
      if (/^172\.(1[6-9]|2\d|3[01])\./.test(address)) return; // 常见虚拟网卡段
      if (seen[address]) return;
      seen[address] = true;
      const isPrivate = /^10\./.test(address) || /^192\.168\./.test(address) || /^172\./.test(address);
      out.push({ iface: name, address: address, private: isPrivate });
    });
  });
  out.sort(function (a, b) { return (b.private ? 1 : 0) - (a.private ? 1 : 0); });
  return out;
}

app.get('/api/health', async function (req, res) {
  res.json({
    ok: true,
    zhihuOpenApiConfigured: Boolean(process.env.ZHIHU_ACCESS_SECRET),
    persistence: 'json-file',
    corpus: corpusStatus(),
    publicUrl: publicBaseUrl(),
    lanUrls: lanAddresses().map(function (item) { return 'http://' + item.address + ':4173'; })
  });
});

/* ============================ 活问题 ============================
   对外接口只有这一个命名空间：它读写 data/huowenti.json 与 data/llm.json，
   所有返回都只包含可公开字段。开发阶段的旧接口与旧页面已全部下线。 */

app.get('/api/huowenti/summary', async function (req, res) {
  res.json(await questionSummary());
});

app.get('/api/huowenti/roles/:roleKey', async function (req, res) {
  const role = roleDetail(req.params.roleKey);
  if (!role) return res.status(404).json({ error: 'role_not_found', message: '没有这个参与身份。' });
  res.json(role);
});

app.post('/api/huowenti/interview', async function (req, res) {
  if (!rateLimit('huowenti', req.ip || 'local')) return res.status(429).json({ error: 'rate_limited', message: '操作太频繁，请稍后再试。' });
  const roleKey = text(req.body && req.body.roleKey, 40);
  const started = startInterview(roleKey, Boolean(req.body && req.body.demo));
  if (!started) return res.status(400).json({ error: 'role_required', message: '请先选择你的身份。' });
  res.status(201).json(started);
});

app.post('/api/huowenti/interview/:draftId', async function (req, res) {
  if (!rateLimit('huowenti', req.ip || 'local')) return res.status(429).json({ error: 'rate_limited', message: '操作太频繁，请稍后再试。' });
  const result = await submitInterview(req.params.draftId, (req.body && req.body.answers) || {});
  if (!result) return res.status(404).json({ error: 'draft_not_found', message: '这次采访已经开始太久，请重新进入。' });
  res.json(result);
});

app.post('/api/huowenti/followup', async function (req, res) {
  if (!rateLimit('huowenti', req.ip || 'local')) return res.status(429).json({ error: 'rate_limited', message: '操作太频繁，请稍后再试。' });
  const result = applyFollowUpAnswer(text(req.body && req.body.draftId, 80), req.body && req.body.answer);
  if (!result) return res.status(404).json({ error: 'draft_not_found', message: '这次采访已经开始太久，请重新进入。' });
  res.json(result);
});

app.get('/api/huowenti/draft/:draftId', async function (req, res) {
  const draft = getDraft(req.params.draftId);
  if (!draft) return res.status(404).json({ error: 'draft_not_found' });
  res.json({ draftId: draft.id, roleKey: draft.roleKey, answers: draft.answers, followUp: draft.followUp });
});

app.post('/api/huowenti/contribution', async function (req, res) {
  if (!rateLimit('huowenti', req.ip || 'local')) return res.status(429).json({ error: 'rate_limited', message: '操作太频繁，请稍后再试。' });
  const result = await confirmContribution(text(req.body && req.body.draftId, 80), {
    anonymous: Boolean(req.body && req.body.anonymous),
    answers: (req.body && req.body.answers) || {},
    followUp: (req.body && req.body.followUp) || {}
  });
  if (!result) return res.status(404).json({ error: 'draft_not_found', message: '这次采访已经开始太久，请重新进入。' });
  if (result.error === 'demo-not-allowed') return res.status(400).json({ error: 'demo-not-allowed', message: '这是演示身份，不会写进真实调查。想真的补上经历，请回到采访页按你的真实情况填写。' });
  if (result.error === 'empty-card') return res.status(400).json({ error: 'empty-card', message: '还没有可以确认的事实，请至少补充一条你的经历。' });
  res.status(201).json(result);
});

app.get('/api/huowenti/contributions', async function (req, res) {
  res.json({ count: listContributions().length, contributions: listContributions() });
});

app.delete('/api/huowenti/contribution/:id', async function (req, res) {
  const removed = await undoContribution(req.params.id);
  if (!removed) return res.status(404).json({ error: 'contribution_not_found', message: '这条贡献已经不在调查里。' });
  res.json({ removed: true, id: req.params.id });
});

app.get('/api/huowenti/conclusions', async function (req, res) {
  res.json(await buildConclusions());
});

app.get('/api/huowenti/graph', async function (req, res) {
  res.json(await buildGraph());
});

app.post('/api/huowenti/new-question', async function (req, res) {
  if (!rateLimit('huowenti', req.ip || 'local')) return res.status(429).json({ error: 'rate_limited', message: '操作太频繁，请稍后再试。' });
  res.json(judgeNewQuestion(text(req.body && req.body.question, 400)));
});

app.get('/api/huowenti/answer-draft', async function (req, res) {
  res.json(await buildAnswerDraft());
});

app.get('/api/huowenti/llm-config', async function (req, res) {
  res.json(llmStatus());
});

app.post('/api/huowenti/llm-config', async function (req, res) {
  const saved = await saveLlmConfig(req.body || {});
  res.json(saved);
});

app.post('/api/huowenti/llm-test', async function (req, res) {
  if (!rateLimit('huowenti', req.ip || 'local')) return res.status(429).json({ error: 'rate_limited', message: '操作太频繁，请稍后再试。' });
  res.json(await testLlm());
});

app.get('/huowenti/:view', function (req, res) { return sendPage(res, 'huowenti.html'); });

/* 兜底：地址栏被粘贴了多余文字、或链接多打了字符时，浏览器仍应回到首页，而不是看到一片错误。 */
app.use(function (req, res, next) {
  const wantsHtml = String(req.headers.accept || '').indexOf('text/html') !== -1;
  if (req.method === 'GET' && wantsHtml && String(req.path || '/').indexOf('/api/') !== 0) {
    return res.redirect(302, '/');
  }
  return next();
});

app.use(function (req, res) { res.status(404).json({ error: 'not_found' }); });

await hydrate();
await hydrateStore();
await fs.mkdir(dataDir, { recursive: true });
app.listen(process.env.PORT || 4173, function () { console.log('活问题 server ready'); });
setTimeout(function () { getCorpus({}).then(function () { console.log('corpus preloaded'); }).catch(function () {}); }, 300);
