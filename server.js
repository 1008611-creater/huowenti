import express from 'express';
import path from 'node:path';
import crypto from 'node:crypto';
import zlibModule from 'node:zlib';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { hydrate, getCorpus, getDetail, corpusStatus } from './lib/corpus.js';
import { rankDocs, buildAnalysis, extractEntities } from './lib/matcher.js';
import { classify, evaluate, relationTypes } from './lib/evidence.js';
import { getWeather, weatherStatus } from './lib/weather.js';
import { hydrateStore, questionSummary, roleDetail, startInterview, getDraft, submitInterview, applyFollowUpAnswer, confirmContribution, undoContribution, listContributions, buildConclusions, buildGraph, judgeNewQuestion, buildAnswerDraft, saveLlmConfig, testLlm, llmStatus } from './lib/huowenti.js';

const root = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(root, 'data');
/* 数据文件位置可被环境变量覆盖：自动化测试与冒烟脚本必须指向临时文件，
   否则每次跑测试都会往真实的用户反馈库里灌入空壳案例。
   默认仍然是 data/cases.json，正常启动行为完全不变。 */
const dataFile = process.env.ZAICHANG_DATA_FILE
  ? path.resolve(String(process.env.ZAICHANG_DATA_FILE))
  : path.join(dataDir, 'cases.json');
const dataDirOfFile = path.dirname(dataFile);
const app = express();
const oauthStates = new Map();
const analyzeCache = new Map();
const rateBuckets = new Map();

const ANALYZE_TTL = 60 * 1000;
const RATE = {
  analyze: { max: 30, windowMs: 60 * 1000 },
  feedback: { max: 12, windowMs: 10 * 60 * 1000 },
  weather: { max: 90, windowMs: 60 * 1000 },
  huowenti: { max: 60, windowMs: 60 * 1000 }
};

app.disable('x-powered-by');
/* 安全响应头：不引入第三方依赖，覆盖评审与真实部署都会检查的几项。
   script-src 只允许本站脚本：三个页面没有任何内联 script、没有内联事件处理器、没有 eval。
   style-src 保留 'unsafe-inline'，因为渲染层会输出少量行内尺寸与间距；这一点在文档里如实说明，
   不把它包装成「零内联」策略。是否允许被第三方页面嵌入由 ZAICHANG_EMBED 控制，默认禁止。 */
const EMBED = String(process.env.ZAICHANG_EMBED || '').trim() || "'none'";
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

/* 版本化静态资源：页面里的 /app.js、/styles.css 等会被改写成带版本号的地址。
   文件内容一变，版本号就变，浏览器与 CDN 都不可能再拿到旧版本。
   页面 HTML 本身一律 no-store，确保每次打开都拿到最新引用。 */
const VERSIONED_ASSETS = ['/app.js', '/styles.css', '/case.js', '/verify.js', '/huowenti.css', '/huowenti.js'];
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
  '/index.html', '/styles.css', '/app.js',
  '/case.html', '/case.js', '/verify.html', '/verify.js',
  '/huowenti.css', '/huowenti.js', '/assets/vendor/three.module.min.js',
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
  if (pathname === '/case.html') return sendPage(res, 'case.html');
  if (pathname === '/verify.html') return sendPage(res, 'verify.html');
  if (VERSIONED_ASSETS.includes(pathname)) {
    res.setHeader('Cache-Control', req.query.v ? 'public, max-age=31536000, immutable' : 'no-cache, must-revalidate');
  }
  return staticFiles(req, res, next);
});

const now = function () { return new Date().toISOString(); };
const id = function () { return crypto.randomUUID(); };
const text = function (value, max) { return String(value == null ? '' : value).trim().slice(0, max || 2000); };

async function readCases() {
  try { return JSON.parse(await fs.readFile(dataFile, 'utf8')); }
  catch { return []; }
}

async function writeCases(cases) {
  await fs.mkdir(dataDirOfFile, { recursive: true });
  const temporary = dataFile + '.tmp';
  await fs.writeFile(temporary, JSON.stringify(cases, null, 2), 'utf8');
  await fs.rename(temporary, dataFile);
}

