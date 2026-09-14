
/* 端到端浏览器验收（可选：需要先装 playwright）
   用真实浏览器走完整流程：提问 → 拆解 → 拿到求证链接 → 多位到场者提交反馈 → 生成结论。
   每一步截图，便于人工复核视觉。 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.env.BASE_URL || 'http://localhost:4173';
const SHOTS = path.join(process.cwd(), 'logs', 'shots');
fs.mkdirSync(SHOTS, { recursive: true });

const results = [];
function step(name, ok, detail) {
  results.push({ name: name, ok: !!ok, detail: detail == null ? '' : String(detail) });
  console.log((ok ? 'PASS' : 'FAIL') + ' | ' + name + (detail ? ' | ' + detail : ''));
}

const consoleErrors = [];
const browser = await chromium.launch();
const externalRequests = [];
const origNewContext = browser.newContext.bind(browser);
browser.newContext = async function (opts) {
  const ctx = await origNewContext(opts);
  ctx.on('request', function (req) {
    const u = req.url();
    if (!u.startsWith(BASE) && !/^(data|blob|about):/.test(u)) externalRequests.push(u);
  });
  return ctx;
};
try {
  const asker = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'zh-CN' });
  const page = await asker.newPage();
  page.on('console', function (msg) { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
  page.on('pageerror', function (err) { consoleErrors.push('pageerror: ' + err.message); });

  await page.goto(BASE + '/', { waitUntil: 'networkidle' });
  await page.waitForFunction(function () { return !/正在读取/.test(document.getElementById('live-text').textContent); }, null, { timeout: 15000 });
  const liveText = (await page.textContent('#live-text')).trim();
  step('首页顶部状态载入', /已接入|暂不可用/.test(liveText), liveText);
  await page.screenshot({ path: path.join(SHOTS, '01-home.png'), fullPage: true });

  const question = '今晚798艺术区还开着吗，从东门进要排队多久？';
  await page.fill('#question', question);
  await page.click('#start');
  await page.waitForSelector('#evidence-panel', { timeout: 20000 });
  step('案件创建并出现反馈面板', true, question);
  await page.screenshot({ path: path.join(SHOTS, '02-analysis.png'), fullPage: true });

  const state0 = (await page.textContent('#evidence-panel .meter-row span')).trim();
  const feedbackUrl = (await page.evaluate(function () {
    const code = document.querySelector('#evidence-panel .share code');
    return code ? code.textContent.trim() : '';
  })).replace(/^https?:\/\/[^/]+/, '');
  step('拿到可分享的求证链接', /^\/verify\//.test(feedbackUrl), feedbackUrl);
  step('无反馈时状态为待确认', /待现场确认|PENDING/i.test(state0), state0);

  const qrHome = await page.evaluate(function () {
    const block = document.querySelector('#evidence-panel .qr-block');
    const svg = block ? block.querySelector('svg') : null;
    const shown = block ? block.querySelector('.qr-copy code') : null;
    const share = document.querySelector('#evidence-panel .share code');
    if (!svg) return { ok: false, why: '没有二维码' };
    const box = svg.getBoundingClientRect();
    const shareText = share ? share.textContent.trim() : '';
    const qrText = shown ? shown.textContent.trim() : '';
    return {
      ok: svg.getAttribute('role') === 'img' && box.width >= 90 && box.height >= 90 && shareText.length > 0 && shareText === qrText,
      why: '尺寸 ' + Math.round(box.width) + '×' + Math.round(box.height) + ' · 可被读屏识别=' + (svg.getAttribute('role') === 'img') + ' · 与页面链接一致=' + (shareText === qrText)
    };
  });
  step('反馈面板出现可扫码的求证入口', qrHome.ok, qrHome.why);

  const caseId = feedbackUrl.split('/verify/')[1];
  const noAnswerRes = await asker.request.post(BASE + '/api/cases/' + encodeURIComponent(caseId) + '/answer', { headers: { 'Content-Type': 'application/json' }, data: {}, failOnStatusCode: false });
  const noAnswer = noAnswerRes.status();
  step('没有反馈时拒绝生成结论', noAnswer === 409, 'HTTP ' + noAnswer);

  const witness = await browser.newContext({ viewport: { width: 1440, height: 1100 }, locale: 'zh-CN' });
  const vpage = await witness.newPage();
  vpage.on('pageerror', function (err) { consoleErrors.push('verify pageerror: ' + err.message); });
  await vpage.goto(BASE + feedbackUrl, { waitUntil: 'networkidle' });
  await vpage.waitForSelector('#relation-grid label', { timeout: 10000 });
  const forms = await vpage.locator('#relation-grid label').count();
  step('反馈表单可打开且选项完整', forms === 4, forms + ' 个关系选项');
  await vpage.screenshot({ path: path.join(SHOTS, '03-verify-form.png'), fullPage: true });

  async function submitFeedback(ctx, payload, shot) {
    const p = await ctx.newPage();
    p.on('pageerror', function (err) { consoleErrors.push('feedback pageerror: ' + err.message); });
    await p.goto(BASE + feedbackUrl, { waitUntil: 'networkidle' });
    await p.waitForSelector('#relation-grid label', { timeout: 10000 });
    if (payload.name) await p.fill('input[name="displayName"]', payload.name);
    if (payload.area) await p.fill('input[name="area"]', payload.area);
    await p.fill('textarea[name="content"]', payload.content);
    if (payload.relationType) await p.check('input[name="relationType"][value="' + payload.relationType + '"]');
    await p.click('#submit');
    await p.waitForFunction(function () { return document.querySelector('#result').className.indexOf('ok') !== -1 || document.querySelector('#result').className.indexOf('err') !== -1; }, null, { timeout: 15000 });
    const cls = await p.getAttribute('#result', 'class');
    const msg = (await p.textContent('#result')).trim();
    if (shot) await p.screenshot({ path: path.join(SHOTS, shot), fullPage: true });
    await p.close();
    return { ok: cls.indexOf('ok') !== -1, msg: msg };
  }

  const fb1 = await submitFeedback(witness, { name: '小周', area: '798 东门', content: '我现在就在东门，门口排了很长的队，人非常多，估计要等四十分钟以上。' }, '04-feedback-1.png');
  step('第一位到场者提交成功', fb1.ok, fb1.msg.slice(0, 70));

  const fb2 = await submitFeedback(witness, { name: '匿名现场用户', area: '798 东门', content: '刚走到东门，不用排队，人很少，很空，直接进就行。' }, '05-feedback-2.png');
  step('第二位到场者提交成功', fb2.ok, fb2.msg.slice(0, 70));

  await page.click('#refresh-case');
  await page.waitForTimeout(2500);
  const conflictState = (await page.textContent('#evidence-panel .meter-row span')).trim();
  const hasConflictBox = await page.locator('.conflict-box').count();
  step('两条矛盾反馈被判为存在冲突', /CONFLICT/i.test(conflictState), conflictState);
  step('界面明确展示分歧点', hasConflictBox > 0, '分歧区块 ' + hasConflictBox + ' 个');
  const dimCards = await page.locator('.dims .dim').count();
  const flowDimText = await page.evaluate(function () {
    const cards = Array.prototype.slice.call(document.querySelectorAll('.dims .dim'));
    const hit = cards.filter(function (c) { return /人流|等待/.test(c.textContent); })[0];
    return hit ? hit.textContent.replace(/\s+/g, ' ').trim() : '';
  });
  step('分维度结论卡片可见', dimCards >= 1, dimCards + ' 个维度卡片');
  step('人流维度被单独标出分歧', /分歧/.test(flowDimText), flowDimText.slice(0, 60));

  const fbTagText = await page.evaluate(function () {
    return Array.prototype.slice.call(document.querySelectorAll('.fb-tags')).map(function (n) { return n.textContent; }).join(' | ');
  });
  step('反馈条目带时效标签', /现场有效|仍然新鲜|开始过时|已过时/.test(fbTagText), fbTagText.replace(/\s+/g, ' ').slice(0, 90));
  const panelFresh = await page.evaluate(function () {
    const nodes = Array.prototype.slice.call(document.querySelectorAll('#evidence-panel p'));
    const hit = nodes.filter(function (n) { return /最新一条现场观察/.test(n.textContent); })[0];
    return hit ? hit.textContent.replace(/\s+/g, ' ').trim() : '';
  });
  step('证据面板显示最新一条时效', panelFresh.length > 0, panelFresh.slice(0, 70));
  await page.screenshot({ path: path.join(SHOTS, '06-conflict.png'), fullPage: true });

  const official = await browser.newContext({ viewport: { width: 1440, height: 1100 }, locale: 'zh-CN' });
  const fb3 = await submitFeedback(official, { name: '场馆公告', area: '官方渠道', content: '官方公告：东门今晚正常开放，但实施限流，建议从北门入场。', relationType: 'official' }, '07-feedback-3.png');
  step('官方渠道反馈被接收', fb3.ok, fb3.msg.slice(0, 70));

  await page.click('#refresh-case');
  await page.waitForTimeout(2500);
  const finalState = (await page.textContent('#evidence-panel .meter-row span')).trim();
  step('官方反馈进入证据链', finalState.length > 0, finalState);

  await page.click('#final');
  await page.waitForSelector('#answer', { timeout: 20000 });
  const answerText = (await page.textContent('#answer')).replace(/\s+/g, ' ');
  step('基于真实证据生成结论', answerText.length > 40, answerText.slice(0, 130));
  await page.screenshot({ path: path.join(SHOTS, '08-answer.png'), fullPage: true });

  const cp = await asker.newPage();
  const resp = await cp.goto(BASE + '/case/' + caseId, { waitUntil: 'networkidle' });
  const caseBody = (await cp.textContent('body')).replace(/\s+/g, ' ');
  step('结论页可以分享并打开', resp.status() === 200, 'HTTP ' + resp.status());
  step('结论页包含证据与来源', /知乎|现场反馈|证据/.test(caseBody), caseBody.slice(0, 100));
  step('结论页展示最新一条现场观察', /最新一条现场观察/.test(caseBody), (caseBody.match(/最新一条现场观察[^ ]*/) || [''])[0].slice(0, 70));
  await cp.screenshot({ path: path.join(SHOTS, '09-case.png'), fullPage: true });

  const qrCase = await cp.evaluate(function () {
    const svg = document.querySelector('#case .qr-block svg');
    if (!svg) return { ok: false, why: '结论页没有二维码' };
    const box = svg.getBoundingClientRect();
    return { ok: svg.getAttribute('role') === 'img' && box.width >= 90, why: '尺寸 ' + Math.round(box.width) + '×' + Math.round(box.height) };
  });
  step('结论页同样可以扫码转发', qrCase.ok, qrCase.why);

  const narrowCase = await browser.newContext({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true, locale: 'zh-CN' });
  const np = await narrowCase.newPage();
  np.on('pageerror', function (err) { consoleErrors.push('narrow case pageerror: ' + err.message); });
  await np.goto(BASE + '/case/' + caseId, { waitUntil: 'networkidle' });
  await np.waitForSelector('#case .qr-block svg', { timeout: 12000 });
  const narrowQr = await np.evaluate(function () {
    const svg = document.querySelector('#case .qr-block svg');
    const box = svg.getBoundingClientRect();
    const docOverflow = document.documentElement.scrollWidth - document.documentElement.clientWidth;
    return {
      ok: box.width > 0 && box.right <= document.documentElement.clientWidth + 1 && docOverflow <= 2,
      why: '图宽 ' + Math.round(box.width) + 'px · 溢出 ' + docOverflow + 'px'
    };
  });
  step('窄屏下二维码完整可见且不挤压版面', narrowQr.ok, narrowQr.why);
  await np.screenshot({ path: path.join(SHOTS, '11-mobile-qr.png'), fullPage: true });
  await narrowCase.close();

  const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale: 'zh-CN' });
  const mp = await mobile.newPage();
  await mp.goto(BASE + feedbackUrl, { waitUntil: 'networkidle' });
  await mp.screenshot({ path: path.join(SHOTS, '10-mobile-verify.png'), fullPage: true });
  const overflow = await mp.evaluate(function () { return document.documentElement.scrollWidth - document.documentElement.clientWidth; });
  step('手机端没有横向溢出', overflow <= 2, '溢出 ' + overflow + 'px');

  const dup = await submitFeedback(witness, { name: '路人甲', area: '798 东门', content: '我现在就在东门，门口排了很长的队，人非常多，估计要等四十分钟以上。' }, null);
  step('重复内容被识别为重复来源', /重复/.test(dup.msg), dup.msg.slice(0, 70));

  step('页面零外部网络请求（无外网也能完整演示）', externalRequests.length === 0, externalRequests.length ? externalRequests.slice(0, 3).join(' | ') : '全部资源来自本机');

  const fontOk = await page.evaluate(function () {
    if (!document.fonts) return { ok: false, why: 'no fontface api' };
    const serif = document.fonts.check('700 24px "Noto Serif SC"');
    const mono = document.fonts.check('400 14px "DM Mono"');
    return { ok: serif && mono, why: 'serif=' + serif + ' mono=' + mono };
  });
  step('自托管中英文字体已生效', fontOk.ok, fontOk.why);

  const CONTRAST_FN = function () {
    function parse(c) {
      const m = /rgba?\(([^)]+)\)/.exec(c);
      if (!m) return null;
      const p = m[1].split(',').map(function (x) { return parseFloat(x); });
      return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
    }
    function lum(c) {
      function f(v) { v = v / 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }
      return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
    }
    function over(fg, bg) {
      const a = fg.a == null ? 1 : fg.a;
      return { r: fg.r * a + bg.r * (1 - a), g: fg.g * a + bg.g * (1 - a), b: fg.b * a + bg.b * (1 - a), a: 1 };
    }
    function bgOf(el) {
      const chain = [];
      let n = el;
      while (n) {
        const c = parse(getComputedStyle(n).backgroundColor);
        if (c && c.a > 0) chain.push(c);
        if (c && c.a >= 0.999) break;
        n = n.parentElement;
      }
      let base = { r: 255, g: 255, b: 255, a: 1 };
      for (let i = chain.length - 1; i >= 0; i--) base = over(chain[i], base);
      return base;
    }
    const targets = ['.lede', 'body', '.brand small', '.examples button', '.note', '.qbar h2', 'label.field', '.privacy', '.radio-grid small', '.case-q small', '.fb-tags span', '.meter-row', '.confidence .num small', '.dims-title i', '.dim-head i', '.conflict-box p', '.empty p', '.hint', '.crumb', 'footer.site', '.legend', '.answers .fb p', '.case-q strong', '.answer-text', '.signal-rail p', '.answer .note', '.answer .kicker i', '.answer .actions a', '.answer h2'];
    const bad = [];
    let checked = 0;
    targets.forEach(function (sel) {
      const el = document.querySelector(sel);
      if (!el) return;
      const st = getComputedStyle(el);
      const fg = parse(st.color);
      if (!fg) return;
      const bg = bgOf(el);
      const l1 = lum(fg), l2 = lum(bg);
      const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
      const size = parseFloat(st.fontSize);
      const weight = parseInt(st.fontWeight, 10) || 400;
      const large = size >= 24 || (size >= 18.66 && weight >= 700);
      const need = large ? 3 : 4.5;
      checked++;
      if (ratio < need) bad.push(sel + ' ' + ratio.toFixed(2) + '<' + need);
    });
    return { checked: checked, bad: bad };
  };
  const contrastPages = [
    { name: '首页', url: '/' },
    { name: '求证页', url: feedbackUrl },
    { name: '结论页', url: '/case/' + caseId }
  ];
  const contrastIssues = [];
  let contrastChecked = 0;
  for (const cp2 of contrastPages) {
    const cpg = await asker.newPage();
    await cpg.goto(BASE + cp2.url, { waitUntil: 'networkidle' });
    const r2 = await cpg.evaluate(CONTRAST_FN);
    contrastChecked += r2.checked;
    r2.bad.forEach(function (b) { contrastIssues.push(cp2.name + ' ' + b); });
    await cpg.close();
  }
  step('正文与标题对比度达到无障碍标准', contrastIssues.length === 0, contrastChecked + ' 处检查' + (contrastIssues.length ? '，不达标：' + contrastIssues.join('，') : '，全部达标'));

  for (const w of [375, 414]) {
    const mc = await browser.newContext({ viewport: { width: w, height: 844 }, isMobile: true, hasTouch: true, locale: 'zh-CN' });
    const mpg = await mc.newPage();
    await mpg.goto(BASE + '/', { waitUntil: 'networkidle' });
    const ov = await mpg.evaluate(function () { return document.documentElement.scrollWidth - document.documentElement.clientWidth; });
    const tapOk = await mpg.evaluate(function () {
      const els = Array.prototype.slice.call(document.querySelectorAll('button, a, input, textarea'));
      const small = els.filter(function (e) { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.height < 30; });
      return small.length;
    });
    step(w + 'px 手机宽度无横向溢出', ov <= 2, '溢出 ' + ov + 'px');
    step(w + 'px 可点区域不过小', tapOk === 0, tapOk + ' 个偏小控件');
    await mc.close();
  }

  const a11y = await asker.newPage();
  await a11y.goto(BASE + '/', { waitUntil: 'networkidle' });
  const a11yRes = await a11y.evaluate(function () {
    const q = document.getElementById('question');
    const start = document.getElementById('start');
    const lang = document.documentElement.getAttribute('lang');
    return {
      lang: lang,
      qLabel: q && (q.getAttribute('aria-label') || (q.labels && q.labels.length) || q.getAttribute('placeholder')),
      startText: start ? start.textContent.trim().length : 0,
      headings: document.querySelectorAll('h1').length
    };
  });
  step('页面语言与主标题结构正确', a11yRes.lang === 'zh-CN' && a11yRes.headings >= 1, 'lang=' + a11yRes.lang + ' h1=' + a11yRes.headings);
  step('提问框有可读标签、按钮有文字', !!a11yRes.qLabel && a11yRes.startText > 0, 'label=' + String(a11yRes.qLabel).slice(0, 24) + ' 按钮文字=' + a11yRes.startText + '字');
  await a11y.close();

  const realErrors = consoleErrors.filter(function (t) { return !/409 \(Conflict\)/.test(t); });
  step('浏览器控制台无报错', realErrors.length === 0, realErrors.slice(0, 3).join(' / '));
} catch (error) {
  step('流程中断', false, error.message);
} finally {
  await browser.close();
}

const failed = results.filter(function (r) { return !r.ok; });
fs.writeFileSync(path.join(process.cwd(), 'logs', 'browser-check.json'), JSON.stringify({ at: new Date().toISOString(), question: '今晚798艺术区还开着吗，从东门进要排队多久？', caseId: null, results: results }, null, 2), 'utf8');
console.log('');
console.log('共 ' + results.length + ' 项，通过 ' + (results.length - failed.length) + ' 项，失败 ' + failed.length + ' 项');
console.log(failed.length ? 'BROWSER_CHECK_FAILED' : 'BROWSER_CHECK_OK');
process.exit(failed.length ? 1 : 0);
