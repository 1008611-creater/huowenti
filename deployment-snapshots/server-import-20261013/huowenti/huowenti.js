/* 活问题 · 前端
   约束：CSP 只允许本站脚本，没有内联 script、没有内联事件处理器、没有外部 CDN。
   三维部分只用 three.js 核心能力（Points / BufferGeometry / ShaderMaterial），没有引入任何附加控件。 */

import * as THREE from './assets/vendor/three.module.min.js';

const API = '/api/huowenti';
const SUBTOPIC_ORDER = ['background', 'project', 'apply', 'screen', 'company', 'result'];
const ORIGIN_COLOR = { zhihu: '#4c8dff', sample: '#8f9aa6', contribution: '#3ddc84', ai: '#d9f45f' };

const state = {
  summary: null,
  graph: null,
  roles: {},
  roleKey: null,
  draftId: null,
  answers: null,
  followUp: null,
  card: null,
  contribution: null,
  changes: null,
  nextQuestion: null,
  answer: null,
  contributions: null,
  demo: false
};

/* ---------- 小工具 ---------- */
function el(id) { return document.getElementById(id); }
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function show(node, on) { if (node) node.hidden = !on; }
function setHTML(node, html) { if (node) node.innerHTML = html; }
function tag(text, cls) { return '<span class="tag ' + (cls || '') + '">' + esc(text) + '</span>'; }
function subtopicName(key) {
  const items = (state.graph && state.graph.axis && state.graph.axis.y && state.graph.axis.y.items) || [];
  const hit = items.filter(function (i) { return i.key === key; })[0];
  if (hit) return hit.name;
  const sub = (state.summary && state.summary.subtopics || []).filter(function (i) { return i.key === key; })[0];
  return sub ? sub.name : key;
}
function colorFor(origin) { return ORIGIN_COLOR[origin] || '#8f9aa6'; }