async function findCase(caseId) {
  const cases = await readCases();
  return { cases: cases, item: cases.find(function (entry) { return entry.id === caseId; }) };
}

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

function relationList() {
  return relationTypes();
}

/* 来源标签只由来源类型决定：不采信客户端传来的文本，
   否则接口直传（不带 relation）会落成与类型不符的标签。 */
function relationLabel(code) {
  const found = relationTypes().find(function (type) { return type.code === code; });
  return (found && found.label) || '本人到场';
}

function publicCase(item) {
  if (!item) return null;
  const state = evaluate(item.feedback);
  return {
    id: item.id,
    question: item.question,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt || item.createdAt,
    status: item.status,
    analysis: item.analysis,
    matches: item.matches || [],
    feedback: item.feedback.map(function (entry) {
      return {
        id: entry.id,
        displayName: entry.displayName,
        content: entry.content,
        relation: relationLabel(entry.relationType) || entry.relation,
        relationType: entry.relationType,
        area: entry.area,
        createdAt: entry.createdAt,
        signals: (entry.analysis && entry.analysis.signals) || [],
        duplicate: Boolean(entry.duplicateOf)
      };
    }),
    evidenceState: state,
    relationTypes: relationList(),
    answers: item.answers || [],
    feedbackUrl: '/verify/' + item.id,
    answerUrl: '/case/' + item.id
  };
}

