/* 活问题 · 端到端验收（真实浏览器 + 真实服务器）
   这一步不是演示，是验收：每一个 PASS 都对应一次真实渲染或真实接口调用。
   运行前先启动服务，然后：node scripts/e2e.mjs
   需要本机装有 playwright（npm i -D playwright && npx playwright install chromium）。 */
import fs from 'node:fs';

let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch (error) {
  console.log('未找到 playwright。请先执行：npm i -D playwright && npx playwright install chromium');
  process.exit(2);
}

const BASE = process.env.BASE_URL || 'http://127.0.0.1:4173';
const OUT = process.env.SHOTS_DIR || 'logs/shots';
fs.mkdirSync(OUT, { recursive: true });

const errors = [], failed = [], external = [], report = [];
function step(name, ok, detail) {
  report.push({ name, ok: !!ok, detail: detail == null ? '' : String(detail) });
  console.log((ok ? 'PASS' : 'FAIL') + ' | ' + name + (detail ? ' | ' + detail : ''));
}

const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage', '--enable-unsafe-swiftshader'] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'zh-CN' });
const page = await ctx.newPage();
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', e => errors.push('pageerror: ' + e.message));
page.on('requestfailed', r => failed.push(r.url() + ' :: ' + (r.failure() && r.failure().errorText)));
page.on('request', r => { const u = r.url(); if (!u.startsWith(BASE) && !/^(data|blob|about):/.test(u)) external.push(u); });

async function canvasStats(pg, sel) {
  const el = await pg.$(sel);
  if (!el) return { ok: false, why: 'no ' + sel };
  const png = await el.screenshot();
  const dataUrl = 'data:image/png;base64,' + png.toString('base64');
  return await pg.evaluate(async (u) => {
    const img = new Image();
    img.src = u;
    await img.decode();
    const cv = document.createElement('canvas');
    cv.width = img.naturalWidth; cv.height = img.naturalHeight;
    const cx = cv.getContext('2d');
    cx.drawImage(img, 0, 0);
    const d = cx.getImageData(0, 0, cv.width, cv.height).data;
    const hist = new Map();
    let minL = 255, maxL = 0;
    for (let i = 0; i < d.length; i += 4) {
      const key = (d[i] >> 3) + ',' + (d[i + 1] >> 3) + ',' + (d[i + 2] >> 3);
      hist.set(key, (hist.get(key) || 0) + 1);
      const l = d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114;
      if (l < minL) minL = l;
      if (l > maxL) maxL = l;
    }
    const top = [...hist.values()].sort((a, b) => b - a)[0];
    const dominant = top / (d.length / 4);
    return { ok: hist.size > 12 && dominant < 0.985 && (maxL - minL) > 25, why: 'distinctColors=' + hist.size + ' dominant=' + (dominant * 100).toFixed(1) + '% contrast=' + Math.round(maxL - minL) + ' size=' + cv.width + 'x' + cv.height };
  }, dataUrl);
}

await page.goto(BASE + '/', { waitUntil: 'networkidle', timeout: 40000 });
await page.waitForTimeout(2800);
await page.screenshot({ path: OUT + '/01-home.png', fullPage: true });

const home = await page.evaluate(() => {
  const t = s => { const n = document.querySelector(s); return n ? n.textContent.trim() : null; };
  return {
    title: t('#scene-title'),
    gaps: document.querySelectorAll('#scene-gaps > *').length,
    stats: document.querySelectorAll('#scene-stats > *').length,
    legend: document.querySelectorAll('#map-legend > *').length,
    picks: document.querySelectorAll('#pick-list [data-point]').length,
    canvasBox: (() => { const c = document.getElementById('map-canvas'); if (!c) return null; const b = c.getBoundingClientRect(); return [Math.round(b.width), Math.round(b.height)]; })(),
    footNote: t('#foot-note'),
  };
});
step('首屏标题渲染', home.title && home.title.length > 6 && !/加载/.test(home.title), home.title);
step('三个缺口渲染', home.gaps === 3, home.gaps + ' 个');
step('统计条渲染', home.stats >= 3, home.stats + ' 个');
step('三维图例渲染', home.legend >= 3, home.legend + ' 个');
step('可点内容列表渲染', home.picks >= 1, home.picks + ' 条');
step('三维画布有尺寸', home.canvasBox && home.canvasBox[0] > 200 && home.canvasBox[1] > 150, JSON.stringify(home.canvasBox));