async function api(path, options) {
  const res = await fetch(API + path, Object.assign({
    headers: { 'Content-Type': 'application/json' }
  }, options || {}));
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch (e) { body = { raw: text }; }
  if (!res.ok) {
    const msg = (body && (body.message || body.error)) || ('请求失败 ' + res.status);
    const err = new Error(msg);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

/* ---------- 动效内核 ----------
   来源：motion-web references/handfeel.md 与 motion-tokens.md。
   只用 transform / opacity；不碰 width、height、box-shadow、border-radius。
   全部动效都尊重系统「减弱动态效果」设置。 */
const MOTION = (function () {
  const mq = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
  let reduced = !!(mq && mq.matches);
  if (mq) {
    const onChange = function (e) { reduced = !!e.matches; };
    if (mq.addEventListener) mq.addEventListener('change', onChange);
    else if (mq.addListener) mq.addListener(onChange);
  }

  /* 时长阶梯（秒），与 CSS 令牌一一对应 */
  const DUR = { instant: 0.09, fast: 0.17, standard: 0.32, medium: 0.46, slow: 0.7, cinematic: 1.2 };

  /* 错开节奏（毫秒），对应 motion-web references/motion-tokens.md 的 stagger 阶梯。
     此前所有调用点都传 0，等于错开机制挂在那里没生效；现在按内容类型分开取值。 */
  const STAGGER = {
    'tight-grid': 40,
    'standard-list': 75,
    'editorial-line': 90,
    'dramatic-cascade': 150,
    'no-stagger': 0
  };

  /* 欠阻尼弹簧：替代 lerp，落点带一点过冲，读起来才有重量。
     stiffness 60–90；damping 0.86 活泼 / 0.90 果冻 / 0.93 沉稳。 */
  function spring(state, target, dt, stiffness, damping) {
    const k = stiffness || 78;
    const d = damping || 0.90;
    state.vel += (target - state.x) * k * dt;
    state.vel *= d;
    state.x += state.vel * dt;
    return state.x;
  }

  /* 帧率无关的跟随：k 是「紧度」(1/s)，不是每帧比例。
     用在必须到位就停的地方——镜头、跟随指针的浮层。 */
  function follow(x, target, k, dt) {
    return x + (target - x) * (1 - Math.exp(-k * dt));
  }

  /* 滚轮惯性防护：触控板抬手后还会继续发事件，累积到阈值才走一步，然后锁一小段。 */
  function wheelGuard() {
    let acc = 0, lockedUntil = 0;
    return {
      step: function (delta, now) {
        if (now < lockedUntil) { acc *= 0.92; return 0; }
        if (Math.sign(delta) !== Math.sign(acc)) acc = 0;
        acc += delta;
        if (Math.abs(acc) >= 90) {
          const dir = Math.sign(acc);
          acc = 0;
          lockedUntil = now + 600;
          return dir;
        }
        acc *= 0.92;
        return 0;
      },
      reset: function () { acc = 0; }
    };
  }

  /* 速度耦合：元素朝运动方向倾斜，停下自动回正。 */
  function lean(vel, gain, max) {
    const v = vel * (gain == null ? 0.5 : gain);
    const m = max == null ? 22 : max;
    return v > m ? m : (v < -m ? -m : v);
  }

  /* 静止呼吸：每个元素不同频率、不同相位，任何两个都不同步。 */
  function breath(now, freq, phase) {
    return Math.sin(now * (freq || 1.1) + (phase || 0));
  }

  /* will-change 只在动画期间挂上，结束就摘掉。 */
  function willChange(node, on) {
    if (!node || !node.style) return;
    node.style.willChange = on ? 'transform,opacity' : 'auto';
  }

  /* 异步结果播报：读屏用户在结果出现时能听到，不必自己去找。
     urgent=true 走 assertive 区域，用于报错。 */
  function announce(text, urgent) {
    const host = document.getElementById(urgent ? 'live-alert' : 'live-region');
    if (!host || !text) return;
    host.textContent = '';
    window.setTimeout(function () { host.textContent = String(text); }, 40);
  }

  /* 进场编排：一次只给真正需要显影的区块。
     kind 决定形状（rise 位移 / land 过冲落位 / jelly 果冻落位），
     dur 决定走哪一档时长，stagger 决定同一组里相邻元素的错开毫秒数。 */
  function reveal(nodes, opts) {
    const list = Array.prototype.slice.call(nodes || []);
    const o = opts || {};
    if (reduced) {
      list.forEach(function (n) { n.classList.add('rise'); n.classList.add('rise-done'); });
      return;
    }
    const kind = o.kind === 'land' ? 'land' : (o.kind === 'jelly' ? 'jelly' : 'rise');
    const durCls = o.dur === 'slow' ? 'rise--slow' : (o.dur === 'cinematic' ? 'rise--cold' : '');
    list.forEach(function (n, i) {
      const delay = (o.base || 0) + i * (o.stagger == null ? STAGGER['standard-list'] : o.stagger);
      n.style.animationDelay = delay + 'ms';
      n.classList.add(kind);
      if (durCls) n.classList.add(durCls);
      n.addEventListener('animationend', function () {
        n.classList.remove('rise', 'land', 'jelly', 'rise--slow', 'rise--cold');
        n.style.animationDelay = '';
        n.classList.add('rise-done');
        willChange(n, false);
      }, { once: true });
    });
  }

  return {
    get reduced() { return reduced; },
    DUR: DUR, STAGGER: STAGGER, spring: spring, follow: follow, wheelGuard: wheelGuard,
    lean: lean, breath: breath, willChange: willChange, reveal: reveal, announce: announce
  };
})();

/* ---------- 路由 ---------- */
const VIEWS = {
  scene: 'view-scene',
  interview: 'view-interview',
  card: 'view-card',
  changes: 'view-changes',
  conclusions: 'view-conclusions',
  answer: 'view-answer',
  universe: 'view-universe',
  new: 'view-new'
};

function parseHash() {
  let raw = String(location.hash || '').replace(/^#\/?/, '');
  let query = {};
  const qi = raw.indexOf('?');
  if (qi >= 0) {
    raw.slice(qi + 1).split('&').forEach(function (pair) {
      if (!pair) return;
      const kv = pair.split('=');
      query[decodeURIComponent(kv[0])] = decodeURIComponent(kv[1] || '');
    });
    raw = raw.slice(0, qi);
  }
  return { name: raw || 'scene', query: query };
}

function go(name) { location.hash = '#/' + name; }

function setActiveView(name) {
  Object.keys(VIEWS).forEach(function (key) {
    show(el(VIEWS[key]), key === name);
  });
  document.querySelectorAll('[data-nav]').forEach(function (node) {
    const hit = node.getAttribute('data-nav') === name ||
      (name === 'interview' && node.getAttribute('data-nav') === 'interview');
    if (hit) node.setAttribute('aria-current', 'page');
    else node.removeAttribute('aria-current');
  });
  window.scrollTo({ top: 0, behavior: 'auto' });
}

/* 每段用不同的进场形状，避免「全页同一个 fade-up」。
   每条 step 写明三件事：形状（kind）、时长档（dur）、同一组里的错开节奏（stagger）。
   时长档与错开节奏都取自 motion-web references/motion-tokens.md。 */
const CHOREO_PLAN = {
  /* 冷开场：标题块走 cinematic 档，落位后 CTA 才上来。 */
  scene: [
    { sel: '.hero .scene-top', kind: 'land', dur: 'cinematic' },
    { sel: '.hero .cta-row', kind: 'rise', dur: 'slow', base: 180 },
    { sel: '#scene-gaps > .gap', kind: 'rise', stagger: MOTION.STAGGER['tight-grid'] }
  ],
  interview: [{ sel: '.role-grid > .role', kind: 'rise', stagger: MOTION.STAGGER['standard-list'] }],
  card: [{ sel: '.fact-card', kind: 'jelly' }],
  changes: [{ sel: '.changes > .change', kind: 'rise', stagger: MOTION.STAGGER['standard-list'] }],
  conclusions: [
    { sel: '.concl-head', kind: 'rise', dur: 'slow' },
    { sel: '#concl-list > .concl', kind: 'jelly', stagger: MOTION.STAGGER['standard-list'] }
  ],
  answer: [{ sel: '.draft', kind: 'land', dur: 'slow' }],
  universe: [{ sel: '.cosmos', kind: 'land', dur: 'slow' }],
  new: [{ sel: '.form', kind: 'rise' }]
};

function choreograph(name) {
  const host = el(VIEWS[name]);
  if (!host || MOTION.reduced) return;
  (CHOREO_PLAN[name] || []).forEach(function (step) {
    const nodes = Array.prototype.slice.call(host.querySelectorAll(step.sel));
    if (!nodes.length) return;
    nodes.forEach(function (node) {
      node.classList.remove('rise', 'land', 'jelly', 'rise-done', 'rise--slow', 'rise--cold');
      MOTION.willChange(node, true);
    });
    void nodes[0].offsetWidth;
    MOTION.reveal(nodes, {
      kind: step.kind,
      dur: step.dur,
      base: step.base || 0,
      stagger: step.stagger == null ? 0 : step.stagger
    });
  });
}

async function route() {
  const r = parseHash();
  const name = VIEWS[r.name] ? r.name : 'scene';
  setActiveView(name);
  try {
    if (name === 'scene') await renderScene();
    else if (name === 'interview') await renderInterview(r.query);
    else if (name === 'card') await renderCardView();
    else if (name === 'changes') renderChangesView();
    else if (name === 'conclusions') await renderConclusions();
    else if (name === 'answer') await renderAnswer();
    else if (name === 'universe') await renderUniverse();
    else if (name === 'new') renderNewView();
    choreograph(name);
  } catch (err) {
    const host = el(VIEWS[name]);
    const box = host && host.querySelector('.section');
    if (box) {
      const div = document.createElement('div');
      div.className = 'error';
      div.textContent = '这一段暂时没能加载：' + (err && err.message ? err.message : '未知原因');
      box.appendChild(div);
    }
  }
}

/* ---------- 1. 活问题现场 ---------- */
async function loadSummary() {
  if (!state.summary) state.summary = await api('/summary');
  return state.summary;
}
async function loadGraph() {
  state.graph = await api('/graph');
  return state.graph;
}

const SUBJECT_SHORT = '在校生找第一段 AI 产品实习';

async function renderScene() {
  const s = await loadSummary();
  const q = s.question;

  document.title = q.title + ' · 活问题';
  setHTML(el('scene-title'), esc(q.title));
  setHTML(el('scene-sub'), esc(q.subtitle || ''));
  const bd = el('scene-boundary');
  if (bd) { bd.querySelector('p').textContent = q.boundary; show(bd, true); }
  setHTML(el('scene-seeking'), esc(q.seeking));
  setHTML(el('scene-known'), esc(q.known));
  setHTML(el('scene-missing'), esc(q.missing));
  setHTML(el('match-identity'), esc(q.demoIdentity));
  setHTML(el('match-reason'), esc(q.matchReason));
  setHTML(el('match-confirm'), esc(q.matchConfirm));
  setHTML(el('match-cost'), esc(q.matchCost));

  setHTML(el('scene-gaps'), s.gaps.map(function (g) {
    return '<div class="gap"><b>' + esc(g.title) + '</b><p>' + esc(g.detail) + '</p>' +
      '<div class="tags">' + (g.subtopics || []).map(function (k) { return tag(subtopicName(k)); }).join('') + '</div></div>';
  }).join(''));

  const g = await loadGraph();
  renderSceneStats(s, g);
  renderLegend(s, g);
  renderCounts(g);
  buildPickList(g);
  selectPoint(firstSelectableId(g));
  renderMapTable(g);
  if (state.map) state.map.setGraph(g); else state.map = createMap(el('map-canvas'), el('map-ylabels'), el('map-tip'), g);
  renderFootNote(s);
}

function renderSceneStats(s, g) {
  const stats = (g.coverage && g.coverage.stats) || [];
  const thin = stats.filter(function (x) { return x.evidenceState === 'empty'; }).length;
  const single = stats.filter(function (x) { return x.evidenceState === 'single-case'; }).length;
  const pub = stats.filter(function (x) { return x.evidenceState === 'public-only'; }).length;
  const cards = [
    { n: String((g.counts && g.counts.real) || 0), l: '公开来源', w: false },
    { n: String((g.counts && g.counts.contribution) || 0), l: '当事人经历', w: false },
    { n: String(thin), l: '完全读不到', w: thin > 0 },
    { n: String(pub), l: '只有公开讨论', w: false },
    { n: String(single), l: '只有一份经历', w: single > 0 }
  ];
  setHTML(el('scene-stats'), cards.map(function (c) {
    return '<div class="stat' + (c.w ? ' warn' : '') + '"><b>' + esc(c.n) + '</b><span>' + esc(c.l) + '</span></div>';
  }).join(''));
}

function renderLegend(s, g) {
  const legend = (s.legend || []).filter(function (x) {
    return ['zhihu', 'sample', 'contribution', 'gap', 'contrast'].indexOf(x.key) >= 0;
  });
  setHTML(el('map-legend'), legend.map(function (x) {
    const cls = (x.shape === 'dashed' || x.shape === 'line') ? ' class="glow"' : '';
    return '<i' + cls + ' style="color:' + esc(x.color) + '">' + esc(x.label) + '</i>';
  }).join(''));
}

function renderCounts(g) {
  const c = g.counts || {};
  const parts = [
    '<b>当前这张图上有</b>',
    '来源星点 ' + (c.points || 0) + ' 个：公开来源 ' + (c.real || 0) + '、体验样本 ' + (c.sample || 0) + '、当事人经历 ' + (c.contribution || 0),
    '密度微光 ' + (c.glow || 0) + ' 处，不可点击，也不计入统计',
    '对照连线 ' + (c.links || 0) + ' 条' + ((c.links || 0) === 0 ? '（还没有条件相近但结果相反的经历）' : '')
  ];
  /* 公开来源为 0 时，必须说清这是检索结果，不是页面故障。
     这句话本身就是这个产品要表达的缺口，不能省。 */
  if ((c.real || 0) === 0) {
    const corpus = (g.sources && Array.isArray(g.sources.excluded)) ? g.sources.excluded.length : null;
    parts.push('<span class="hud-note">已按「' + esc(SUBJECT_SHORT) + '」逐条比对当前可检索到的公开内容' +
      (corpus != null ? '（共 ' + corpus + ' 条，全部不指向在校生找第一段实习，已排除）' : '') +
      '，没有一条写清一个具体的人在这一步的完整经过。这处空白是本次调查要填的部分。</span>');
  }
  setHTML(el('map-counts'), parts.join('<br>'));
}

function firstSelectableId(g) {
  const order = ['contribution', 'sample', 'source'];
  for (let i = 0; i < order.length; i++) {
    const hit = (g.points || []).filter(function (p) { return p.layer === order[i]; })[0];
    if (hit) return hit.id;
  }
  return null;
}

function groupPoints(g) {
  const groups = [
    { key: 'contribution', label: '当事人经历', list: [] },
    { key: 'sample', label: '体验样本', list: [] },
    { key: 'source', label: '公开来源', list: [] }
  ];
  (g.points || []).forEach(function (p) {
    const hit = groups.filter(function (x) { return x.key === p.layer; })[0];
    if (hit) hit.list.push(p);
  });
  groups.forEach(function (x) {
    x.list.sort(function (a, b) { return (b.periodIndex || 0) - (a.periodIndex || 0); });
  });
  return groups.filter(function (x) { return x.list.length; });
}

function buildPickList(g) {
  const groups = groupPoints(g);
  const html = groups.map(function (grp) {
    return '<div class="pick-group">' + esc(grp.label) + ' · ' + grp.list.length + '</div>' +
      grp.list.map(function (p) {
        return '<button class="pick" type="button" data-point="' + esc(p.id) + '">' +
          '<span class="row"><span class="dot" style="color:' + colorFor(p.origin) + '"></span>' +
          '<span class="t">' + esc(p.title) + '</span>' +
          '<span class="when">' + esc(p.timeLabel || p.periodKey) + '</span></span></button>';
      }).join('');
  }).join('');
  setHTML(el('pick-list'), html || '<div class="pick-detail"><p class="empty">当前检索范围内还没有可以点开的内容。</p></div>');
  el('pick-list').querySelectorAll('[data-point]').forEach(function (node) {
    node.addEventListener('click', function () { selectPoint(node.getAttribute('data-point')); });
  });
}

function selectPoint(pointId) {
  const g = state.graph;
  if (!g) return;
  const p = (g.points || []).filter(function (x) { return x.id === pointId; })[0];
  el('pick-list').querySelectorAll('[data-point]').forEach(function (node) {
    node.setAttribute('aria-selected', node.getAttribute('data-point') === pointId ? 'true' : 'false');
  });
  if (!p) {
    setHTML(el('pick-detail'), '<h3>还没有可以核对的内容</h3><p class="empty">当前检索范围内这一格是空的。空着的格子本身就是结论的一部分。</p>');
    return;
  }
  const cell = (g.cells || []).filter(function (c) { return c.subtopic === p.subtopic && c.periodKey === p.periodKey; })[0];
  const others = cell ? (cell.pointIds || []).filter(function (id) { return id !== p.id; }) : [];
  const linked = (g.links || []).filter(function (l) { return l.from === p.id || l.to === p.id || l.a === p.id || l.b === p.id; });
  let html = '';
  html += '<h3>' + esc(p.title) + '</h3>';
  html += '<div class="meta">' + esc(p.originLabel || '') + ' · ' + esc(subtopicName(p.subtopic)) + ' · ' + esc(p.timeLabel || p.periodKey) + '</div>';
  if (p.summary) html += '<p>' + esc(p.summary) + '</p>';
  if (p.timeNote) html += '<p class="empty">' + esc(p.timeNote) + '</p>';
  if (others.length) html += '<p class="empty">同一格还有 ' + others.length + ' 条内容，可以在左边的列表里逐条核对。</p>';
  if (linked.length) html += '<p class="empty">它与 ' + linked.length + ' 条内容构成「条件相近但结果相反」的对照。</p>';
  html += '<div class="links">';
  if (p.url) html += '<a class="linkish" href="' + esc(p.url) + '" target="_blank" rel="noopener noreferrer">打开原始内容</a>';
  html += '<a class="linkish" href="#/interview">我也经历过这件事</a>';
  html += '</div>';
  setHTML(el('pick-detail'), html);
  if (state.map) state.map.focus(p.id);
}

function renderMapTable(g) {
  const host = el('map-table');
  if (!host) return;
  const wrap = document.createElement('div');
  wrap.className = 'map-table-wrap';
  wrap.style.display = 'none';
  wrap.style.padding = '14px';
  wrap.style.background = '#fffef8';
  wrap.style.border = '1px solid #141a17';
  wrap.style.borderTop = '0';
  wrap.style.overflowX = 'auto';

  const periods = g.periods || [];
  const show = periods.filter(function (p, i) { return p.region === 'main' || i % 4 === 0; });
  let html = '<table class="fallback-grid"><thead><tr><th class="rowh">子命题</th>';
  show.forEach(function (p) { html += '<th>' + esc(p.key) + '</th>'; });
  html += '</tr></thead><tbody>';
  SUBTOPIC_ORDER.forEach(function (key) {
    html += '<tr><th class="rowh">' + esc(subtopicName(key)) + '</th>';
    show.forEach(function (p) {
      const cell = (g.cells || []).filter(function (c) { return c.subtopic === key && c.periodKey === p.key; })[0];
      const n = cell ? cell.count : 0;
      if (!n) { html += '<td style="color:#c2c7bb">·</td>'; return; }
      const first = (cell.pointIds || [])[0];
      html += '<td class="has" data-point="' + esc(first) + '">' + n + '</td>';
    });
    html += '</tr>';
  });
  html += '</tbody></table>';
  html += '<p class="mono-note" style="margin:10px 0 0">表格只列出更早来源的每一年和当前调查区间的每个季度。空白处表示这一格没有可核对的内容。</p>';
  wrap.innerHTML = html;
  wrap.querySelectorAll('[data-point]').forEach(function (node) {
    node.addEventListener('click', function () { selectPoint(node.getAttribute('data-point')); });
  });
  const frame = el('scene-map');
  frame.appendChild(wrap);
  host.addEventListener('click', function () {
    const on = wrap.style.display === 'none';
    wrap.style.display = on ? 'block' : 'none';
    host.setAttribute('aria-pressed', on ? 'true' : 'false');
    if (on && state.map) state.map.setTableMode(true); else if (state.map) state.map.setTableMode(false);
  });
}

function renderFootNote(s) {
  const llm = s.llm || {};
  setHTML(el('foot-note'), llm.configured
    ? '追问与整理由已配置的语言模型生成，只使用你提供的信息。'
    : '未配置语言模型：追问与整理由本地规则生成，同样只使用你提供的信息。');
}

/* ---------- 三维地图：时间 × 子命题 × 内容数量 ---------- */
/* 只用 three.js 核心能力：Points + BufferGeometry + ShaderMaterial。
   粒子是柔光点，不是球体；三根轴共用同一个原点，都是直线。 */

function createMap(canvas, ylabelsHost, tipHost, g) {
  const stage = canvas.parentNode;
  const renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: true, alpha: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setClearColor(0x000000, 0);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 8000);
  const group = new THREE.Group();
  scene.add(group);

  const raycaster = new THREE.Raycaster();
  raycaster.params.Points.threshold = 0.85;
  const pointer = new THREE.Vector2(-10, -10);

  const HOME = { theta: 0.66, phi: 1.03 };
  const view = { theta: HOME.theta, phi: HOME.phi, radius: 120, target: new THREE.Vector3(0, 0, 0) };

  let autoRotate = false;
  let tableMode = false;
  let selectedId = null;
  let hoverId = null;
  let dragging = false;
  let moved = 0;
  let lastX = 0, lastY = 0;
  let width = 1, height = 1;
  let layout = null;
  let starField = null;
  let glowField = null;
  let linkGroup = null;
  let pickables = [];
  const labels = [];
  /* 每颗星自己的弹簧状态：高度（新贡献长上来）与脉冲（被指到时放大）。 */
  const seenPointIds = {};
  const wheelGuard = MOTION.wheelGuard();
  let yLabelNodes = [];
  let timeLabelNodes = [];
  let hitIndex = {};

  function layoutFor(graph) {
    const periods = (graph && graph.periods) || [];
    const nP = Math.max(periods.length, 2);
    const nS = SUBTOPIC_ORDER.length;
    const zmax = (graph && graph.axis && graph.axis.z && graph.axis.z.max) || 1;
    return {
      nP: nP, nS: nS,
      xMax: 34, yMax: 11, zMax: 24,
      maxCount: Math.max(zmax, 1),
      halfX: 17, halfZ: 12
    };
  }

  function xOf(periodIndex) {
    const t = layout.nP > 1 ? periodIndex / (layout.nP - 1) : 0;
    return t * layout.xMax - layout.halfX;
  }
  function zOf(subtopic) {
    const i = SUBTOPIC_ORDER.indexOf(subtopic);
    const k = i < 0 ? 0 : i;
    return (k / (layout.nS - 1)) * layout.zMax - layout.halfZ;
  }
  function yOf(count) {
    return (Math.max(count, 0) / layout.maxCount) * layout.yMax;
  }
  function originCorner() { return new THREE.Vector3(-layout.halfX, 0, -layout.halfZ); }

  function disposeGroup(target) {
    while (target.children.length) {
      const child = target.children.pop();
      if (child.geometry) child.geometry.dispose();
      if (child.material) {
        const mats = Array.isArray(child.material) ? child.material : [child.material];
        mats.forEach(function (m) { if (m.dispose) m.dispose(); });
      }
    }
  }

  function lineBetween(a, b, color, opacity, dashed) {
    const geo = new THREE.BufferGeometry().setFromPoints([a, b]);
    const mat = new THREE.LineBasicMaterial({ color: color, transparent: true, opacity: opacity });
    return new THREE.Line(geo, mat);
  }

  function buildAxes(graph) {
    const axisGroup = new THREE.Group();
    const o = originCorner();
    const axisColor = 0x5c6a63;
    const mainColor = 0xd9f45f;

    /* X 轴：时间 */
    const xEnd = new THREE.Vector3(layout.halfX, o.y, o.z);
    axisGroup.add(lineBetween(o, xEnd, axisColor, 0.5));
    const mx0 = xOf(graph.axis.x && graph.axis.x.mainFrom != null ? 0 : 0);
    /* 当前调查区间用另一段颜色叠在 X 轴上 */
    const mainStart = (graph.periods || []).findIndex(function (p) { return p.region === 'main'; });
    if (mainStart > 0) {
      const a = new THREE.Vector3(xOf(mainStart), o.y, o.z);
      axisGroup.add(lineBetween(a, xEnd, mainColor, 0.55));
    }

    /* Y 轴：内容数量 */
    const yEnd = new THREE.Vector3(o.x, layout.yMax, o.z);
    axisGroup.add(lineBetween(o, yEnd, axisColor, 0.5));
    for (let v = 1; v <= 4; v++) {
      const yy = (v / 4) * layout.yMax;
      const tick = Math.round((v / 4) * layout.maxCount);
      axisGroup.add(lineBetween(new THREE.Vector3(o.x, yy, o.z), new THREE.Vector3(o.x + 0.7, yy, o.z), axisColor, 0.32));
      labels.push({ kind: 'y-tick', text: String(tick), at: new THREE.Vector3(o.x, yy, o.z), offset: [-10, 0] });
    }
    labels.push({ kind: 'axis', text: '内容数量 · 条', at: new THREE.Vector3(o.x, layout.yMax + 0.7, o.z), offset: [-6, -8] });

    /* Z 轴：六条子命题 */
    const zEnd = new THREE.Vector3(o.x, o.y, layout.halfZ);
    axisGroup.add(lineBetween(o, zEnd, axisColor, 0.5));
    SUBTOPIC_ORDER.forEach(function (key, i) {
      const zz = zOf(key);
      axisGroup.add(lineBetween(new THREE.Vector3(o.x, o.y, zz), new THREE.Vector3(o.x + 0.7, o.y, zz), axisColor, 0.32));
      labels.push({ kind: 'y-label', subtopic: key, text: subtopicName(key), at: new THREE.Vector3(o.x, o.y, zz), offset: [0, 0] });
    });

    /* 时间刻度 */
    const periods = graph.periods || [];
    periods.forEach(function (p, i) {
      const main = p.region === 'main';
      if (!main && i % 4 !== 0) return;
      const xx = xOf(i);
      axisGroup.add(lineBetween(new THREE.Vector3(xx, o.y, o.z), new THREE.Vector3(xx, o.y + 0.5, o.z), axisColor, 0.3));
      labels.push({ kind: 'x-tick', text: main ? p.key : String(p.year), main: main, at: new THREE.Vector3(xx, o.y, o.z), offset: [0, 14] });
    });
    labels.push({ kind: 'axis', text: '时间', at: new THREE.Vector3(layout.halfX + 0.6, o.y, o.z), offset: [8, 0] });

    /* 基准平面：帮助看出高度 */
    const plane = new THREE.Mesh(
      new THREE.PlaneGeometry(layout.xMax, layout.zMax),
      new THREE.MeshBasicMaterial({ color: 0x1b2a24, transparent: true, opacity: 0.22, side: THREE.DoubleSide, depthWrite: false })
    );
    plane.rotation.x = -Math.PI / 2;
    plane.position.set(0, 0, 0);
    axisGroup.add(plane);

    group.add(axisGroup);
  }

  function starMaterial() {
    return new THREE.ShaderMaterial({
      uniforms: { uSize: { value: 34 }, uBreath: { value: 1 } },
      vertexShader: [
        'attribute vec3 aColor;',
        'attribute float aSize;',
        'attribute float aPulse;',
        'varying vec3 vColor;',
        'varying float vPulse;',
        'void main() {',
        '  vColor = aColor;',
        '  vPulse = aPulse;',
        '  vec4 mv = modelViewMatrix * vec4(position, 1.0);',
        /* 悬停 / 选中的星点会被 aPulse 轻微放大，停下后弹簧回正 */
        '  gl_PointSize = aSize * (1.0 + aPulse * 0.85) * (300.0 / max(-mv.z, 0.001));',
        '  gl_Position = projectionMatrix * mv;',
        '}'
      ].join(String.fromCharCode(10)),
      fragmentShader: [
        'uniform float uBreath;',
        'varying vec3 vColor;',
        'varying float vPulse;',
        'void main() {',
        '  vec2 d = gl_PointCoord - vec2(0.5);',
        '  float r = length(d);',
        '  if (r > 0.5) discard;',
        '  float core = smoothstep(0.5, 0.06, r);',
        '  float halo = pow(smoothstep(0.5, 0.0, r), 2.4);',
        '  float a = core * 0.72 + halo * 0.5;',
        '  a *= uBreath;',
        /* 被指向的星点额外亮一点，和尺寸变化一起读作「这一颗被选中了」 */
        '  a *= (1.0 + vPulse * 0.9);',
        '  gl_FragColor = vec4(vColor * (0.85 + core * 0.55), a);',
        '}'
      ].join(String.fromCharCode(10)),
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending
    });
  }

  function buildStars(graph) {
    const pts = (graph.points || []).filter(function (p) { return p.layer !== 'glow'; });
    const groupPoints = [];
    pts.forEach(function (p) {
      const count = Math.max(1, (graph.cells || []).filter(function (c) {
        return c.subtopic === p.subtopic && c.periodKey === p.periodKey;
      }).reduce(function (acc, c) { return Math.max(acc, c.count || 1); }, 1));
      groupPoints.push({
        id: p.id, point: p,
        pos: new THREE.Vector3(xOf(p.periodIndex || 0), yOf(count), zOf(p.subtopic)),
        count: count
      });
    });
    pickables = groupPoints;
    hitIndex = {};
    groupPoints.forEach(function (item) { hitIndex[item.id] = item; });
    if (!groupPoints.length) return null;

    const geo = new THREE.BufferGeometry();
    const pos = new Float32Array(groupPoints.length * 3);
    const col = new Float32Array(groupPoints.length * 3);
    const siz = new Float32Array(groupPoints.length);
    const pulse = new Float32Array(groupPoints.length);
    /* 先取一次快照：只有这一轮真正新出现的星点才从 0 长上来。
       首屏绘制不算「新进入」，否则整张图会在第一次打开时集体长高。 */
    const isFirstPaint = Object.keys(seenPointIds).length === 0;
    groupPoints.forEach(function (item, i) {
      const isNew = !isFirstPaint && seenPointIds[item.id] === undefined;
      seenPointIds[item.id] = true;
      item.yTarget = item.pos.y;
      item.ySpring = { x: isNew ? 0 : item.pos.y, vel: 0 };
      item.pulseSpring = { x: isNew ? 0.75 : 0, vel: 0 };
      pos[i * 3] = item.pos.x; pos[i * 3 + 1] = item.ySpring.x; pos[i * 3 + 2] = item.pos.z;
      const c = new THREE.Color(colorFor(item.point.origin));
      col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
      siz[i] = item.point.layer === 'contribution' ? 1.32 : (item.point.layer === 'sample' ? 1.06 : 0.92);
      pulse[i] = item.pulseSpring.x;
    });
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
    geo.setAttribute('aSize', new THREE.BufferAttribute(siz, 1));
    geo.setAttribute('aPulse', new THREE.BufferAttribute(pulse, 1));
    const mat = starMaterial();
    mat.uniforms.uSize.value = 34;
    const field = new THREE.Points(geo, mat);
    field.frustumCulled = false;
    return field;
  }

  function buildGlow(graph) {
    const glows = (graph.glow || []).filter(function (x) { return x.interactive === false; });
    if (!glows.length) return null;
    const geo = new THREE.BufferGeometry();
    const pos = new Float32Array(glows.length * 3);
    const col = new Float32Array(glows.length * 3);
    const siz = new Float32Array(glows.length);
    glows.forEach(function (x, i) {
      const cell = (graph.cells || []).filter(function (c) { return c.key === x.key; })[0] || {};
      pos[i * 3] = xOf(x.periodIndex != null ? x.periodIndex : (cell.periodIndex || 0));
      pos[i * 3 + 1] = yOf(cell.count || 1) * 0.62;
      pos[i * 3 + 2] = zOf(x.subtopic);
      const c = new THREE.Color('#7ee0c0');
      col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
      siz[i] = 2.5 + Math.min(x.density || 1, 6) * 0.5;
    });
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
    geo.setAttribute('aSize', new THREE.BufferAttribute(siz, 1));
    const mat = starMaterial();
    mat.uniforms.uSize.value = 10;
    mat.opacity = 0.34;
    const field = new THREE.Points(geo, mat);
    field.frustumCulled = false;
    return field;
  }

  function buildLinks(graph) {
    const links = graph.links || [];
    if (!links.length) return null;
    const holder = new THREE.Group();
    links.slice(0, 3).forEach(function (l) {
      const a = hitIndex[l.from || l.a];
      const b = hitIndex[l.to || l.b];
      if (!a || !b) return;
      holder.add(lineBetween(a.pos, b.pos, 0x9fb8a6, 0.3));
    });
    return holder.children.length ? holder : null;
  }

  /* ---- 视角 ---- */
  let fitRadius = 150;
  const fitTarget = new THREE.Vector3(0, 4, 0);
  const goal = { theta: HOME.theta, phi: HOME.phi, radius: fitRadius, target: fitTarget.clone() };

  function fit() {
    const box = new THREE.Box3();
    group.updateMatrixWorld(true);
    box.setFromObject(group);
    if (box.isEmpty()) return;
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    fitRadius = Math.max(78, sphere.radius * 2.25);
    fitTarget.copy(sphere.center);
    goal.radius = fitRadius;
    goal.target.copy(fitTarget);
  }

  function project(v3) {
    const p = v3.clone().project(camera);
    return {
      x: (p.x * 0.5 + 0.5) * width,
      y: (-p.y * 0.5 + 0.5) * height,
      visible: p.z > -1 && p.z < 1
    };
  }

  function renderLabels() {
    yLabelNodes.forEach(function (node) {
      const item = node.__item;
      const pr = project(item.at);
      if (!pr.visible) { node.style.display = 'none'; return; }
      node.style.display = 'block';
      if (item.kind === 'y-label') {
        node.style.transform = 'translate(calc(-100% - 9px), -50%)';
        node.style.left = pr.x + 'px';
        node.style.top = pr.y + 'px';
      } else if (item.kind === 'x-tick') {
        node.style.transform = 'translate(-50%, 0)';
        node.style.left = pr.x + 'px';
        node.style.top = (pr.y + 7) + 'px';
        node.style.opacity = item.main ? '0.95' : '0.5';
      } else {
        node.style.transform = 'translate(-50%, -50%)';
        node.style.left = pr.x + 'px';
        node.style.top = (pr.y + (item.offset ? item.offset[1] : 0)) + 'px';
        node.style.opacity = '0.7';
      }
    });
  }

  function buildLabels() {
    if (!ylabelsHost) return;
    ylabelsHost.innerHTML = '';
    yLabelNodes = labels.map(function (item) {
      const node = document.createElement('span');
      node.className = 'ylab' + (item.kind === 'y-label' && item.subtopic ? '' : '') + (item.kind === 'axis' || item.kind === 'y-tick' || item.kind === 'x-tick' ? ' plain' : '');
      if (item.kind === 'y-label') {
        const stat = ((state.graph && state.graph.coverage && state.graph.coverage.stats) || []).filter(function (x) { return x.key === item.subtopic; })[0];
        const mark = stat && stat.evidenceState === 'empty';
        if (mark) node.className = 'ylab gap';
        node.innerHTML = '<em>' + (stat && stat.total ? String(stat.total) : '0') + '</em>' + esc(item.text);
      } else {
        node.textContent = item.text;
      }
      node.__item = item;
      node.style.position = 'absolute';
      ylabelsHost.appendChild(node);
      return node;
    });
    renderLabels();
  }

  function resize() {
    const rect = stage.getBoundingClientRect();
    width = Math.max(1, Math.round(rect.width));
    height = Math.max(1, Math.round(rect.height));
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  }

  /* ---- 数据装载 ---- */
  function setGraph(graph) {
    if (!graph) return;
    disposeGroup(group);
    labels.length = 0;
    layout = layoutFor(graph);
    buildAxes(graph);
    starField = buildStars(graph);
    if (starField) group.add(starField);
    glowField = buildGlow(graph);
    if (glowField) group.add(glowField);
    linkGroup = buildLinks(graph);
    if (linkGroup) group.add(linkGroup);
    fit();
    view.radius = fitRadius;
    view.target.copy(fitTarget);
    buildLabels();
    const empty = el('map-empty');
    if (empty) {
      const any = (graph.points || []).length > 0;
      show(empty, !any);
      empty.textContent = any ? '' : '当前检索范围内还没有可以放进这张图的内容。空图本身也是结论的一部分。';
    }
    resize();
  }

  function focus(id) {
    selectedId = id;
    const item = hitIndex[id];
    if (!item) return;
    goal.target.copy(item.pos);
    goal.radius = Math.max(46, fitRadius * 0.55);
    goal.theta = view.theta + 0.22;
    goal.phi = Math.min(Math.max(view.phi, 0.62), 1.28);
  }

  function setTableMode(on) {
    tableMode = !!on;
    const frame = canvas.closest('.map-frame') || stage;
    frame.style.display = tableMode ? 'none' : '';
  }

  /* ---- 交互 ---- */
  function pickAt(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    pointer.x = ((clientX - rect.left) / Math.max(rect.width, 1)) * 2 - 1;
    pointer.y = -((clientY - rect.top) / Math.max(rect.height, 1)) * 2 + 1;
    raycaster.setFromCamera(pointer, camera);
    const hits = starField ? raycaster.intersectObject(starField, false) : [];
    if (!hits.length) return null;
    const idx = hits[0].index;
    if (idx == null || !pickables[idx]) return null;
    return pickables[idx];
  }

  function tipFor(item) {
    const p = item.point;
    return '<b>' + esc(p.title) + '</b>' + esc(p.summary || '') +
      '<span>' + esc(p.originLabel || '') + ' · ' + esc(subtopicName(p.subtopic)) + ' · ' + esc(p.timeLabel || p.periodKey) + '</span>' +
      (p.timeNote ? '<span>' + esc(p.timeNote) + '</span>' : '') +
      '<span>点一下可以核对这条内容。</span>';
  }

  /* 浮层离场：先播 ease-in-expo 的退场，动画结束再真正隐藏。
     规范出处 motion-web references/motion-tokens.md —— 退出态用 ease-in-expo。 */
  function hideTip() {
    if (!tipHost || tipHost.hidden) return;
    if (MOTION.reduced || tipHost.classList.contains('leaving')) { show(tipHost, false); return; }
    tipHost.classList.add('leaving');
    tipHost.addEventListener('animationend', function onOut(e) {
      if (e.target !== tipHost) return;
      tipHost.removeEventListener('animationend', onOut);
      tipHost.classList.remove('leaving');
      show(tipHost, false);
    });
  }

  function placeTip(clientX, clientY, html) {
    if (!tipHost) return;
    const rect = stage.getBoundingClientRect();
    tipHost.classList.remove('leaving');
    tipHost.innerHTML = html;
    show(tipHost, true);
    const w = tipHost.offsetWidth || 220;
    const h = tipHost.offsetHeight || 80;
    let left = clientX - rect.left + 16;
    let top = clientY - rect.top + 14;
    if (left + w > rect.width - 8) left = Math.max(8, clientX - rect.left - w - 14);
    if (top + h > rect.height - 8) top = Math.max(8, clientY - rect.top - h - 12);
    tipHost.style.left = left + 'px';
    tipHost.style.top = top + 'px';
  }

  canvas.addEventListener('pointerdown', function (e) {
    dragging = true; moved = 0;
    lastX = e.clientX; lastY = e.clientY;
    canvas.classList.add('grabbing');
    if (canvas.setPointerCapture) { try { canvas.setPointerCapture(e.pointerId); } catch (err) {} }
    hideTip();
  });
  canvas.addEventListener('pointermove', function (e) {
    if (dragging) {
      const dx = e.clientX - lastX, dy = e.clientY - lastY;
      lastX = e.clientX; lastY = e.clientY;
      moved += Math.abs(dx) + Math.abs(dy);
      goal.theta -= dx * 0.0075;
      goal.phi = Math.min(Math.max(goal.phi - dy * 0.006, 0.22), 1.52);
      view.theta = goal.theta;
      view.phi = goal.phi;
      hideTip();
      return;
    }
    const hit = pickAt(e.clientX, e.clientY);
    hoverId = hit ? hit.id : null;
    canvas.style.cursor = hit ? 'pointer' : 'grab';
    if (hit) placeTip(e.clientX, e.clientY, tipFor(hit));
    else hideTip();
  });
  function endDrag(e) {
    if (!dragging) return;
    dragging = false;
    canvas.classList.remove('grabbing');
    if (moved < 7) {
      const hit = pickAt(e.clientX, e.clientY);
      if (hit) selectPoint(hit.id);
    }
  }
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', function () { dragging = false; canvas.classList.remove('grabbing'); });
  canvas.addEventListener('pointerleave', function () {
    if (!dragging) hideTip();
  });
  canvas.addEventListener('wheel', function (e) {
    e.preventDefault();
    /* 触控板抬手后还会继续发几十个事件；累积到 90px 才走一步，然后锁 600ms。 */
    const dir = wheelGuard.step(e.deltaY, performance.now());
    if (!dir) return;
    const next = goal.radius * (1 + (dir > 0 ? 0.12 : -0.12));
    goal.radius = Math.min(Math.max(next, 30), 420);
  }, { passive: false });

  const rotBtn = el('map-rot');
  if (rotBtn) rotBtn.addEventListener('click', function () {
    autoRotate = !autoRotate;
    rotBtn.setAttribute('aria-pressed', autoRotate ? 'true' : 'false');
  });
  const resetBtn = el('map-reset');
  if (resetBtn) resetBtn.addEventListener('click', function () {
    autoRotate = false;
    if (rotBtn) rotBtn.setAttribute('aria-pressed', 'false');
    goal.theta = HOME.theta; goal.phi = HOME.phi;
    goal.radius = fitRadius; goal.target.copy(fitTarget);
    selectedId = null;
    wheelGuard.reset();
    hideTip();
  });

  if (window.ResizeObserver) {
    const ro = new ResizeObserver(function () { resize(); });
    ro.observe(stage);
  } else {
    window.addEventListener('resize', resize);
  }
  resize();

  const clock = new THREE.Clock();
  /* 视角的角速度，用于速度耦合：拖动越快，画面越"甩"得开。 */
  const spin = { thetaVel: 0, phiVel: 0, jTheta: 0, jThetaVel: 0, jPhi: 0, jPhiVel: 0 };

  function frame() {
    const dt = Math.min(clock.getDelta(), 0.05);
    const now = clock.elapsedTime;
    if (autoRotate && !dragging) goal.theta += dt * 0.16;

    /* 跟随镜头用帧率无关的指数跟随：到位就停，不来回晃。 */
    const prevTheta = view.theta, prevPhi = view.phi;
    const kTheta = dragging ? 9.5 : 5.5;
    view.theta = MOTION.follow(view.theta, goal.theta, kTheta, dt);
    view.phi = MOTION.follow(view.phi, goal.phi, 6.2, dt);
    view.radius = MOTION.follow(view.radius, goal.radius, 4.2, dt);
    view.target.lerp(goal.target, 1 - Math.exp(-4.0 * dt));

    /* 速度耦合：镜头转得快，画面轻微倾斜，松手后回正。 */
    spin.thetaVel = (view.theta - prevTheta) / Math.max(dt, 0.001);
    spin.phiVel = (view.phi - prevPhi) / Math.max(dt, 0.001);
    spin.jThetaVel += (MOTION.lean(spin.thetaVel, 0.10, 0.5) - spin.jTheta) * 55 * dt;
    spin.jThetaVel *= 0.90;
    spin.jTheta += spin.jThetaVel * dt;
    spin.jPhiVel += (MOTION.lean(spin.phiVel, 0.10, 0.4) - spin.jPhi) * 55 * dt;
    spin.jPhiVel *= 0.90;
    spin.jPhi += spin.jPhiVel * dt;

    const base = new THREE.Vector3().setFromSphericalCoords(view.radius, view.phi, view.theta).add(view.target);
    const right = new THREE.Vector3().crossVectors(base.clone().sub(view.target), new THREE.Vector3(0, 1, 0)).normalize();
    if (right.lengthSq() > 0.001) base.addScaledVector(right, spin.jTheta * 6);
    base.y += spin.jPhi * 5;
    camera.position.copy(base);
    camera.lookAt(view.target);

    /* 星点：高度用欠阻尼弹簧长上来（新贡献只影响自己那一格），被指到的星点脉冲放大。 */
    if (starField && starField.geometry && starField.geometry.attributes.position) {
      const arr = starField.geometry.attributes.position.array;
      const pulseArr = starField.geometry.attributes.aPulse.array;
      const breath = 0.9 + MOTION.breath(now, 0.55, 0) * 0.1;
      starField.material.uniforms.uBreath.value = MOTION.reduced ? 1 : breath;
      let dirty = false;
      pickables.forEach(function (item, i) {
        const y = MOTION.spring(item.ySpring, item.yTarget, dt, 62, 0.88);
        const target = (item.id === hoverId) ? 0.85 : (item.id === selectedId ? 1.0 : 0);
        const p = MOTION.spring(item.pulseSpring, target, dt, 150, 0.82);
        if (Math.abs(arr[i * 3 + 1] - y) > 0.0004) { arr[i * 3 + 1] = y; dirty = true; }
        if (Math.abs(pulseArr[i] - p) > 0.0008) { pulseArr[i] = p; dirty = true; }
      });
      if (dirty) {
        starField.geometry.attributes.position.needsUpdate = true;
        starField.geometry.attributes.aPulse.needsUpdate = true;
      }
    }

    if (!tableMode) {
      renderer.render(scene, camera);
      renderLabels();
    }
    requestAnimationFrame(frame);
  }
  setGraph(g);
  requestAnimationFrame(frame);

  return { setGraph: setGraph, focus: focus, setTableMode: setTableMode };
}

/* ---------- 2. 参与采访 ---------- */
function stepsHTML(active) {
  const list = ['确认你和这件事的关系', '回答只有你知道的部分', '一个追问', '确认这份经历'];
  return list.map(function (t, i) {
    const n = i + 1;
    const cls = n === active ? 'on' : '';
    return '<b class="' + cls + '">' + n + '. ' + esc(t) + '</b>';
  }).join('<i>—</i>');
}

async function renderInterview(query) {
  const s = await loadSummary();
  const demo = String((query && query.demo) || '') === '1';
  const grid = el('role-grid');
  if (!grid) return;

  setHTML(el('interview-steps'), stepsHTML(1));
  show(el('interview-stage'), false);

  grid.innerHTML = (s.roles || []).map(function (r) {
    return '<button class="role" type="button" data-role="' + esc(r.key) + '" aria-pressed="' +
      (state.roleKey === r.key ? 'true' : 'false') + '">' +
      '<span class="n">' + r.questionCount + ' 个问题</span>' +
      '<h3>' + esc(r.name) + '</h3>' +
      '<p>' + esc(r.short) + '</p>' +
      '<span class="entry">入口：' + esc(r.entry) + '（' + esc((r.entryNames || []).join(' / ')) + '）</span>' +
      '<span class="entry">补上：' + esc(r.effect) + '</span>' +
      '</button>';
  }).join('');

  grid.querySelectorAll('[data-role]').forEach(function (node) {
    node.addEventListener('click', function () { chooseRole(node.getAttribute('data-role'), demo); });
  });

  if (state.roleKey && state.draftId) {
    show(el('interview-stage'), true);
    renderInterviewForm();
    return;
  }
  if (demo) await chooseRole(s.question && s.question.demoRole ? s.question.demoRole : 'gained', true);
}

async function chooseRole(key, demo) {
  const s = await loadSummary();
  const role = (s.roles || []).filter(function (r) { return r.key === key; })[0];
  if (!role) return;
  const detail = await api('/roles/' + encodeURIComponent(key));
  state.roleKey = key;
  state.roleDetail = detail;
  state.demo = !!demo;
  state.answers = {};
  state.followUp = null;
  state.card = null;
  state.changes = null;
  state.nextQuestion = null;
  state.draftId = null;
  if (demo && s.demo && s.demo.roleKey === key) {
    state.answers = Object.assign({}, s.demo.answers || {});
  }
  document.querySelectorAll('[data-role]').forEach(function (node) {
    node.setAttribute('aria-pressed', node.getAttribute('data-role') === key ? 'true' : 'false');
  });
  show(el('interview-stage'), true);
  renderInterviewForm();
  const stage = el('interview-stage');
  if (stage && stage.scrollIntoView) stage.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function renderInterviewForm() {
  const role = state.roleDetail;
  if (!role) return;
  setHTML(el('interview-steps'), stepsHTML(2));
  const questions = role.questions || [];
  let html = '<div class="fact-card"><div class="head"><h3>' + esc(role.name) + '</h3>' +
    '<span>' + esc(role.entry) + '</span></div>' +
    '<p class="sub" style="max-width:60ch">' + esc(role.matchReason || '') + '</p>' +
    '<div class="form" style="margin-top:18px">';
  questions.forEach(function (q) {
    const val = state.answers && state.answers[q.id] != null ? String(state.answers[q.id]) : '';
    html += '<div class="q"><label for="ans-' + esc(q.id) + '">' + esc(q.label) +
      (q.required ? '<span class="req">必填</span>' : '') + '</label>' +
      '<span class="hint">' + esc(q.hint) + '</span>' +
      (q.type === 'textarea'
        ? '<textarea class="ta" id="ans-' + esc(q.id) + '" data-q="' + esc(q.id) + '">' + esc(val) + '</textarea>'
        : '<input class="inp" type="text" id="ans-' + esc(q.id) + '" data-q="' + esc(q.id) + '" value="' + esc(val) + '">') +
      '</div>';
  });
  html += '</div>';
  html += '<div class="cta-row" style="margin-top:18px">' +
    '<button class="cta" type="button" id="interview-submit">提交这一段经历</button>' +
    (state.demo ? '<a class="cta alt" href="#/interview">按我的真实情况参与</a>' : '<a class="cta alt" href="#/">回到现场</a>') +
    '</div>';
  html += '<p class="form-msg" id="interview-msg" hidden></p>';
  html += '<p class="mono-note" style="margin-top:14px">' + esc(role.matchCost || '') + '</p>';
  html += '</div>';
  setHTML(el('interview-body'), html);

  el('interview-body').querySelectorAll('[data-q]').forEach(function (node) {
    node.addEventListener('input', function () {
      state.answers[node.getAttribute('data-q')] = node.value;
    });
  });
  const btn = el('interview-submit');
  if (btn) btn.addEventListener('click', submitInterview);
}

function msg(id, text, bad) {
  const node = el(id);
  if (!node) return;
  node.textContent = text || '';
  node.className = 'form-msg' + (bad ? ' bad' : '');
  show(node, !!text);
  if (text) MOTION.announce(text, !!bad);
}

async function submitInterview() {
  const role = state.roleDetail;
  if (!role) return;
  const answers = {};
  el('interview-body').querySelectorAll('[data-q]').forEach(function (node) {
    answers[node.getAttribute('data-q')] = node.value;
  });
  state.answers = answers;
  const missing = (role.questions || []).filter(function (q) {
    return q.required && !String(answers[q.id] || '').trim();
  });
  if (missing.length) {
    msg('interview-msg', '还有必填的一项没有写：' + missing[0].label, true);
    return;
  }
  const btn = el('interview-submit');
  if (btn) { btn.disabled = true; btn.textContent = '正在整理…'; }
  try {
    const created = await api('/interview', { method: 'POST', body: JSON.stringify({ roleKey: state.roleKey, demo: !!state.demo }) });
    state.draftId = created.draftId;
    const res = await api('/interview/' + encodeURIComponent(state.draftId), {
      method: 'POST', body: JSON.stringify({ answers: answers })
    });
    state.followUp = res.followUp;
    state.card = res.card;
    renderFollowUp();
  } catch (err) {
    msg('interview-msg', '这一段暂时没能提交：' + err.message, true);
    if (btn) { btn.disabled = false; btn.textContent = '提交这一段经历'; }
  }
}

function renderFollowUp() {
  setHTML(el('interview-steps'), stepsHTML(3));
  const fu = state.followUp;
  if (!fu) { renderCardView(); return; }
  const host = el('interview-body');
  const box = document.createElement('div');
  box.className = 'followup';
  box.innerHTML = '<span class="kicker">这个问题想再问一句</span>' +
    '<p class="qtext">' + esc(fu.question) + '</p>' +
    '<p class="why">' + esc(fu.reason) + '</p>' +
    '<textarea class="ta" id="followup-answer" aria-label="补充回答"></textarea>' +
    '<div class="cta-row" style="margin-top:14px">' +
    '<button class="cta" type="button" id="followup-submit">提交这句补充</button>' +
    '<button class="cta alt" type="button" id="followup-skip">先不补充，直接看贡献卡</button>' +
    '</div>' +
    '<p class="form-msg" id="followup-msg" hidden></p>';
  host.appendChild(box);
  if (state.demo && state.summary && state.summary.demo && state.summary.demo.followUpAnswer) {
    el('followup-answer').value = state.summary.demo.followUpAnswer;
  }
  if (box.scrollIntoView) box.scrollIntoView({ behavior: 'smooth', block: 'center' });
  MOTION.announce('有一个追问：' + fu.question);
  el('followup-submit').addEventListener('click', function () { submitFollowUp(false); });
  el('followup-skip').addEventListener('click', function () { submitFollowUp(true); });
}

async function submitFollowUp(skip) {
  const node = el('followup-answer');
  const answer = skip ? '' : (node ? node.value : '');
  if (!skip && !String(answer).trim()) { msg('followup-msg', '写一句再提交，或者选择先不补充。', true); return; }
  const btn = el('followup-submit');
  if (btn) { btn.disabled = true; btn.textContent = '正在整理…'; }
  try {
    const res = await api('/followup', { method: 'POST', body: JSON.stringify({ draftId: state.draftId, answer: answer }) });
    state.card = res.card;
    state.contribution = res.contribution || null;
    renderCardView();
    go('card');
  } catch (err) {
    msg('followup-msg', '这一句暂时没能提交：' + err.message, true);
    if (btn) { btn.disabled = false; btn.textContent = '提交这句补充'; }
  }
}

/* ---------- 3. 贡献确认 ---------- */
function renderCardView() {
  const card = state.card;
  const host = el('card-body');
  if (!host) return;
  if (!card) {
    setHTML(host, '<p class="empty">还没有可以确认的经历。先去<a class="linkish" href="#/interview">回答几个问题</a>。</p>');
    return;
  }
  setHTML(el('interview-steps'), stepsHTML(4));
  const facts = card.facts || [];
  let html = '<div class="fact-card">';
  html += '<div class="head"><h3>' + esc(card.roleName) + '</h3><span>' + esc(card.roleShort || '') + ' · ' + facts.length + ' 条事实</span></div>';
  html += '<div class="facts">';
  facts.forEach(function (f) {
    html += '<div class="fact"><span class="k">' + esc(f.label) + '</span><span class="v">' + esc(f.value) + '</span>' +
      (f.origin === 'user' ? '<span class="org">你提供的</span>' : '<span class="org fu">追问补充</span>') + '</div>';
  });
  html += '</div>';
  if ((card.primarySubtopics || []).length) {
    html += '<div class="subtopics"><span class="kicker">主要补上</span>' +
      card.primarySubtopics.map(function (k) { return tag(subtopicName(k), 'primary'); }).join('') + '</div>';
  }
  if ((card.extraSubtopics || []).length) {
    html += '<div class="subtopics"><span class="kicker">顺带提到</span>' +
      card.extraSubtopics.map(function (k) { return tag(subtopicName(k)); }).join('') + '</div>';
  }
  html += '<p class="notice" style="margin-top:18px">' + esc(card.statement || '这是一份个人经历，不代表行业整体情况。确认后，它将进入当前调查，不会自动发布成知乎回答。') + '</p>';
  if (state.demo) {
    html += '<p class="notice" style="margin-top:18px"><b>这是演示身份，不会写进真实调查。</b>下面这些内容只是让你看清一次采访长什么样：它不会进入统计，也不会出现在问题地图里。想真的补上你的经历，请点下面的按钮。</p>';
    html += '<div class="cta-row" style="margin-top:16px">' +
      '<a class="cta" href="#/interview">按我的真实情况参与</a>' +
      '<a class="cta alt" href="#/">回到现场</a>' +
      '</div>';
  } else {
    html += '<label class="chk"><input type="checkbox" id="card-anon"> 匿名进入调查（不显示你的身份信息）</label>';
    html += '<div class="cta-row" style="margin-top:16px">' +
      '<button class="cta" type="button" id="card-confirm">确认，让它进入调查</button>' +
      '<a class="cta alt" href="#/interview">回去改一改</a>' +
      '</div>';
  }
  html += '<p class="form-msg" id="card-msg" hidden></p>';
  html += '</div>';
  setHTML(host, html);
  const cbtn = el('card-confirm');
  if (cbtn) cbtn.addEventListener('click', confirmContribution);
  MOTION.announce('贡献卡已生成，共 ' + facts.length + ' 条事实，确认后进入当前调查。');
}

async function confirmContribution() {
  /* 演示身份只用来展示一次采访长什么样，绝不能写进真实调查。 */
  if (state.demo) {
    msg('card-msg', '这是演示身份，不会写进真实调查。想真的补上经历，请点「按我的真实情况参与」。', true);
    return;
  }
  const anon = el('card-anon') && el('card-anon').checked;
  const btn = el('card-confirm');
  if (btn) { btn.disabled = true; btn.textContent = '正在写入调查…'; }
  try {
    const res = await api('/contribution', {
      method: 'POST',
      body: JSON.stringify({
        draftId: state.draftId,
        anonymous: !!anon,
        answers: state.answers || {},
        followUp: state.followUp ? { question: state.followUp.question, answer: '' } : null
      })
    });
    state.contribution = res.contribution;
    state.changes = res.changes;
    state.nextQuestion = res.nextQuestion;
    state.graph = res.graph || state.graph;
    state.answer = null;
    renderChangesView();
    go('changes');
  } catch (err) {
    msg('card-msg', '这一步暂时没能完成：' + err.message, true);
    if (btn) { btn.disabled = false; btn.textContent = '确认，让它进入调查'; }
  }
}

/* ---------- 4. 问题变化 ---------- */
function renderChangesView() {
  const host = el('changes-list');
  if (!host) return;
  const list = state.changes || [];
  if (!list.length) {
    setHTML(host, '<p class="empty">还没有新的经历进入调查。先去<a class="linkish" href="#/interview">回答几个问题</a>。</p>');
    show(el('next-question'), false);
    return;
  }
  setHTML(host, list.map(function (c) {
    const moved = (c.contributionDelta || 0) > 0;
    return '<div class="change' + (moved ? ' moved' : '') + '">' +
      '<h3 class="name">' + esc(c.name) + '</h3>' +
      '<div class="flow">' +
      '<span class="from">' + esc(c.beforeLabel || c.beforeState) + '</span>' +
      '<span class="delta' + (moved ? '' : ' zero') + '">' + (moved ? '+' + c.contributionDelta : '无变化') + '</span>' +
      '<span class="to">' + esc(c.afterLabel || c.afterState) + '</span>' +
      '</div>' +
      '<p class="reason">' + esc(c.reason) + '</p>' +
      '</div>';
  }).join(''));

  MOTION.announce('你的经历已进入调查，六条子命题的覆盖状态已更新。');
  const nq = state.nextQuestion;
  const box = el('next-question');
  if (nq && box) {
    setHTML(box, '<span class="kicker">这个问题接下来想找谁</span>' +
      '<h3>' + esc(nq.what) + '</h3>' +
      '<p><b>找谁：</b>' + esc(nq.who) + '</p>' +
      '<p><b>为什么：</b>' + esc(nq.why) + '</p>' +
      '<div class="tags">' + (nq.subtopics || []).map(function (k) { return tag(subtopicName(k)); }).join('') + '</div>');
    show(box, true);
  } else if (box) show(box, false);
}

/* ---------- 5. 当前调查结论 ---------- */
async function renderConclusions() {
  const s = await loadSummary();
  const data = await api('/conclusions');
  document.title = '当前调查结论 · 活问题';
  setHTML(el('concl-title'), esc(data.question.title));
  setHTML(el('concl-headline'), esc(data.headline));
  setHTML(el('concl-boundary'), esc(data.question.boundary));
  const c = data.corpus || {};
  setHTML(el('concl-corpus'),
    '<b>内容底账</b><br>可核对公开来源 ' + (c.related || 0) + ' 条，检索时排除 ' + (c.excluded || 0) + ' 条' +
    '<br>抓取时间：' + esc(String(c.fetchedAt || '').slice(0, 19).replace('T', ' ')) +
    (c.stale ? '（已超过新鲜度窗口，需要重新检索）' : ''));
  const llm = s.llm || {};
  setHTML(el('concl-llm'), '<b>整理方式</b><br>' + (llm.configured
    ? '已配置语言模型：把上面这些内容按六条子命题整理成可读结论，不添加任何未出现的说法。'
    : '未配置语言模型：结论由本地规则按六条子命题拼装，只使用已核对的内容。'));

  MOTION.announce('当前调查结论已加载：' + data.headline);
  setHTML(el('concl-list'), (data.items || []).map(function (item) {
    let h = '<div class="concl">';
    h += '<div class="top"><h3>' + esc(item.name) + '</h3>' + tag(item.evidenceLabel, item.evidenceState) + '</div>';
    h += '<p class="need">' + esc(item.need) + '</p>';
    const cnt = item.counts || {};
    h += '<div class="counts"><span>公开来源 <b>' + (cnt.real || 0) + '</b></span>' +
      '<span>体验样本 <b>' + (cnt.sample || 0) + '</b></span>' +
      '<span>当事人经历 <b>' + (cnt.contribution || 0) + '</b></span></div>';
    h += '<div class="cols">';
    h += '<div class="col"><h4>目前能读到的</h4>' + listOf(item.current, '当前检索范围内这一条还没有可核对的内容。') + '</div>';
    h += '<div class="col"><h4>成立的条件</h4>' + listOf(item.conditions, '还不足以给出条件。') + '</div>';
    h += '<div class="col"><h4>条件相近但结果相反</h4>' + listOf(item.contrast, '还没有找到条件相近、结果不同的对照。') + '</div>';
    h += '<div class="col"><h4>仍然没有答案</h4>' + listOf(item.open, '—') + '</div>';
    h += '</div>';
    if ((item.contributions || []).length) {
      h += '<details open><summary>当事人补充的经历 · ' + item.contributions.length + ' 条</summary><div class="inner">' +
        item.contributions.map(function (x) {
          return '<div class="contrib"><b>' + esc(x.label || x.roleName || '一位当事人') + '</b><span>' + esc(x.value || x.text || '') + '</span></div>';
        }).join('') + '</div></details>';
    }
    if ((item.sources || []).length) {
      h += '<details><summary>这一条用到的公开来源 · ' + item.sources.length + ' 条</summary><div class="inner">' +
        item.sources.map(function (x) {
          const label = esc(x.title || x.url || '');
          return x.url
            ? '<a class="src-link" href="' + esc(x.url) + '" target="_blank" rel="noopener noreferrer">' + label + '</a><br>'
            : '<span class="src-link">' + label + '</span><br>';
        }).join('') + '</div></details>';
    }
    h += '</div>';
    return h;
  }).join(''));
}

function listOf(items, emptyText) {
  const list = items || [];
  if (!list.length) return '<p class="empty">' + esc(emptyText) + '</p>';
  return '<ul>' + list.map(function (x) {
    return '<li>' + esc(typeof x === 'string' ? x : (x.text || x.title || '')) + '</li>';
  }).join('') + '</ul>';
}

/* ---------- 6. 知乎回答草稿 ---------- */
function stamp(iso) {
  const s = String(iso || '');
  if (!s) return '—';
  return s.slice(0, 19).replace('T', ' ');
}

function updateAnswerCount() {
  const body = el('answer-body');
  const out = el('answer-count');
  if (!body || !out) return;
  const n = String(body.value || '').length;
  out.textContent = n + ' 字';
}

function flashAnswer(text, bad) {
  const tools = el('view-answer') ? el('view-answer').querySelector('.draft-tools') : null;
  if (!tools || !tools.parentNode) return;
  let node = el('answer-flash');
  if (!node) {
    node = document.createElement('p');
    node.id = 'answer-flash';
    tools.parentNode.insertBefore(node, tools.nextSibling);
  }
  node.className = bad ? 'form-msg bad' : 'form-msg';
  node.textContent = text || '';
  show(node, !!text);
  if (node.__timer) clearTimeout(node.__timer);
  if (text) node.__timer = setTimeout(function () { show(node, false); }, 5000);
}

function paintAnswer(data) {
  const body = el('answer-body');
  if (!body || !data) return;
  body.value = String(data.body || '');
  const meta = el('answer-meta');
  if (meta) {
    meta.textContent = '生成时间 ' + stamp(data.generatedAt) + ' · 已纳入 ' + (data.contributionCount || 0) + ' 份当事人经历';
  }
  const notice = el('answer-notice');
  if (notice) {
    notice.textContent = String(data.notice || '');
    show(notice, !!data.notice);
  }
  updateAnswerCount();
  if (data.body) MOTION.announce('知乎回答草稿已生成，共 ' + String(data.body).length + ' 字，可以直接编辑。');
}

async function loadAnswerDraft(force) {
  const body = el('answer-body');
  if (!body) return;
  if (!force && state.answer) { paintAnswer(state.answer); return; }
  const btn = el('answer-refresh');
  if (btn) { btn.disabled = true; btn.textContent = '正在整理…'; }
  flashAnswer('', false);
  try {
    const data = await api('/answer-draft');
    state.answer = data;
    paintAnswer(data);
  } catch (err) {
    flashAnswer('草稿暂时没能生成：' + err.message, true);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '重新生成草稿'; }
  }
}

async function copyAnswer() {
  const body = el('answer-body');
  if (!body) return;
  const text = String(body.value || '');
  if (!text.trim()) { flashAnswer('还没有可以复制的内容。', true); return; }
  let ok = false;
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      ok = true;
    }
  } catch (e) { ok = false; }
  if (!ok) {
    try {
      body.focus();
      body.select();
      ok = !!(document.execCommand && document.execCommand('copy'));
    } catch (e2) { ok = false; }
  }
  if (ok) flashAnswer('已经复制全文，可以直接粘贴到知乎。', false);
  else flashAnswer('浏览器不允许自动复制，请手动全选这段文字，再按复制。', true);
}