/* 同一个问题不重复建案件：把问题文本归一化后比对，避免出现多条空壳。 */
function normalizeQuestion(value) {
  return String(value == null ? '' : value)
    .toLowerCase()
    .replace(/[\s\u3000]+/g, '')
    .replace(/[，。？！、；：,.?!;:~～"'“”‘’（）()【】\[\]\-—_/\\]/g, '');
}

/* 挑出这个问题的"最好一条"已有案件：证据等级优先，其次已经生成过结论的，最后看时间。 */
function bestExistingCase(list, question) {
  const norm = normalizeQuestion(question);
  if (!norm) return null;
  const same = list.filter(function (entry) { return normalizeQuestion(entry.question) === norm; });
  if (!same.length) return null;
  same.sort(function (a, b) {
    const la = evaluate(a.feedback || []).level;
    const lb = evaluate(b.feedback || []).level;
    if (lb !== la) return lb - la;
    const aa = (a.answers || []).length ? 1 : 0;
    const ab = (b.answers || []).length ? 1 : 0;
    if (ab !== aa) return ab - aa;
    return new Date(b.updatedAt || b.createdAt).getTime() - new Date(a.updatedAt || a.createdAt).getTime();
  });
  return same[0];
}

/* 首页"真实案例"区块：只收有真实反馈的案件，同一问题只出现一次最完整的版本。 */
function showcaseCases(list, limit) {
  const seen = new Set();
  const rows = [];
  const withFeedback = list.filter(function (entry) { return (entry.feedback || []).length > 0; });
  withFeedback.sort(function (a, b) {
    const sa = evaluate(a.feedback || []);
    const sb = evaluate(b.feedback || []);
    if (sb.level !== sa.level) return sb.level - sa.level;
    if ((sb.confidence || 0) !== (sa.confidence || 0)) return (sb.confidence || 0) - (sa.confidence || 0);
    const ia = (sa.stats && sa.stats.independent) || 0;
    const ib = (sb.stats && sb.stats.independent) || 0;
    if (ib !== ia) return ib - ia;
    return new Date(b.updatedAt || b.createdAt).getTime() - new Date(a.updatedAt || a.createdAt).getTime();
  });
  withFeedback.forEach(function (entry) {
    const norm = normalizeQuestion(entry.question);
    if (!norm || seen.has(norm)) return;
    seen.add(norm);
    const state = evaluate(entry.feedback || []);
    rows.push({
      id: entry.id,
      question: entry.question,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt || entry.createdAt,
      status: entry.status,
      evidenceState: state,
      feedbackCount: (entry.feedback || []).length,
      independentCount: (state && state.stats && state.stats.independent) || 0,
      signalLabels: ((state && state.signals) || []).slice(0, 3).map(function (item) { return item.label; }),
      hasAnswer: (entry.answers || []).length > 0,
      caseUrl: '/case/' + entry.id,
      feedbackUrl: '/verify/' + entry.id
    });
  });
  const out = rows.slice(0, limit || 8);
  return {
    total: rows.length,
    weakest: rows.length ? rows[rows.length - 1].evidenceState.confidence : 0,
    cases: out
  };
}
function statusFor(item) {
  if ((item.answers || []).length) return 'answered';
  if (item.feedback.length >= 2) return 'corroborated';
  if (item.feedback.length) return 'collecting';
  return 'open';
}

async function zhihu(pathname, query, options) {
  const secret = process.env.ZHIHU_ACCESS_SECRET;
  if (!secret) return null;
  const url = new URL('https://developer.zhihu.com' + pathname);
  Object.entries(query || {}).forEach(function (entry) { url.searchParams.set(entry[0], entry[1]); });
  const response = await fetch(url, Object.assign({}, options || {}, {
    headers: Object.assign({
      Authorization: 'Bearer ' + secret,
      'X-Request-Timestamp': String(Math.floor(Date.now() / 1000)),
      'Content-Type': 'application/json'
    }, (options && options.headers) || {})
  }));
  if (!response.ok) throw new Error('zhihu_' + response.status);
  return response.json();
}

async function searchZhihu(question) {
  const data = await zhihu('/api/v1/content/zhihu_search', { Query: question, Count: 5 });
  const items = (data && data.Data && data.Data.Items) || (data && data.data && data.data.items) || (data && data.items) || [];
  return items.slice(0, 5).map(function (item) {
    return {
      title: text(item.Title || item.title || '知乎相关内容', 180),
      summary: text(item.Excerpt || item.excerpt || item.Summary || item.summary || '', 500),
      author: text(item.AuthorName || item.author || '', 80),
      publishedAt: item.EditTime || item.CreatedTime || null,
      url: item.Url || item.url || '',
      source: 'zhihu-open'
    };
  });
}

/* 公网演示地址：由 在场守护 写入 logs/public-url.txt。
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
    oauthConfigured: Boolean(process.env.ZHIHU_OAUTH_APP_ID && process.env.ZHIHU_OAUTH_APP_KEY),
    persistence: 'json-file',
    corpus: corpusStatus(),
    relationTypes: relationList(),
    weather: weatherStatus(),
    publicUrl: publicBaseUrl(),
    lanUrls: lanAddresses().map(function (item) { return 'http://' + item.address + ':4173'; })
  });
});

app.get('/api/corpus', async function (req, res) {
  const force = req.query.refresh === '1';
  const corpus = await getCorpus({ force: force });
  res.json({
    live: !corpus.stale,
    fetchedAt: corpus.fetchedAt ? new Date(corpus.fetchedAt).toISOString() : null,
    count: corpus.docs.length,
    docs: corpus.docs.map(function (doc) {
      return { kind: doc.kind, workId: doc.workId, title: doc.title, description: doc.description, artwork: doc.artwork, labels: doc.labels, url: doc.url };
    })
  });
});

/* 真实气象信号：只回白名单字段，拿不到就如实返回 available:false。
   前端 CSP 为 connect-src 'self'，因此上游请求一律由服务端代理并缓存。 */
app.get('/api/weather', async function (req, res) {
  const place = text(req.query.place, 40);
  if (!place) return res.status(400).json({ error: 'place_required', message: '请提供要查询的地点。' });
  if (!rateLimit('weather', req.ip || 'local')) return res.status(429).json({ error: 'rate_limited', message: '查询太频繁，请稍后再试。' });
  const data = await getWeather(place);
  res.json(data);
});

/* 案件页直接取问题里的地点，前端不用自己拆词。 */
app.get('/api/cases/:caseId/weather', async function (req, res) {
  const found = await findCase(req.params.caseId);
  if (!found.item) return res.status(404).json({ error: 'case_not_found', message: '这条求证请求不存在或已失效。' });
  if (!rateLimit('weather', req.ip || 'local')) return res.status(429).json({ error: 'rate_limited', message: '查询太频繁，请稍后再试。' });
  const entities = extractEntities(found.item.question || '');
  const place = (entities.places || [])[0] || '';
  if (!place) {
    return res.json({ available: false, reason: 'no_place', message: '这个问题里没有可定位的地点，因此不显示气象数据。', place: null, question: found.item.question });
  }
  const data = await getWeather(place);
  res.json(Object.assign({ question: found.item.question }, data));
});

app.get('/api/content/:kind/:workId', async function (req, res) {
  try {
    const detail = await getDetail(req.params.kind, req.params.workId);
    res.json(detail);
  } catch (error) {
    const code = String(error.message || 'error');
    const status = code === 'invalid_work_id' || code === 'invalid_kind' ? 400 : 502;
    res.status(status).json({ error: code === 'invalid_work_id' || code === 'invalid_kind' ? code : 'content_unavailable', message: '暂时无法读取这条知乎内容，请稍后再试。' });
  }
});

app.post('/api/analyze', async function (req, res) {
  const question = text(req.body && req.body.question, 1000);
  if (!question) return res.status(400).json({ error: 'question_required', message: '请先写下你想确认的问题。' });
  if (!rateLimit('analyze', req.ip || 'local')) return res.status(429).json({ error: 'rate_limited', message: '提问太频繁，请稍后再试。' });

  const key = question.toLowerCase();
  const cached = analyzeCache.get(key);
  let matches;
  let analyses;
  let openApiLive = false;
  if (cached && Date.now() - cached.at < ANALYZE_TTL) {
    matches = cached.matches;
    analyses = cached.analyses;
    openApiLive = cached.openApiLive;
  } else {
    const corpus = await getCorpus({});
    const ranked = rankDocs(corpus.docs, question, 6);
    matches = ranked.matches;
    analyses = buildAnalysis(question, ranked);
    if (process.env.ZHIHU_ACCESS_SECRET) {
      try {
        const extra = await searchZhihu(question);
        if (extra.length) {
          analyses.knownFacts = analyses.knownFacts.concat(['知乎开放平台返回 ' + extra.length + ' 条实时搜索结果，可用于补充背景。']);
          openApiLive = true;
        }
      } catch { /* open api is optional; the hackathon corpus remains the source */ }
    }
    analyzeCache.set(key, { at: Date.now(), matches: matches, analyses: analyses, openApiLive: openApiLive });
  }

  const cases = await readCases();
  /* 先看这个问题是不是已经有人问过并收到了真实反馈：
     有就直接带用户进入那条真实案件，而不是再建一条空壳。 */
  const existing = bestExistingCase(cases, question);
  if (existing) {
    const state = evaluate(existing.feedback || []);
    return res.json({
      reused: true,
      openApiLive: openApiLive,
      corpusSize: corpusStatus().story + corpusStatus().knowledge,
      caseId: existing.id,
      feedbackUrl: '/verify/' + existing.id,
      answerUrl: '/case/' + existing.id,
      analysis: (existing.analysis && existing.analysis.entities) ? existing.analysis : analyses,
      matches: existing.matches || [],
      evidenceState: state,
      feedbackCount: (existing.feedback || []).length
    });
  }

  const item = {
    id: id(),
    question: question,
    createdAt: now(),
    updatedAt: now(),
    status: 'open',
    analysis: analyses,
    matches: matches.map(function (match) {
      return {
        kind: match.doc.kind,
        workId: match.doc.workId,
        title: match.doc.title,
        labels: match.doc.labels,
        url: match.doc.url,
        relevance: match.relevance,
        keywords: match.keywords,
        reasons: match.reasons
      };
    }),
    feedback: [],
    answers: []
  };
  cases.unshift(item);
  await writeCases(cases.slice(0, 500));
  const status = corpusStatus();
  res.json({
    openApiLive: openApiLive,
    corpusSize: status.story + status.knowledge,
    caseId: item.id,
    feedbackUrl: '/verify/' + item.id,
    answerUrl: '/case/' + item.id,
    analysis: analyses,
    matches: item.matches
  });
});

/* 首页"真实案例"：把已经收到真实现场反馈的案件列出来，让评审一眼看到系统确实在用起来。
   只读、只返回可公开字段，不暴露任何凭证或隐私。 */
app.get('/api/cases', async function (req, res) {
  const limit = Math.max(1, Math.min(20, Number(req.query.limit) || 8));
  const cases = await readCases();
  const showcase = showcaseCases(cases, limit);
  res.json({
    total: showcase.total,
    count: showcase.cases.length,
    cases: showcase.cases.map(function (entry) {
      return {
        id: entry.id,
        question: entry.question,
        createdAt: entry.createdAt,
        updatedAt: entry.updatedAt,
        status: entry.status,
        code: entry.evidenceState.code,
        label: entry.evidenceState.label,
        level: entry.evidenceState.level,
        confidence: entry.evidenceState.confidence,
        feedbackCount: entry.feedbackCount,
        independentCount: entry.independentCount,
        signalLabels: entry.signalLabels,
        hasAnswer: entry.hasAnswer,
        caseUrl: entry.caseUrl,
        feedbackUrl: entry.feedbackUrl
      };
    })
  });
});

app.get('/api/cases/:caseId', async function (req, res) {
  const found = await findCase(req.params.caseId);
  if (!found.item) return res.status(404).json({ error: 'case_not_found', message: '这条求证请求不存在或已失效。' });
  res.json(publicCase(found.item));
});

app.post('/api/cases/:caseId/feedback', async function (req, res) {
  const found = await findCase(req.params.caseId);
  if (!found.item) return res.status(404).json({ error: 'case_not_found', message: '这条求证请求不存在或已失效。' });
  if (!rateLimit('feedback', (req.ip || 'local') + ':' + found.item.id)) return res.status(429).json({ error: 'rate_limited', message: '提交太频繁，请稍后再试。' });

  const content = text(req.body && req.body.content, 1200);
  if (content.length < 5) return res.status(400).json({ error: 'feedback_too_short', message: '请至少写 5 个字，描述你亲自看到的情况。' });
  if (/https?:\/\/|www\.|@[a-z0-9.-]+\./i.test(content)) return res.status(400).json({ error: 'feedback_contains_link', message: '请不要在反馈里填写链接或联系方式。' });

  const relationType = ['witness', 'relay', 'official', 'archived'].indexOf(req.body && req.body.relationType) !== -1 ? req.body.relationType : 'witness';
  const analysis = classify(content, relationType);
  const duplicate = found.item.feedback.find(function (entry) {
    return entry.analysis && entry.analysis.fingerprint === analysis.fingerprint;
  });

  const feedback = {
    id: id(),
    displayName: text((req.body && req.body.displayName) || '匿名现场用户', 80) || '匿名现场用户',
    content: content,
    relation: relationLabel(relationType),
    relationType: relationType,
    area: text(req.body && req.body.area, 120),
    sourceUrl: '',
    createdAt: now(),
    analysis: analysis,
    duplicateOf: duplicate ? duplicate.id : null
  };
  found.item.feedback.push(feedback);
  found.item.updatedAt = now();
  found.item.status = statusFor(found.item);
  await writeCases(found.cases);
  const state = evaluate(found.item.feedback);
  res.status(201).json({
    feedback: { id: feedback.id, displayName: feedback.displayName, createdAt: feedback.createdAt, signals: analysis.signals },
    duplicate: Boolean(duplicate),
    evidenceState: state
  });
});

app.post('/api/cases/:caseId/answer', async function (req, res) {
  const found = await findCase(req.params.caseId);
  if (!found.item) return res.status(404).json({ error: 'case_not_found', message: '这条求证请求不存在或已失效。' });
  if (!found.item.feedback.length) {
    return res.status(409).json({ error: 'no_feedback', message: '还没有收到真实现场反馈，暂时不能生成结论。请先把反馈链接发给到过现场的人。' });
  }
  const state = evaluate(found.item.feedback);
  const latest = found.item.feedback
    .filter(function (entry) { return !entry.duplicateOf; })
    .slice(-3)
    .map(function (entry) {
      return '【' + (relationLabel(entry.relationType) || entry.relation || '现场反馈') + '】' + entry.content;
    })
    .join('\n');
  let answer = '结论：' + state.label + '（置信度 ' + state.confidence + '%）。\n\n' + state.reason + '\n\n证据摘要：\n' + latest + '\n\n说明：这是基于现场反馈整理的判断，不代表官方确认。';
  let live = false;
  try {
    const data = await zhihu('/v1/chat/completions', {}, {
      method: 'POST',
      body: JSON.stringify({
        model: 'zhida-fast-1p5',
        messages: [{ role: 'user', content: '问题：' + found.item.question + '\n现场反馈：\n' + latest + '\n请只基于以上证据给出谨慎结论，明确标注不确定性和冲突，不要补充未提供的事实。' }],
        stream: false
      })
    });
    const generated = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    if (generated) { answer = generated; live = true; }
  } catch { /* deterministic evidence summary remains the answer */ }

  const record = { id: id(), answer: answer, live: live, evidenceState: state, createdAt: now() };
  found.item.answers.push(record);
  found.item.updatedAt = now();
  found.item.status = 'answered';
  await writeCases(found.cases);
  res.json(record);
});

/* ============================ 活问题 ============================
   活问题的接口与在场完全隔离：它读写 data/huowenti.json 与 data/llm.json，
   不触碰 cases.json。所有返回都只包含可公开字段。 */

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
  const started = startInterview(roleKey);
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

app.get('/verify/:caseId', function (req, res) { return sendPage(res, 'verify.html'); });
app.get('/case/:caseId', function (req, res) { return sendPage(res, 'case.html'); });

app.get('/oauth/login', function (req, res) {
  const appId = process.env.ZHIHU_OAUTH_APP_ID;
  const redirect = process.env.ZHIHU_OAUTH_REDIRECT_URI;
  if (!appId || !redirect) return res.status(503).type('html').send(friendlyPage('知乎账号登录尚未配置',
    '本机演示没有配置知乎开放平台凭证，这不影响完整流程：创建案件、收集现场反馈、生成带来源的结论都可以正常使用。',
    '/'));
  const state = id();
  oauthStates.set(state, Date.now() + 300000);
  res.redirect('https://openapi.zhihu.com/authorize?redirect_uri=' + encodeURIComponent(redirect) + '&app_id=' + encodeURIComponent(appId) + '&response_type=code&state=' + state);
});

app.get('/oauth/callback', async function (req, res) {
  const state = text(req.query.state, 200);
  const expiresAt = oauthStates.get(state);
  oauthStates.delete(state);
  if (!state || !expiresAt || expiresAt < Date.now()) return res.status(400).send('OAuth 状态无效或已过期');
  if (!text(req.query.code || req.query.authorization_code, 500)) return res.status(400).send('缺少知乎授权码');
  res.send('知乎授权回调已收到，请返回在场继续操作。');
});

function friendlyPage(title, message, backHref) {
  const esc = function (v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };
  return '<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8">'
    + '<meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<title>' + esc(title) + ' · 活问题</title>'
    + '<link rel="icon" href="/assets/favicon.svg" type="image/svg+xml">'
    + '<style>body{margin:0;background:#f4f1e8;color:#141a17;font-family:Consolas,ui-monospace,monospace;'
    + 'display:flex;min-height:100vh;align-items:center;justify-content:center;padding:24px}'
    + 'main{max-width:520px;border:1px solid #141a17;background:#fffef8;padding:32px;box-shadow:9px 9px 0 #141a17}'
    + 'h1{font-size:20px;margin:0 0 14px}p{font-size:13px;line-height:1.9;color:#3c463f;margin:0 0 22px}'
    + 'a{color:#b03d18;font-size:13px}</style></head><body><main><h1>' + esc(title) + '</h1>'
    + '<p>' + esc(message) + '</p><a href="' + esc(backHref) + '">← 返回活问题首页</a></main></body></html>';
}

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