const painted = await canvasStats(page, '#map-canvas');
step('三维图真的画出了内容', painted.ok, painted.why);

const shotA = await (await page.$('#map-canvas')).screenshot();
await page.waitForTimeout(1200);
const shotB = await (await page.$('#map-canvas')).screenshot();
let diffBytes = 0;
const minLen = Math.min(shotA.length, shotB.length);
for (let i = 0; i < minLen; i++) if (shotA[i] !== shotB[i]) diffBytes++;
step('画面在持续运动（呼吸/微光）', diffBytes > 200, 'changed png bytes=' + diffBytes + ' of ' + minLen);

const widths = [320, 375, 414, 768, 1440];
const overflow = {};
for (const w of widths) {
  await page.setViewportSize({ width: w, height: 860 });
  await page.waitForTimeout(280);
  overflow[w] = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
}
step('各宽度无横向溢出', widths.every(w => overflow[w] <= 1), JSON.stringify(overflow));
await page.setViewportSize({ width: 1440, height: 1000 });
await page.waitForTimeout(500);

const floor = await page.evaluate(() => {
  const body = parseFloat(getComputedStyle(document.body).fontSize);
  let max = 0, el = null;
  for (const e of document.querySelectorAll('*')) {
    if (!e.textContent.trim() || e.children.length) continue;
    const f = parseFloat(getComputedStyle(e).fontSize);
    if (f > max) { max = f; el = e.className || e.tagName; }
  }
  const S = [...document.querySelectorAll('section')];
  const key = s => {
    const cs = getComputedStyle(s);
    const cols = cs.gridTemplateColumns.split(' ').filter(Boolean).length;
    const h = s.querySelector('h1,h2,h3');
    const inner = [...s.querySelectorAll('*')].slice(0, 60);
    const innerCols = Math.max(0, ...inner.map(e => getComputedStyle(e).gridTemplateColumns.split(' ').filter(Boolean).length));
    const kids = s.children.length;
    const cls = (s.className || '').split(/\s+/).filter(Boolean).join('.');
    const hasCanvas = !!s.querySelector('canvas');
    const hasList = !!s.querySelector('ul,ol');
    const hasForm = !!s.querySelector('input,textarea,button[data-role],[data-role]');
    const hasTable = !!s.querySelector('table');
    const blockish = [...s.querySelectorAll('*')].filter(e => { const c = getComputedStyle(e); return c.display === 'grid' || c.display === 'flex'; }).length;
    return [cols, innerCols, h ? getComputedStyle(h).textAlign : '-', cs.backgroundColor, kids, cls, hasCanvas ? 'cv' : '-', hasList ? 'li' : '-', hasForm ? 'fm' : '-', hasTable ? 'tb' : '-', blockish].join('|');
  };
  const names = new Set();
  for (const sh of document.styleSheets) {
    let rules; try { rules = sh.cssRules; } catch (e) { continue; }
    for (const r of rules || []) for (const m of (r.cssText || '').matchAll(/var\(\s*(--[\w-]+)/g)) names.add(m[1]);
  }
  const root = getComputedStyle(document.documentElement);
  const dead = [];
  for (const n of names) {
    if (root.getPropertyValue(n).trim()) continue;
    let found = false;
    for (const el2 of document.querySelectorAll('*')) { if (getComputedStyle(el2).getPropertyValue(n).trim()) { found = true; break; } }
    if (!found) dead.push(n);
  }
  return {
    body, display: Math.round(max), el, ratio: +(max / body).toFixed(1),
    sections: S.length, distinct: new Set(S.map(key)).size, keys: [...new Set(S.map(key))],
    referenced: names.size, dead,
    ground: getComputedStyle(document.body).backgroundColor,
    h1: document.querySelectorAll('h1').length,
    lang: document.documentElement.lang || null,
    landmarks: ['header', 'main'].filter(t => document.querySelector(t)).length,
    desc: !!document.querySelector('meta[name=description]'),
  };
});
step('字号对比度达到 4 倍（page-design 闸门）', floor.ratio >= 4, floor.display + 'px / ' + floor.body + 'px = ' + floor.ratio);
step('版块形状至少 3 种（A3 闸门）', floor.distinct >= 3 || floor.sections < 3, floor.sections + ' 个版块 / ' + floor.distinct + ' 种形状');
step('没有失效的设计令牌', floor.dead.length === 0, '引用 ' + floor.referenced + ' 个，失效 ' + JSON.stringify(floor.dead));
step('页面自己铺了底色', floor.ground !== 'rgba(0, 0, 0, 0)', floor.ground);
step('全站只有一个 h1', floor.h1 === 1, floor.h1 + ' 个');
step('语言与语义结构正确', floor.lang === 'zh-CN' && floor.landmarks === 2 && floor.desc, JSON.stringify({ lang: floor.lang, landmarks: floor.landmarks, desc: floor.desc }));

const tokens = await page.evaluate(() => {
  const cs = getComputedStyle(document.documentElement);
  const cta = document.querySelector('.cta');
  const mark = document.querySelector('.mark');
  const pick = document.querySelector('.pick');
  return {
    dur: ['--dur-instant', '--dur-fast', '--dur-standard', '--dur-medium', '--dur-slow', '--dur-cinematic'].map(k => cs.getPropertyValue(k).trim()).filter(Boolean).length,
    springs: ['--spring-snappy', '--spring-gentle', '--spring-jelly'].map(k => cs.getPropertyValue(k).trim()).join(' | '),
    back: cs.getPropertyValue('--ease-out-back').trim(),
    ctaTransition: cta ? getComputedStyle(cta).transitionDuration : null,
    markAnim: mark ? getComputedStyle(mark).animationName + ' ' + getComputedStyle(mark).animationDuration : null,
    pickTransition: pick ? getComputedStyle(pick).transitionDuration : null,
  };
});
step('动效时长分档令牌生效', tokens.dur >= 5, tokens.dur + ' 档');
step('弹簧与过冲缓动已接入', tokens.springs.length > 20 && !!tokens.back, tokens.markAnim + ' · ' + tokens.pickTransition);

// ---- 真实流程 ----
await page.goto(BASE + '/#/interview', { waitUntil: 'networkidle' });
await page.waitForTimeout(1600);
await page.click('.role-grid [data-role]');
await page.waitForTimeout(1600);
await page.screenshot({ path: OUT + '/02-interview.png', fullPage: true });
const formCount = await page.locator('#interview-body [data-q]').count();
step('采访表单渲染', formCount >= 4, formCount + ' 个问题');

const inputs = page.locator('#interview-body [data-q]');
const n = await inputs.count();
const sample = ['普通本科 · 信息管理 · 大三', '无互联网实习', '一个可运行的校园拼单小程序，注册 400 人，我负责需求与迭代', 'AI 创业公司', '已经投了 27 份，3 次面试，最好二面', '面试官追问日活是不是我自己统计的'];
for (let i = 0; i < n; i++) await inputs.nth(i).fill(sample[i % sample.length]);
await page.click('#interview-submit');
await page.waitForTimeout(2600);
const interviewMsg = await page.evaluate(() => { const e = document.getElementById('interview-msg'); return e && !e.hidden ? e.textContent.trim() : null; });
step('采访提交没有报错', !interviewMsg, interviewMsg || '无错误提示');
const fuBox = await page.locator('.followup').count();
step('追问环节出现', fuBox >= 1, fuBox + ' 个追问框');
const fuText = await page.evaluate(() => { const e = document.querySelector('.followup .qtext'); return e ? e.textContent.replace(/\s+/g, ' ').trim().slice(0, 160) : null; });
step('追问是基于刚填内容生成的', !!fuText && fuText.length > 8, fuText || 'null');
await page.screenshot({ path: OUT + '/02b-followup.png', fullPage: true });
if (await page.locator('#followup-answer').count()) {
  await page.locator('#followup-answer').fill('数字来自小程序后台的注册统计，截图保存在本地。');
  await page.click('#followup-submit');
  await page.waitForTimeout(2600);
} else {
  await page.click('#followup-skip');
  await page.waitForTimeout(2600);
}
await page.screenshot({ path: OUT + '/03-card.png', fullPage: true });
const cardText = await page.evaluate(() => { const e = document.getElementById('card-body'); return e ? e.textContent.replace(/\s+/g, ' ').trim().slice(0, 400) : null; });
step('贡献卡生成', !!cardText && cardText.length > 40, cardText ? cardText.slice(0, 140) : 'null');

const cardLayout = await page.evaluate(() => {
  const f = document.querySelector('#card-body .fact');
  if (!f) return { ok: false, why: 'no .fact' };
  const cs = getComputedStyle(f);
  const k = f.querySelector('.k'), v = f.querySelector('.v'), o = f.querySelector('.org');
  return { ok: !!k && !!v, why: 'grid=' + cs.gridTemplateColumns + ' k=' + (k ? getComputedStyle(k).color : 'none') + ' org=' + (o ? 'yes' : 'no') };
});
step('贡献卡字段样式正确（本轮修复项）', cardLayout.ok, cardLayout.why);

const confirmBtn = page.locator('#card-body button').first();
if (await confirmBtn.count()) {
  await confirmBtn.click();
  await page.waitForTimeout(3200);
  await page.screenshot({ path: OUT + '/04-changes.png', fullPage: true });
  const changes = await page.evaluate(() => document.querySelectorAll('#changes-list > *').length);
  step('问题变化页渲染', changes >= 3, changes + ' 条变化');
}

await page.goto(BASE + '/#/universe', { waitUntil: 'networkidle' });
await page.waitForTimeout(3000);
await page.screenshot({ path: OUT + '/05-universe.png', fullPage: true });
const cosmos = await canvasStats(page, '#cosmos-canvas');
const cosmosList = await page.evaluate(() => document.querySelectorAll('#cosmos-list > *').length);
step('知识宇宙真的画出来了', cosmos.ok, cosmos.why + ' · 列表 ' + cosmosList + ' 条');

await page.goto(BASE + '/#/conclusions', { waitUntil: 'networkidle' });
await page.waitForTimeout(2400);
await page.screenshot({ path: OUT + '/06-conclusions.png', fullPage: true });
const concl = await page.evaluate(() => {
  const t = s => { const n = document.querySelector(s); return n ? n.textContent.trim() : null; };
  return { title: t('#concl-title'), items: document.querySelectorAll('#concl-list > *').length };
});
step('结论页渲染', !!concl.title && concl.items >= 3, JSON.stringify(concl).slice(0, 160));

await page.goto(BASE + '/#/answer', { waitUntil: 'networkidle' });
await page.waitForTimeout(3000);
await page.screenshot({ path: OUT + '/07-answer.png', fullPage: true });
const draft = await page.evaluate(() => { const b = document.getElementById('answer-body'); return b ? b.value.length : 0; });
step('知乎回答草稿生成', draft > 200, draft + ' 字');

await page.goto(BASE + '/#/new', { waitUntil: 'networkidle' });
await page.waitForTimeout(1600);
await page.fill('#new-question', '普通本科应届生投 AI 产品岗，简历关卡在哪里？');
await page.click('#new-submit');
await page.waitForTimeout(3000);
await page.screenshot({ path: OUT + '/08-new.png', fullPage: true });
const verdict = await page.evaluate(() => { const e = document.getElementById('new-verdict'); return e ? e.textContent.replace(/\s+/g, ' ').trim().slice(0, 300) : null; });
step('新问题判定有输出', !!verdict && verdict.length > 20, verdict ? verdict.slice(0, 120) : 'null');

await page.goto(BASE + '/', { waitUntil: 'networkidle' });
await page.waitForTimeout(2400);
const sig = () => page.evaluate(() => {
  const vis = [...document.querySelectorAll('body *')].slice(0, 400).map(e => { const c = getComputedStyle(e); return c.transform + '|' + c.opacity + '|' + c.backgroundColor; }).join(';');
  return Math.round(scrollY) + '#' + vis;
});
const before = await sig();
await page.mouse.move(700, 500);
await page.mouse.wheel(0, 600);
await page.waitForTimeout(900);
const afterWheel = await sig();
step('真实滚轮会改变画面', afterWheel !== before, 'changed=' + (afterWheel !== before));
await page.evaluate(() => scrollTo(0, 0));
await page.waitForTimeout(700);

// ---- reduced-motion ----
const rmCtx = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce', locale: 'zh-CN' });
const rmPage = await rmCtx.newPage();
const rmErrors = [];
rmPage.on('pageerror', e => rmErrors.push(e.message));
await rmPage.goto(BASE + '/', { waitUntil: 'networkidle' });
await rmPage.waitForTimeout(2400);
const rm = await rmPage.evaluate(() => {
  const mark = document.querySelector('.mark');
  const title = document.querySelector('#scene-title');
  return { markAnim: mark ? getComputedStyle(mark).animationName : null, titleOpacity: title ? getComputedStyle(title).opacity : null, gaps: document.querySelectorAll('#scene-gaps > *').length };
});
const rmPaint = await canvasStats(rmPage, '#map-canvas');
step('reduced-motion 下内容照常出现（B8）', rm.gaps === 3 && rm.titleOpacity === '1' && rmPaint.ok, JSON.stringify(rm) + ' · ' + rmPaint.why);
await rmPage.screenshot({ path: OUT + '/09-reduced-motion.png', fullPage: true });

// ---- 移动端 ----
const mCtx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, locale: 'zh-CN' });
const mPage = await mCtx.newPage();
const mErrors = [];
mPage.on('pageerror', e => mErrors.push(e.message));
await mPage.goto(BASE + '/', { waitUntil: 'networkidle' });
await mPage.waitForTimeout(2800);
await mPage.screenshot({ path: OUT + '/10-mobile.png', fullPage: true });
const mOverflow = await mPage.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
step('移动端无横向溢出', mOverflow <= 2, 'overflow=' + mOverflow);

fs.writeFileSync((process.env.REPORT_PATH || 'logs/e2e-report.json'), JSON.stringify({ errors, failed, external: [...new Set(external)], report, mobileErrors: mErrors, rmErrors, shapeKeys: floor.keys }, null, 2));
console.log('--- CONSOLE/PAGE ERRORS ---'); console.log(JSON.stringify(errors, null, 2));
console.log('--- FAILED REQUESTS ---'); console.log(JSON.stringify(failed, null, 2));
console.log('--- EXTERNAL REQUESTS ---'); console.log(JSON.stringify([...new Set(external)], null, 2));
console.log('--- SECTION SHAPES ---'); console.log(JSON.stringify(floor.keys, null, 1));
console.log('--- SUMMARY ---');
console.log(report.filter(r => !r.ok).length + ' failing of ' + report.length);
await browser.close();