async function renderAnswer() {
  document.title = '知乎回答草稿 · 活问题';
  const body = el('answer-body');
  if (!body) return;
  const refresh = el('answer-refresh');
  if (refresh) refresh.onclick = function () { loadAnswerDraft(true); };
  const copy = el('answer-copy');
  if (copy) copy.onclick = copyAnswer;
  body.oninput = updateAnswerCount;
  updateAnswerCount();
  await loadAnswerDraft(false);
}

/* ---------- 7. 知识宇宙 ---------- */
const COSMOS_STATE_COLOR = {
  'empty': '#8a9298',
  'public-only': '#4c8dff',
  'single-case': '#e8a33d',
  'multi-case': '#3ddc84'
};

function cosmosStarMaterial(size) {
  return new THREE.ShaderMaterial({
    uniforms: { uSize: { value: size || 30 }, uBreath: { value: 1 } },
    vertexShader: [
      'attribute vec3 aColor;',
      'attribute float aSize;',
      'varying vec3 vColor;',
      'void main() {',
      '  vColor = aColor;',
      '  vec4 mv = modelViewMatrix * vec4(position, 1.0);',
      '  gl_PointSize = aSize * (300.0 / max(-mv.z, 0.001));',
      '  gl_Position = projectionMatrix * mv;',
      '}',
      ''
    ].join(String.fromCharCode(10)),
    fragmentShader: [
      'uniform float uBreath;',
      'varying vec3 vColor;',
      'void main() {',
      '  vec2 d = gl_PointCoord - vec2(0.5);',
      '  float r = length(d);',
      '  if (r > 0.5) discard;',
      '  float core = smoothstep(0.5, 0.06, r);',
      '  float halo = pow(smoothstep(0.5, 0.0, r), 2.4);',
      '  float a = core * 0.72 + halo * 0.5;',
      '  a *= uBreath;',
      '  gl_FragColor = vec4(vColor * (0.85 + core * 0.55), a);',
      '}',
      ''
    ].join(String.fromCharCode(10)),
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending
  });
}

