#!/usr/bin/env node
/**
 * 面向前端的边界检查：确认服务只对外提供页面与资源，
 * 不泄露后端源码、数据文件、脚本与日志。
 * 这是"现场演示 + 公网部署"都必须守住的红线。
 *
 * 运行：node scripts/security-check.mjs   （需要服务已在运行）
 */
import assert from 'node:assert/strict';

const BASE = process.env.HUOWENTI_BASE || 'http://127.0.0.1:4173';

let passed = 0;
let failed = 0;
const results = [];

function check(name, fn) {
  try { fn(); passed += 1; results.push(['PASS', name, '']); }
  catch (error) { failed += 1; results.push(['FAIL', name, error && error.message ? error.message : String(error)]); }
}

function ok(condition, message) { assert.ok(condition, message); }

async function status(path) {
  const response = await fetch(BASE + path, { headers: { Accept: '*/*' } });
  const body = await response.text();
  return { status: response.status, type: (response.headers.get('content-type') || '').split(';')[0], body };
}

const MUST_BLOCK = [
  '/data/cases.json',
  '/data/corpus.json',
  '/data/huowenti.json',
  '/data/cases.json.tmp',
  '/server.js',
  '/lib/corpus.js',
  '/lib/huowenti.js',
  '/package.json',
  '/package-lock.json',
  '/README.md',
  '/DESIGN.md',
  '/PROJECT_MANIFEST.json',
  '/.gitignore',
  '/.env.example',
  '/scripts/e2e.mjs',
  '/scripts/security-check.mjs',
  '/render.yaml',
  '/docs/product-plan.md',
  '/docs/dev-log.md',
  '/AGENTS.md',
  '/DESIGN.md',
  '/提报材料.md',
  '/logs',
  '/node_modules/express/package.json',
  '/.git/config',
  '/.git/HEAD'
];

const TRAVERSAL = [
  '/assets/../server.js',
  '/assets/../data/huowenti.json',
  '/assets/..%2fserver.js',
  '/..%2fserver.js',
  '/data%2Fhuowenti.json',
  '/%2e%2e/server.js',
  '/assets/%2e%2e/%2e%2e/server.js'
];

const MUST_SERVE = [
  ['/', 'text/html'],
  ['/index.html', 'text/html'],
  ['/huowenti.css', 'text/css'],
  ['/huowenti.js', 'application/javascript'],
  ['/huowenti/interview', 'text/html'],
  ['/huowenti/universe', 'text/html'],
  ['/assets/fonts/fonts.css', 'text/css'],
  ['/assets/vendor/three.module.min.js', 'application/javascript'],
  ['/robots.txt', 'text/plain'],
  ['/assets/favicon.svg', 'image/svg+xml']
];

const blocked = await Promise.all(MUST_BLOCK.map(p => status(p).then(r => [p, r])));
const traversed = await Promise.all(TRAVERSAL.map(p => status(p).then(r => [p, r])));
const served = await Promise.all(MUST_SERVE.map(([p]) => status(p).then(r => [p, r])));

for (const [path, response] of blocked) {
  check('不对外提供 ' + path, () => {
    ok(response.status >= 400, '期望被拒绝，实际 HTTP ' + response.status);
    ok(!/import express|"evidence|RELATION_TYPES|node_modules/.test(response.body), '响应体疑似包含源码或数据内容');
  });
}

for (const [path, response] of traversed) {
  check('目录穿越被拦截 ' + path, () => {
    ok(response.status >= 400, '期望被拒绝，实际 HTTP ' + response.status);
    ok(!/import express|RELATION_TYPES|\bquestion\b\s*:/.test(response.body), '响应体疑似泄露后端内容');
  });
}

for (const [path, response] of served) {
  check('正常提供 ' + path, () => {
    ok(response.status === 200, '期望 200，实际 ' + response.status);
  });
}

{
  const health = await status('/api/health');
  check('接口仍然可用 /api/health', () => {
    ok(health.status === 200, '期望 200，实际 ' + health.status);
    ok(/"ok"\s*:\s*true/.test(health.body), '健康检查未返回 ok');
  });
  const legacy = ['/api/cases', '/api/corpus', '/api/weather', '/api/analyze', '/verify/abc', '/case/abc'];
  for (const path of legacy) {
    const gone = await status(path);
    check('前身接口已下线 ' + path, () => {
      ok(gone.status >= 400, '期望 404，实际 ' + gone.status);
    });
  }
  const missing = await status('/api/nope');
  check('未知接口返回 JSON 而不是页面', () => {
    ok(missing.status === 404, '期望 404，实际 ' + missing.status);
  });
}

/* 安全响应头：默认拒绝被第三方嵌入，且不允许外域脚本。 */
{
  const home = await fetch(BASE + '/', { headers: { Accept: 'text/html' } });
  const csp = home.headers.get('content-security-policy') || '';
  const scriptSrc = (csp.split(';').find(part => part.trim().startsWith('script-src')) || '').trim();

  check('页面带 Content-Security-Policy', () => {
    ok(csp.length > 0, '缺少 CSP');
    ok(csp.includes("default-src 'self'"), 'CSP 缺少 default-src 自限');
  });
  check('CSP 只允许本站脚本', () => {
    ok(scriptSrc.includes("'self'"), 'CSP 未声明 script-src self');
    ok(!/unsafe-inline|unsafe-eval/.test(scriptSrc), 'CSP 脚本策略过宽：' + scriptSrc);
  });
  check('CSP 禁止 object 与 base 被劫持', () => {
    ok(csp.includes("object-src 'none'"), '缺少 object-src none');
    ok(csp.includes("base-uri 'none'"), '缺少 base-uri none');
  });
  check('响应头 X-Content-Type-Options', () => {
    ok(home.headers.get('x-content-type-options') === 'nosniff', '期望 nosniff');
  });
  check('响应头 Referrer-Policy', () => {
    ok(home.headers.get('referrer-policy') === 'strict-origin-when-cross-origin', '期望 strict-origin-when-cross-origin');
  });
  check('默认禁止被外站嵌入', () => {
    ok(home.headers.get('x-frame-options') === 'DENY', '期望 X-Frame-Options DENY');
    ok(csp.includes("frame-ancestors 'none'"), '期望 frame-ancestors none');
  });
  check('响应头 Permissions-Policy 收紧设备权限', () => {
    const policy = home.headers.get('permissions-policy') || '';
    ok(/camera=\(\)/.test(policy) && /microphone=\(\)/.test(policy) && /geolocation=\(\)/.test(policy), '设备权限未收紧：' + policy);
  });
  check('响应头 COOP / CORP', () => {
    ok(home.headers.get('cross-origin-opener-policy') === 'same-origin', '缺少 COOP');
    ok(home.headers.get('cross-origin-resource-policy') === 'same-origin', '缺少 CORP');
  });
  check('不暴露服务端实现信息', () => {
    ok(!home.headers.get('x-powered-by'), '仍在暴露 x-powered-by');
  });
}

for (const [state, name, detail] of results) {
  const line = state + ' | ' + name + (detail ? ' | ' + detail : '');
  console.log(line);
}

console.log('');
console.log('共 ' + (passed + failed) + ' 项，通过 ' + passed + ' 项，失败 ' + failed + ' 项');
if (failed > 0) { console.log('SECURITY_CHECK_FAILED'); process.exit(1); }
console.log('SECURITY_CHECK_OK');