function createCosmos(canvas, tipHost, labelsHost, onPick) {
  const stage = canvas.parentNode;
  const renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: true, alpha: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setClearColor(0x000000, 0);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 4000);
  const group = new THREE.Group();
  scene.add(group);

  const HOME = { theta: 0.9, phi: 0.98 };
  const view = { theta: HOME.theta, phi: HOME.phi, radius: 104 };
  const goal = { theta: HOME.theta, phi: HOME.phi, radius: 104 };

  let width = 1, height = 1;
  let nodes = [];
  let nodeById = {};
  let starField = null;
  let linkGroup = null;
  let labelNodes = [];
  let labelsRoot = null;
  let autoRotate = true;
  let dragging = false;
  let moved = 0;
  let lastX = 0, lastY = 0;
  let selectedId = null;
  let hoverId = null;
  let pointerX = -999, pointerY = -999;
  const cosmosWheel = MOTION.wheelGuard();
  const drift = { x: 0, vel: 0, phase: 0 };

  function heightOf(total, max) {
    const ratio = max > 0 ? Math.min((total || 0) / max, 1.6) : 0;
    return 2 + ratio * 26;
  }

  function disposeGroup(target) {
    while (target.children.length) {
      const child = target.children.pop();
      if (child.geometry) child.geometry.dispose();
      if (child.material) {
        const mats = Array.isArray(child.material) ? child.material : [child.material];
        mats.forEach(function (m) { if (m.dispose) m.dispose(); });
      }
    }
  }

  function lineBetween(a, b, color, opacity) {
    const geo = new THREE.BufferGeometry().setFromPoints([a, b]);
    const mat = new THREE.LineBasicMaterial({ color: color, transparent: true, opacity: opacity });
    return new THREE.Line(geo, mat);
  }

  function buildStars() {
    if (!nodes.length) return null;
    const geo = new THREE.BufferGeometry();
    const pos = new Float32Array(nodes.length * 3);
    const col = new Float32Array(nodes.length * 3);
    const siz = new Float32Array(nodes.length);
    const maxTotal = nodes.reduce(function (m, n) { return n.kind === "subtopic" ? Math.max(m, n.total) : m; }, 0);
    nodes.forEach(function (n, i) {
      pos[i * 3] = n.pos.x; pos[i * 3 + 1] = n.pos.y; pos[i * 3 + 2] = n.pos.z;
      const hex = n.kind === "question" ? "#d9f45f" : (COSMOS_STATE_COLOR[n.state] || "#8a9298");
      const c = new THREE.Color(hex);
      col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
      if (n.kind === "question") siz[i] = 2.6;
      else {
        const r = maxTotal > 0 ? Math.min(n.total / maxTotal, 1) : 0;
        siz[i] = n.total > 0 ? (1.0 + r * 1.1) : 0.8;
      }
    });
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
    geo.setAttribute('aSize', new THREE.BufferAttribute(siz, 1));
    const mat = cosmosStarMaterial(34);
    const field = new THREE.Points(geo, mat);
    field.frustumCulled = false;
    return field;
  }

  function buildLinks() {
    const center = nodes.filter(function (n) { return n.kind === "question"; })[0];
    if (!center) return null;
    const holder = new THREE.Group();
    nodes.forEach(function (n) {
      if (n.kind !== "subtopic") return;
      const hex = COSMOS_STATE_COLOR[n.state] || "#8a9298";
      holder.add(lineBetween(center.pos, n.pos, new THREE.Color(hex), n.total > 0 ? 0.3 : 0.14));
    });
    return holder.children.length ? holder : null;
  }

  function buildLabels() {
    if (!labelsHost) {
      labelsHost = document.createElement('div');
      labelsHost.className = 'clabels';
      labelsHost.style.position = "absolute";
      labelsHost.style.inset = "0";
      labelsHost.style.pointerEvents = "none";
      stage.appendChild(labelsHost);
    }
    labelsRoot = labelsHost;
    labelsHost.innerHTML = '';
    labelNodes = nodes.map(function (n) {
      const node = document.createElement('span');
      node.className = 'clab' + (n.kind === 'question' ? ' big' : '') + (n.total > 0 ? '' : ' faint');
      node.textContent = n.kind === "question" ? n.short : n.short;
      node.__item = n;
      node.style.position = "absolute";
      labelsHost.appendChild(node);
      return node;
    });
  }

  function project(v3) {
    const p = v3.clone().project(camera);
    return {
      x: (p.x * 0.5 + 0.5) * width,
      y: (-p.y * 0.5 + 0.5) * height,
      visible: p.z > -1 && p.z < 1
    };
  }

  function renderLabels() {
    labelNodes.forEach(function (node) {
      const item = node.__item;
      const pr = project(item.pos);
      if (!pr.visible) { node.style.display = "none"; return; }
      node.style.display = "block";
      const on = item.id === selectedId || item.id === hoverId;
      node.style.left = pr.x + "px";
      node.style.top = (pr.y - 12) + "px";
      node.style.opacity = on ? "1" : (item.kind === "question" ? "0.95" : "0.72");
    });
  }

  function resize() {
    const rect = stage.getBoundingClientRect();
    width = Math.max(1, Math.round(rect.width));
    height = Math.max(1, Math.round(rect.height));
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  }

  function tipFor(n) {
    if (!n) return "";
    if (n.kind === "question") {
      return "<b>" + esc(n.name) + "</b>" + esc("这个问题整体上已经被 " + n.total + " 条内容覆盖。点周围的星，看每一条子命题还缺什么。");
    }
    const c = n.counts || {};
    return "<b>" + esc(n.name) + "</b>" + esc(n.label || "") + "<br>" +
      esc("公开来源 " + (c.real || 0) + " · 体验样本 " + (c.sample || 0) + " · 当事人经历 " + (c.contribution || 0));
  }

  function pickAt(px, py) {
    let best = null, bestD = 26;
    nodes.forEach(function (n) {
      const pr = project(n.pos);
      if (!pr.visible) return;
      const d = Math.sqrt((pr.x - px) * (pr.x - px) + (pr.y - py) * (pr.y - py));
      if (d < bestD) { bestD = d; best = n; }
    });
    return best;
  }

  /* 浮层离场：与地图同构，退出用 ease-in-expo（motion-web references/motion-tokens.md）。 */
  function hideTip() {
    if (!tipHost || tipHost.hidden) return;
    if (MOTION.reduced || tipHost.classList.contains('leaving')) { show(tipHost, false); return; }
    tipHost.classList.add('leaving');
    tipHost.addEventListener('animationend', function onOut(e) {
      if (e.target !== tipHost) return;
      tipHost.removeEventListener('animationend', onOut);
      tipHost.classList.remove('leaving');
      show(tipHost, false);
    });
  }

  function setTip(n, px, py) {
    if (!tipHost) return;
    if (!n) { hideTip(); return; }
    setHTML(tipHost, tipFor(n));
    tipHost.classList.remove('leaving');
    show(tipHost, true);
    const rect = stage.getBoundingClientRect();
    const w = tipHost.offsetWidth || 200;
    const left = Math.min(Math.max(px + 14, 8), Math.max(8, rect.width - w - 8));
    tipHost.style.left = left + "px";
    tipHost.style.top = Math.max(8, py - 10) + "px";
  }

  function setNodes(list) {
    nodes = list || [];
    nodeById = {};
    nodes.forEach(function (n) { nodeById[n.id] = n; });
    disposeGroup(group);
    starField = buildStars();
    if (starField) group.add(starField);
    linkGroup = buildLinks();
    if (linkGroup) group.add(linkGroup);
    buildLabels();
    resize();
  }

  function focus(id) {
    selectedId = id;
    const n = nodeById[id];
    if (!n) return;
    goal.radius = 72;
    goal.theta = view.theta + 0.2;
  }

  canvas.addEventListener("pointerdown", function (e) {
    dragging = true; moved = 0; lastX = e.clientX; lastY = e.clientY;
    canvas.classList.add("grabbing");
    try { canvas.setPointerCapture(e.pointerId); } catch (err) {}
  });
  canvas.addEventListener("pointermove", function (e) {
    const rect = canvas.getBoundingClientRect();
    pointerX = e.clientX - rect.left; pointerY = e.clientY - rect.top;
    if (dragging) {
      const dx = e.clientX - lastX, dy = e.clientY - lastY;
      lastX = e.clientX; lastY = e.clientY;
      moved += Math.abs(dx) + Math.abs(dy);
      goal.theta -= dx * 0.006;
      goal.phi = Math.min(Math.max(goal.phi - dy * 0.005, 0.25), 1.5);
      autoRotate = false;
      hideTip();
      return;
    }
    const hit = pickAt(pointerX, pointerY);
    hoverId = hit ? hit.id : null;
    setTip(hit, pointerX, pointerY);
    canvas.style.cursor = hit ? "pointer" : "grab";
  });
  canvas.addEventListener("pointerup", function (e) {
    const wasDrag = moved > 6;
    dragging = false;
    canvas.classList.remove("grabbing");
    if (wasDrag) return;
    const rect = canvas.getBoundingClientRect();
    const hit = pickAt(e.clientX - rect.left, e.clientY - rect.top);
    if (hit) {
      selectedId = hit.id;
      setTip(hit, e.clientX - rect.left, e.clientY - rect.top);
      if (onPick) onPick(hit);
    }
  });
  canvas.addEventListener("pointerleave", function () {
    dragging = false;
    hoverId = null;
    canvas.classList.remove("grabbing");
    hideTip();
  });
  canvas.addEventListener("wheel", function (e) {
    e.preventDefault();
    const dir = cosmosWheel.step(e.deltaY, performance.now());
    if (!dir) return;
    const next = goal.radius * (dir > 0 ? 1.1 : 0.9);
    goal.radius = Math.min(Math.max(next, 40), 260);
  }, { passive: false });

  if (window.ResizeObserver) {
    const ro = new ResizeObserver(function () { resize(); });
    ro.observe(stage);
  } else {
    window.addEventListener("resize", resize);
  }
  resize();

  const clock = new THREE.Clock();
  function frame() {
    const dt = Math.min(clock.getDelta(), 0.05);
    const now = clock.elapsedTime;
    if (autoRotate && !dragging) goal.theta += dt * 0.09;
    view.theta = MOTION.follow(view.theta, goal.theta, dragging ? 8.5 : 4.5, dt);
    view.phi = MOTION.follow(view.phi, goal.phi, 5.0, dt);
    view.radius = MOTION.follow(view.radius, goal.radius, 3.6, dt);
    camera.position.setFromSphericalCoords(view.radius, view.phi, view.theta);
    camera.lookAt(0, 8, 0);

    /* 星点整体微光呼吸：不是每颗同步，用整体相位 + 极缓慢漂移制造"活着"的感觉。 */
    if (starField && starField.material && starField.material.uniforms) {
      starField.material.uniforms.uBreath.value = MOTION.reduced ? 1 : (0.88 + MOTION.breath(now, 0.42, drift.phase) * 0.12);
    }
    if (!MOTION.reduced && starField) {
      drift.vel += (MOTION.breath(now, 0.23, 1.1) * 0.34 - drift.x) * 12 * dt;
      drift.vel *= 0.94;
      drift.x += drift.vel * dt;
      starField.rotation.z = drift.x * 0.01;
    }

    renderer.render(scene, camera);
    renderLabels();
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  return { setNodes: setNodes, focus: focus };
}

async function renderUniverse() {
  document.title = "知识宇宙 · 活问题";
  const s = await loadSummary();
  const g = await loadGraph();
  const q = s.question;
  const stats = (g.coverage && g.coverage.stats) || [];
  const byKey = {};
  stats.forEach(function (x) { byKey[x.key] = x; });

  const subList = (s.subtopics || []).map(function (sub) {
    const st = byKey[sub.key] || {};
    return {
      id: "sub-" + sub.key,
      kind: "subtopic",
      key: sub.key,
      name: sub.name,
      short: sub.name,
      need: sub.need,
      total: st.total || 0,
      counts: { real: st.real || 0, sample: st.sample || 0, contribution: st.contribution || 0 },
      state: st.evidenceState || "empty",
      label: st.evidenceLabel || "当前检索范围内覆盖不足"
    };
  });

  const maxTotal = subList.reduce(function (m, n) { return Math.max(m, n.total); }, 0);
  const centerY = 6;
  const nodes = [{
    id: "question-" + q.id,
    kind: "question",
    name: q.title,
    short: "这个问题",
    total: subList.reduce(function (a, n) { return a + n.total; }, 0),
    state: "question",
    pos: new THREE.Vector3(0, centerY + 10, 0)
  }];

  subList.forEach(function (n, i) {
    const angle = (i / Math.max(subList.length, 1)) * Math.PI * 2;
    const radius = 22;
    const h = 2 + (maxTotal > 0 ? Math.min(n.total / maxTotal, 1.4) : 0) * 20;
    n.pos = new THREE.Vector3(Math.cos(angle) * radius, h, Math.sin(angle) * radius);
    nodes.push(n);
  });

  if (!state.cosmos) {
    state.cosmos = createCosmos(el("cosmos-canvas"), el("cosmos-tip"), null, function (hit) {
      paintCosmosList(hit);
    });
  }
  state.cosmos.setNodes(nodes);

  const count = el("cosmos-count");
  if (count) {
    setHTML(count, "<b>当前调查范围</b><span>" + esc("1 个活问题 · " + subList.length + " 条子命题 · " + ((g.counts && g.counts.real) || 0) + " 条公开来源 · " + ((g.counts && g.counts.contribution) || 0) + " 份当事人经历") + "</span>");
  }

  paintCosmosList(nodes[0]);
}

function paintCosmosList(hit) {
  const host = el("cosmos-list");
  if (!host) return;
  const s = state.summary;
  const g = state.graph;
  const stats = (g && g.coverage && g.coverage.stats) || [];
  const byKey = {};
  stats.forEach(function (x) { byKey[x.key] = x; });
  const subs = (s && s.subtopics) || [];

  let head = "";
  if (hit && hit.kind === "subtopic") {
    head = "<p class=\"mono-note\">正在看：" + esc(hit.name) + " · " + esc(hit.label) + "</p>";
  } else {
    head = "<p class=\"mono-note\">" + esc("当前只有一个活问题进入调查。高度表示它被真实经历覆盖的程度，低处是还缺少当事人内容的部分。") + "</p>";
  }

  const items = subs.map(function (sub) {
    const st = byKey[sub.key] || {};
    const n = st.total || 0;
    const on = hit && hit.kind === "subtopic" && hit.key === sub.key;
    return "<button class=\"q-item\" type=\"button\" data-sub=\"" + esc(sub.key) + "\" aria-pressed=\"" + (on ? "true" : "false") + "\">" +
      "<span class=\"st\">" + esc(st.evidenceLabel || "当前检索范围内覆盖不足") + "</span>" +
      "<b>" + esc(sub.name) + " · " + n + " 条</b>" +
      "<span>" + esc(sub.need) + "<br>" + esc("公开来源 " + (st.real || 0) + " · 体验样本 " + (st.sample || 0) + " · 当事人经历 " + (st.contribution || 0)) + "</span>" +
      "</button>";
  }).join("");

  setHTML(host, head + items +
    "<p class=\"hint\">" + esc("看看这个问题还缺什么，或者补上一个只有你知道的事实。") + "</p>" +
    "<div class=\"cta-row\"><a class=\"cta\" href=\"#/interview\">" + esc("补上我的经历") + "</a>" +
    "<a class=\"cta alt\" href=\"#/new\">" + esc("提出一个新问题") + "</a></div>");

  host.querySelectorAll("[data-sub]").forEach(function (node) {
    node.addEventListener("click", function () {
      const key = node.getAttribute("data-sub");
      const stat = byKey[key] || {};
      const item = {
        kind: "subtopic", key: key, name: subtopicName(key),
        total: stat.total || 0,
        counts: { real: stat.real || 0, sample: stat.sample || 0, contribution: stat.contribution || 0 },
        state: stat.evidenceState || "empty",
        label: stat.evidenceLabel || "当前检索范围内覆盖不足"
      };
      if (state.cosmos) state.cosmos.focus("sub-" + key);
      paintCosmosList(item);
    });
  });
}

/* ---------- 8. 提出新问题 ---------- */
function renderNewView() {
  document.title = "提出新问题 · 活问题";
  const btn = el("new-submit");
  if (btn) btn.onclick = submitNewQuestion;
  const ta = el("new-question");
  if (ta && !ta.__bound) {
    ta.__bound = true;
    ta.addEventListener("keydown", function (e) {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); submitNewQuestion(); }
    });
  }
  const host = el("new-verdict");
  if (host && !host.innerHTML) {
    setHTML(host, "<p class=\"mono-note\">" + esc("写下一个你觉得还没有答案的问题，先看它能不能启动。") + "</p>");
  }
}

async function submitNewQuestion() {
  const ta = el("new-question");
  const text = ta ? String(ta.value || "").trim() : "";
  if (!text) { msg("new-msg", "请先写下一个问题。", true); return; }
  msg("new-msg", "", false);
  const btn = el("new-submit");
  if (btn) { btn.disabled = true; btn.textContent = "正在判断…"; }
  try {
    const data = await api("/new-question", { method: "POST", body: JSON.stringify({ question: text }) });
    paintVerdict(data);
  } catch (err) {
    msg("new-msg", "没能判断这个问题：" + err.message, true);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "检查这个问题能不能启动"; }
  }
}

function paintVerdict(data) {
  const host = el("new-verdict");
  if (!host || !data) return;
  const sig = data.signals || {};
  const hit = (sig.concrete || []).concat(sig.boundary || []);
  const warn = sig.broad || [];
  let h = "<div class=\"verdict " + esc(data.state) + "\">";
  h += "<span class=\"tagline\">" + esc(data.label) + "</span>";
  h += "<h3>" + esc(data.summary) + "</h3>";
  h += "<ul>" + (data.reasons || []).map(function (r) { return "<li>" + esc(r) + "</li>"; }).join("") + "</ul>";
  if (hit.length || warn.length) {
    h += "<div class=\"signals\">";
    hit.forEach(function (w) { h += tag(w, "hit"); });
    warn.forEach(function (w) { h += tag(w, "warn"); });
    h += "</div>";
  }
  h += "<p class=\"next\"><b>下一步：</b>" + esc(data.nextStep) + "</p>";

  if (data.state === "ready") {
    h += "<p class=\"next\">" + esc("这个问题仍在寻找条件相近、结果不同的人，以及参与过实际招聘的人。") + "</p>";
    h += "<div class=\"cta-row\"><a class=\"cta\" href=\"#/interview\">" + esc("先按当前问题参与") + "</a>" +
      "<a class=\"cta alt\" href=\"#/scene\">" + esc("回到当前调查") + "</a></div>";
  } else if (data.state === "saturated") {
    const ch = data.corpusHit || {};
    if ((ch.titles || []).length) {
      h += "<p class=\"next\"><b>命中的内容：</b>" + (ch.titles || []).map(function (t) { return esc(t); }).join("；") + "</p>";
    }
    h += "<div class=\"cta-row\"><a class=\"cta alt\" href=\"#/conclusions\">" + esc("先读当前结论") + "</a></div>";
  } else {
    h += "<div class=\"cta-row\"><button class=\"cta alt\" type=\"button\" id=\"new-example\">" + esc("用一句话看例子") + "</button></div>";
  }
  h += "</div>";
  setHTML(host, h);
  MOTION.announce('判定结果：' + data.label + '。' + data.summary);

  const ex = el("new-example");
  if (ex) ex.addEventListener("click", function () {
    const ta = el("new-question");
    if (ta) { ta.value = "普通本科应届生投 AI 产品岗，简历关卡在哪里？"; ta.focus(); }
  });
}

/* ---------- 启动 ---------- */
window.addEventListener("hashchange", route);
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", function () { route(); });
else route();
