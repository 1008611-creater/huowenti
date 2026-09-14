/* 在场 Zaichang — 前端工作台
   原则：所有数字与结论都来自服务端真实数据，前端不编造任何现场信息。 */

const state = {
  caseId: '',
  question: '',
  matches: [],
  relationTypes: [],
  timer: null,
  answered: false,
  lanUrls: [],
  publicUrl: '',
  oauthConfigured: false,
  healthLoaded: false,
  qrCache: {}
};

const $ = (selector) => document.querySelector(selector);

function esc(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function clock(value) {
  if (!value) return '刚刚';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '刚刚';
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  const time = date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
  return sameDay ? '今天 ' + time : date.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' }) + ' ' + time;
}

/* 时效：现场信息的价值随时间衰减 */
const AGE_TIERS = [
  { code: 'live', label: '现场有效', maxHours: 2 },
  { code: 'recent', label: '仍然新鲜', maxHours: 12 },
  { code: 'aging', label: '开始过时', maxHours: 48 },
  { code: 'stale', label: '已过时', maxHours: Infinity }
];

function freshness(value) {
  const stamp = value ? new Date(value).getTime() : NaN;
  if (Number.isNaN(stamp)) return { code: 'live', label: '现场有效', hours: 0 };
  const hours = Math.round(((Date.now() - stamp) / 3600000) * 10) / 10;
  if (hours < 0) return { code: 'live', label: '现场有效', hours: 0 };
  const tier = AGE_TIERS.find((item) => hours <= item.maxHours) || AGE_TIERS[AGE_TIERS.length - 1];
  return { code: tier.code, label: tier.label, hours };
}

function agoText(hours) {
  if (hours < 1) return Math.max(1, Math.round(hours * 60)) + ' 分钟前';
  if (hours < 24) return Math.round(hours) + ' 小时前';
  return Math.round(hours / 24) + ' 天前';
}

async function request(url, options) {
  const response = await fetch(url, options);
  let data = {};
  try { data = await response.json(); } catch (error) { data = {}; }
  if (!response.ok) throw new Error(data.message || data.error || '请求失败');
  return data;
}

/* ---------- 顶部状态 ---------- */

async function loadHealth() {
  try {
    const data = await request('/api/health');
    state.relationTypes = data.relationTypes || [];
    state.lanUrls = data.lanUrls || [];
    state.publicUrl = data.publicUrl || '';
    if (!state.publicUrl) {
      try {
        const meta = await request('/assets/public-url.json?t=' + Date.now());
        if (meta && meta.url) state.publicUrl = String(meta.url).replace(/\/+$/, '');
      } catch (error) { /* 没有公网地址时退回局域网 */ }
    }
    state.oauthConfigured = Boolean(data.oauthConfigured);
    state.healthLoaded = true;
    const total = (data.corpus.story || 0) + (data.corpus.knowledge || 0);
    $('#corpus-count').textContent = total ? String(total) : '—';
    $('#live-text').textContent = total
      ? '已接入 ' + total + ' 篇知乎公开内容'
      : '知乎内容暂不可用，将如实说明';
    return data;
  } catch (error) {
    $('#live-text').textContent = '服务状态未知';
    state.healthLoaded = true;
    return null;
  }
}

/* ---------- 渲染片段 ---------- */

function entityChips(analysis) {
  const entities = analysis.entities || {};
  const chips = [];
  (entities.places || []).forEach((place) => chips.push(['地点 · ', place, false]));
  (entities.times || []).forEach((time) => chips.push(['时间 · ', time, false]));
  (entities.intents || []).forEach((intent) => chips.push(['待确认 · ', intent.label, true]));
  if (!chips.length) chips.push(['待确认 · ', '此刻现场的真实状态', true]);
  return chips.map((chip) => '<b class="' + (chip[2] ? 'warn' : '') + '">' + esc(chip[0]) + esc(chip[1]) + '</b>').join('');
}

function matchMarkup(matches, data) {
  if (!matches.length) {
    const size = (data && data.corpusSize) || 0;
    const scanned = size ? '内容库里的 ' + size + ' 篇公开内容' : '内容库里的公开内容';
    return '<div class="empty">' +
        '<b>这个问题，知乎上没有现成的答案</b>' +
        '<p>我们逐条比对了' + esc(scanned) + '，没有一篇能回答你问的「此刻」。这不是检索失败——已经写下的内容，记录的都是过去的经验；而你问的是现在正在发生的事。</p>' +
        '<p>这一步如实留空，是因为我们不拿无关内容充数。答案只能来自此刻就在现场的人，这正是「在场」要解决的问题。</p>' +
      '</div>';
  }
  return '<div class="matches">' + matches.map((match) => {
    const reasons = (match.reasons || []).map((reason) => '<span class="reason">' + esc(reason) + '</span>').join('');
    const labels = (match.labels || []).slice(0, 3).map((label) => '<span>' + esc(label) + '</span>').join('');
    const kindLabel = match.kind === 'story' ? '知乎故事' : '知乎知识';
    return '<a class="match" href="' + esc(match.url) + '" target="_blank" rel="noreferrer noopener">' +
      '<div class="match-top"><b>' + esc(match.title) + '</b><span class="rel">命中 ' + ((match.keywords || []).length) + ' 个关键词</span></div>' +
      '<p>' + esc((match.labels || []).join(' · ') || '知乎公开内容') + '</p>' +
      '<div class="match-meta"><span>' + esc(kindLabel) + '</span>' + labels + reasons + '</div>' +
      '<div class="hit-terms">命中词：' + esc((match.keywords || []).join('、')) + '</div>' +
    '</a>';
  }).join('') + '</div>';
}

function feedbackMarkup(data) {
  const items = data.feedback || [];
  if (!items.length) {
    return '<div class="empty"><b>还没有现场反馈</b><p>把下面的求证链接发给真正到过现场的人。收到反馈之前，系统不会生成任何结论。</p></div>';
  }
  return '<div class="fb-list">' + items.map((entry) => {
    const signals = (entry.signals || []).map((signal) => '<span class="sig">' + esc(signal.label) + '</span>').join('');
    const tags = [
      entry.relation ? '<span>' + esc(entry.relation) + '</span>' : '',
      entry.area ? '<span>位置 · ' + esc(entry.area) + '</span>' : '',
      (function () {
        const f = freshness(entry.createdAt);
        const cls = (f.code === 'stale' || f.code === 'aging') ? 'warn' : '';
        return '<span class="' + cls + '">' + esc(f.label) + ' · ' + agoText(f.hours) + '</span>';
      })(),
      entry.duplicate ? '<span class="warn">与已有反馈重复</span>' : ''
    ].join('');
    const conflicted = data.evidenceState && data.evidenceState.code === 'conflict';
    return '<div class="fb ' + (entry.duplicate ? 'dup' : (conflicted ? 'conflict' : '')) + '">' +
      '<div class="fb-head"><b>' + esc(entry.displayName || '匿名现场用户') + '</b><span>' + clock(entry.createdAt) + '</span></div>' +
      '<p>' + esc(entry.content) + '</p>' +
      '<div class="fb-tags">' + tags + signals + '</div>' +
    '</div>';
  }).join('') + '</div>';
}

function conflictsMarkup(evidence) {
  const conflicts = (evidence && evidence.conflicts) || [];
  if (!conflicts.length) return '';
  return '<div class="conflict-box">' +
    '<b>分歧点 · 需要谨慎</b>' +
    conflicts.map((item) => '<div class="conflict-row"><span class="side pos">' + esc(item.positive.label) + ' ×' + esc(item.positive.count) + '</span><i>与</i><span class="side neg">' + esc(item.negative.label) + ' ×' + esc(item.negative.count) + '</span></div>').join('') +
    '<p>系统不会替你抹平这种分歧。请优先相信时间更新、信息更具体的那一条，或者在现场确认后补充新的反馈。</p>' +
  '</div>';
}

/* 分维度结论：告诉用户哪些方面已被确认、哪些方面还有分歧，而不是一刀切说“不可信” */
const DIM_STATUS_CLASS = { '一致': 'd-ok', '单一': 'd-one', '中性': 'd-neutral', '分歧': 'd-bad', '参考': 'd-ref' };

function dimensionsMarkup(evidence) {
  const dims = (evidence && evidence.dimensions) || [];
  if (!dims.length) return '';
  return '<div class="dims">' +
    '<div class="dims-title"><b>分维度结论</b><i>哪些方面可以相信，哪些还要再问</i></div>' +
    '<div class="dim-grid">' + dims.map((dim) =>
      '<div class="dim ' + (DIM_STATUS_CLASS[dim.status] || 'd-ref') + '">' +
        '<div class="dim-head"><span>' + esc(dim.label) + '</span><i>' + esc(dim.status) + '</i></div>' +
        '<div class="dim-tags">' + (dim.labels || []).map((label) => '<span>' + esc(label) + '</span>').join('') + '</div>' +
        (dim.conflict ? '<p>' + esc(dim.conflict) + '</p>' : '') +
      '</div>').join('') + '</div>' +
  '</div>';
}

function meterMarkup(evidence) {
  const level = Math.max(0, Math.min(3, Number(evidence.level) || 0));
  return '<div class="meter">' +
    '<div class="meter-row"><span>证据强度 · ' + esc(evidence.code.toUpperCase()) + '</span><b>' + esc(evidence.confidence) + '%</b></div>' +
    '<div class="track lv' + level + '"><i></i></div>' +
    '<div class="legend">' +
      '<span><i class="l0"></i>待确认 0</span>' +
      '<span><i class="l1"></i>单一来源 30</span>' +
      '<span><i class="l2"></i>存在冲突 35</span>' +
      '<span><i class="l3"></i>交叉印证 70+</span>' +
    '</div>' +
  '</div>';
}

function timelineMarkup(data) {
  const items = [
    { title: '问题提交，完成问题拆解', note: clock(data.createdAt), now: false },
    { title: '知乎背景内容匹配 ' + (data.matches || []).length + ' 篇', note: '仅作为背景，不构成现场结论', now: false }
  ];
  (data.feedback || []).forEach((entry) => {
    items.push({ title: '收到现场反馈 · ' + (entry.displayName || '匿名'), note: clock(entry.createdAt) + ' · ' + (entry.relation || '现场反馈'), now: false });
  });
  (data.answers || []).forEach((entry) => {
    items.push({ title: '基于真实证据生成结论', note: clock(entry.createdAt), now: true });
  });
  if (!(data.answers || []).length) {
    items.push({ title: '等待足够证据后生成结论', note: '当前状态：' + (data.evidenceState.label || '待确认'), now: true });
  }
  return '<div class="timeline"><h4>证据时间线</h4>' + items.map((item) => (
    '<div class="tl-item ' + (item.now ? 'now' : '') + '"><div class="tl-dot"></div><div><b>' + esc(item.title) + '</b><small>' + esc(item.note) + '</small></div></div>'
  )).join('') + '</div>';
}

function answerMarkup(record, data) {
  const actions = '<div class="actions">' +
    '<a href="/case/' + esc(data.id) + '">打开可分享的结论页 →</a>' +
    '<button type="button" id="copy-answer">复制结论</button>' +
  '</div>';
  return '<section class="answer" id="answer">' +
    '<div class="kicker">ANSWER · ' + clock(record.createdAt) + ' <i>' + (record.live ? '知乎直答生成' : '本地证据整理') + '</i></div>' +
    '<h2>' + esc(record.answer) + '</h2>' +
    '<p class="note">证据状态：<b>' + esc(record.evidenceState.label) + '</b>（置信度 ' + esc(record.evidenceState.confidence) + '%）。' + esc(record.evidenceState.reason) + '</p>' +
    actions +
  '</section>';
}

/* ---------- 扫码到场 ---------- */

/* 本机演示时 localhost 手机打不开：改用服务端返回的局域网地址。 */
function qrTargetUrl(link) {
  let parsed;
  try { parsed = new URL(link); } catch (error) { return { url: link, lan: false, ok: true }; }
  const local = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname === '::1' || parsed.hostname === '[::1]';
  if (!local) return { url: link, lan: false, ok: true };
  /* 优先级：公网地址（评委扫码能打开）> 局域网地址（同一 WiFi 时可用） */
  const publicBase = state.publicUrl || '';
  if (publicBase) return { url: publicBase.replace(/\/+$/, '') + parsed.pathname + parsed.search, lan: false, ok: true };
  const lan = (state.lanUrls || [])[0];
  if (!lan) return { url: '', lan: false, ok: false };
  return { url: lan + parsed.pathname + parsed.search, lan: true, ok: true };
}

/* 同一个链接只编码一次，轮询刷新时复用，避免二维码跳动。 */
function qrSvg(url) {
  if (state.qrCache[url]) return state.qrCache[url];
  if (typeof qrcode !== 'function') return '';
  try {
    const qr = qrcode(0, 'M');
    qr.addData(url);
    qr.make();
    const svg = qr.createSvgTag({
      cellSize: 4,
      margin: 1,
      scalable: true,
      title: '求证链接二维码',
      alt: '用手机扫码打开这条求证：' + url
    });
    state.qrCache[url] = svg;
    return svg;
  } catch (error) {
    return '';
  }
}

function qrMarkup(link) {
  const target = qrTargetUrl(link);
  if (!target.ok) {
    return '<div class="qr-block">' +
      '<div class="qr-copy">' +
        '<b>手机扫码暂不可用</b>' +
        '<p>现在打开的是本机演示地址，手机连不上。把上面的链接发给到场的人，或把本页部署到公网后再生成二维码——我们不会给出扫不开的码。</p>' +
      '</div>' +
    '</div>';
  }
  const svg = qrSvg(target.url);
  if (!svg) return '';
  return '<div class="qr-block" data-qr-url="' + esc(target.url) + '">' +
    '<div class="qr-figure">' + svg + '</div>' +
    '<div class="qr-copy">' +
      '<b>扫码 · 用手机到场确认</b>' +
      '<p>' + (target.lan
        ? '手机与这台电脑连同一个 Wi-Fi，扫码即可打开求证页。二维码指向局域网地址，仅供现场演示。'
        : '扫码即可在手机上打开这条求证，把现场观察发回来。') +
      '</p>' +
      '<code>' + esc(target.url) + '</code>' +
    '</div>' +
  '</div>';
}

function evidencePanelMarkup(data) {
  /* 页面显示的链接、二维码、复制按钮三处指向同一个地址：本机演示时自动换成手机能打开的局域网地址。 */
  const direct = location.origin + data.feedbackUrl;
  const shareTarget = qrTargetUrl(direct);
  const link = (shareTarget.ok && shareTarget.url) ? shareTarget.url : direct;
  const answers = data.answers || [];
  const answered = answers.length > 0;
  return '<section class="panel" id="evidence-panel">' +
    '<div class="panel-title"><span>03 / 真实现场反馈</span><i>' + esc(data.evidenceState.label) + '</i></div>' +
    '<p class="body-copy">这是一个真实案件。当前没有虚构的人物、匹配率或自动生成的现场反馈。' +
      '链接只接收对方主动填写的区域级信息。</p>' +
    '<div class="share"><code>' + esc(link) + '</code><button type="button" id="copy-link">复制链接</button></div>' +
    qrMarkup(link) +
    feedbackMarkup(data) +
    conflictsMarkup(data.evidenceState) +
    dimensionsMarkup(data.evidenceState) +
    meterMarkup(data.evidenceState) +
    '<div class="live-actions">' +
      '<button class="secondary-cta" type="button" id="refresh-case">刷新反馈</button>' +
      (answered
        ? '<a class="secondary-cta" href="/case/' + esc(data.id) + '">查看结论页</a>'
        : '<button class="primary-cta" type="button" id="final" style="margin-top:0;width:auto">基于真实证据生成答案 <span>→</span></button>') +
    '</div>' +
    (function () {
      const f = data.evidenceState.freshness;
      if (!f) return '';
      const cls = (f.code === 'stale' || f.code === 'aging') ? ' warn' : '';
      return '<p class="hint' + cls + '" style="margin-top:6px">最新一条现场观察：' + esc(f.label) + ' · ' + agoText(f.hours) + '（超过 48 小时的观察不计入判断）</p>';
    })() +
    '<p class="hint" style="margin-top:14px">当前判断：' + esc(data.evidenceState.reason) + '</p>' +
    timelineMarkup(data) +
  '</section>';
}

/* ---------- 主流程 ---------- */

function loadingMarkup(message) {
  return '<section class="workspace"><div class="loading"><div class="spin"></div><div><b>正在建立案件</b><p>' + esc(message) + '</p></div></div></section>';
}

async function start() {
  const question = $('#question').value.trim();
  if (!question) { $('#question').focus(); return; }
  state.question = question;
  state.answered = false;
  const stage = $('#stage');
  stage.innerHTML = loadingMarkup('正在拆解问题，并检索知乎已有公开内容…');
  $('#start').disabled = true;

  try {
    const data = await request('/api/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: question })
    });
    state.caseId = data.caseId;
    state.matches = data.matches || [];
    const analysis = data.analysis || {};

    const known = (analysis.knownFacts || []).map((fact) => '<li>' + esc(fact) + '</li>').join('');
    const unknown = (analysis.unknownFacts || []).map((fact) => '<li>' + esc(fact) + '</li>').join('');

    stage.innerHTML =
      '<section class="workspace">' +
        '<div class="crumb"><span>在场 / ' + (data.reused ? '已有现场反馈' : '新建确认') + '</span><span class="tag">' + (data.reused ? '真实反馈 · ' + esc(String(data.feedbackCount || 0)) + ' 条' : (data.openApiLive ? 'LIVE · 知乎开放平台' : '真实案件 · 等待现场')) + '</span></div>' +
        '<div class="qbar"><div><small>你的问题</small><h2>' + esc(question) + '</h2></div><button class="ghost-btn" type="button" id="reset">重新提问</button></div>' +
        '<div class="grid">' +
          '<article class="panel">' +
            '<div class="panel-title"><span>01 / 问题拆解</span><i>' + esc(analysis.confidence || '规则化拆解') + '</i></div>' +
            '<h3>' + (data.reused ? '这个问题已经有人在现场回答过' : '先把未知交给现场') + '</h3>' +
            '<p class="body-copy">' + (data.reused ? '系统检索到自己此前已经收到过这个问题的真实现场反馈，因此直接带你进入那条案件，而不是再造一条空壳。下面每一条反馈都能追溯到具体提交时间与来源关系。' : '系统不会假装知道此刻发生了什么。它先把需要真人确认的部分列出来，再建立一个可以接收反馈的真实案件。这一步由可解释的规则完成，不使用大模型猜测现场。') + '</p>' +
            '<div class="chips">' + entityChips(analysis) + '</div>' +
            '<div class="zwx-slot" id="zwx"></div>' +
            '<div class="known">' +
              '<div><label>已有公开背景</label><ul>' + (known || '<li>暂无足够的公开背景，只能先记录问题。</li>') + '</ul></div>' +
              '<div><label>必须现场确认</label><ul>' + (unknown || '<li>需要真实用户到现场观察。</li>') + '</ul></div>' +
            '</div>' +
          '</article>' +
          '<article class="panel">' +
            '<div class="panel-title"><span>02 / 知乎背景内容</span><i>' + state.matches.length + ' MATCHES · ' + (data.corpusSize || 0) + ' DOCS</i></div>' +
            '<h3>已有知识只做背景</h3>' +
            matchMarkup(state.matches, data) +
          '</article>' +
        '</div>' +
      '</section>';

    bindWorkspace();
    loadWeatherBlock((((analysis.entities || {}).places || [])[0]) || '');
    await loadEvidence();
    document.getElementById('evidence-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (error) {
    stage.innerHTML = '<section class="workspace"><div class="error">案件创建失败：' + esc(error.message) + '</div></section>';
  } finally {
    $('#start').disabled = false;
  }
}

function bindWorkspace() {
  const reset = $('#reset');
  if (reset) reset.onclick = () => {
    clearInterval(state.timer);
    state.caseId = '';
    $('#stage').innerHTML = '';
    $('#question').value = '';
    $('#question').focus();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };
}

async function loadEvidence() {
  if (!state.caseId) return;
  try {
    if (!state.healthLoaded) await loadHealth();
    const data = await request('/api/cases/' + encodeURIComponent(state.caseId));
    const panel = $('#evidence-panel');
    if (panel) {
      panel.outerHTML = evidencePanelMarkup(data);
    } else {
      const workspace = document.querySelector('.workspace');
      if (workspace) workspace.insertAdjacentHTML('beforeend', evidencePanelMarkup(data));
    }
    bindEvidence(data);
  } catch (error) {
    /* 静默重试，下一轮轮询仍会尝试 */
  }
}

function bindEvidence(data) {
  const copy = $('#copy-link');
  if (copy) copy.onclick = async () => {
    const target = qrTargetUrl(location.origin + data.feedbackUrl);
    const text = target.ok && target.url ? target.url : location.origin + data.feedbackUrl;
    try {
      await navigator.clipboard.writeText(text);
      copy.textContent = '已复制';
    } catch (error) {
      copy.textContent = '请手动复制';
    }
  };
  const refresh = $('#refresh-case');
  if (refresh) refresh.onclick = async () => { refresh.textContent = '正在刷新…'; await loadEvidence(); };
  const final = $('#final');
  if (final) final.onclick = generateAnswer;
  const copyAnswer = $('#copy-answer');
  if (copyAnswer) copyAnswer.onclick = async () => {
    const answer = $('#answer h2');
    if (!answer) return;
    try { await navigator.clipboard.writeText(answer.textContent); copyAnswer.textContent = '已复制'; }
    catch (error) { copyAnswer.textContent = '请手动复制'; }
  };
  clearInterval(state.timer);
  if (!state.answered) {
    state.timer = setInterval(loadEvidence, 6000);
  }
}

async function generateAnswer() {
  const button = $('#final');
  if (!button) return;
  button.disabled = true;
  button.textContent = '正在读取真实证据…';
  try {
    const record = await request('/api/cases/' + encodeURIComponent(state.caseId) + '/answer', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });
    state.answered = true;
    clearInterval(state.timer);
    const panel = $('#evidence-panel');
    panel.insertAdjacentHTML('afterend', answerMarkup(record, { id: state.caseId }));
    bindEvidence({ feedbackUrl: '/verify/' + state.caseId, id: state.caseId });
    $('#answer').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (error) {
    const panel = $('#evidence-panel');
    panel.insertAdjacentHTML('beforeend', '<div class="error" style="margin-top:16px">' + esc(error.message) + '</div>');
    button.disabled = false;
    button.textContent = '基于真实证据生成答案 →';
  }
}

/* ---------- 真实气象信号 ---------- */
/* 数据来自服务端 /api/weather：服务端代理公开气象接口并缓存，前端只如实展示。
   拿不到就明说拿不到；气象数据只描述客观观测，不替现场结论作证。 */

const WX_ICON = {
  sun: '<circle cx="12" cy="12" r="4.2"/><path d="M12 2.4v2.6M12 19v2.6M2.4 12h2.6M19 12h2.6M5.3 5.3l1.9 1.9M16.8 16.8l1.9 1.9M18.7 5.3l-1.9 1.9M7.2 16.8l-1.9 1.9"/>',
  night: '<path d="M20 14.6A8.4 8.4 0 0 1 9.4 4 8.4 8.4 0 1 0 20 14.6z"/>',
  partly: '<circle cx="8.4" cy="8.4" r="3.2"/><path d="M8.4 2.6v1.9M2.6 8.4h1.9M4.4 4.4l1.3 1.3M12.4 4.4l-1.3 1.3"/><path d="M9.6 18.6h8.2a3.4 3.4 0 0 0 .2-6.8 4.6 4.6 0 0 0-8.8 1.1 2.9 2.9 0 0 0 .4 5.7z"/>',
  cloud: '<path d="M6.8 18.4h10.4a3.6 3.6 0 0 0 .2-7.2 5 5 0 0 0-9.6 1.2 3.1 3.1 0 0 0-1 6z"/>',
  rain: '<path d="M6.8 15.4h10.4a3.6 3.6 0 0 0 .2-7.2 5 5 0 0 0-9.6 1.2 3.1 3.1 0 0 0-1 6z"/><path d="M8.6 18.4l-.8 2.2M12 18.4l-.8 2.2M15.4 18.4l-.8 2.2"/>',
  storm: '<path d="M6.8 14.4h10.4a3.6 3.6 0 0 0 .2-7.2 5 5 0 0 0-9.6 1.2 3.1 3.1 0 0 0-1 6z"/><path d="M13 16.2l-3.2 4.4h2.8l-.6 3"/>',
  snow: '<path d="M6.8 14.4h10.4a3.6 3.6 0 0 0 .2-7.2 5 5 0 0 0-9.6 1.2 3.1 3.1 0 0 0-1 6z"/><path d="M9 18.4v2.6M12 18.4v2.6M15 18.4v2.6"/>',
  fog: '<path d="M5.6 9.6h12.8M4.4 13h15.2M6.4 16.4h11.2"/>'
};

const WX_REASON = {
  place_required: '这个问题里没有出现可以定位的地点，所以不显示气象数据。',
  place_not_found: '没有查到这个地方的坐标，所以不显示气象数据。',
  upstream_timeout: '气象数据源响应超时，稍后重试即可。',
  upstream_error: '气象数据源暂时不可用。',
  upstream_shape: '气象数据源返回的内容不完整。'
};

function wxIcon(name) {
  const path = WX_ICON[name] || WX_ICON.cloud;
  return '<svg class="zwx-icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">' + path + '</svg>';
}

function wxStyleOnce() {
  if (document.getElementById('wx-style')) return;
  const style = document.createElement('style');
  style.id = 'wx-style';
  style.textContent = [
    '.zwx{margin-top:16px;padding:14px 16px;border:1px solid var(--line);border-radius:3px;background:var(--white)}',
    '.zwx-loading,.zwx-miss{font-size:11.5px;color:var(--muted);line-height:1.9}',
    '.zwx-miss-head{display:flex;align-items:center;gap:8px;color:var(--ink);font-size:12.5px;margin-bottom:6px}',
    '.zwx-miss p{margin:0;font-size:11.5px;line-height:1.9;color:var(--muted)}',
    '.zwx-head{display:flex;flex-wrap:wrap;gap:12px 20px;align-items:center;justify-content:space-between}',
    '.zwx-place{display:flex;align-items:center;gap:10px;min-width:0}',
    '.zwx-place .zwx-icon{width:30px;height:30px;color:var(--teal);flex:none}',
    '.zwx-place b{display:block;font-family:var(--serif);font-size:14px;font-weight:600}',
    '.zwx-place small{display:block;margin-top:3px;font-size:10.5px;color:var(--muted-2)}',
    '.zwx-temp{text-align:right;line-height:1.2}',
    '.zwx-temp b{display:block;font-size:clamp(20px,2.6vw,26px);font-variant-numeric:tabular-nums}',
    '.zwx-temp small{font-size:10.5px;color:var(--muted)}',
    '.zwx-metrics{display:flex;flex-wrap:wrap;gap:6px 20px;margin-top:12px;padding-top:10px;border-top:1px solid var(--line)}',
    '.zwx-metrics span{font-size:10.5px;color:var(--muted)}',
    '.zwx-metrics i{font-style:normal;color:var(--muted-2)}',
    '.zwx-metrics b{margin-left:5px;color:var(--ink);font-variant-numeric:tabular-nums}',
    '.zwx-signals{display:flex;flex-wrap:wrap;gap:6px;margin-top:12px}',
    '.zwx-sig{display:inline-flex;align-items:baseline;gap:6px;padding:3px 9px;border:1px solid var(--line-2);border-radius:999px;font-size:10.5px}',
    '.zwx-sig b{font-weight:600}',
    '.zwx-sig i{font-style:normal;color:var(--muted-2);font-size:10px}',
    '.zwx-sig.warn{border-color:rgba(232,86,42,.35);background:rgba(232,86,42,.07)}',
    '.zwx-sig.warn b{color:#b03d18}',
    '.zwx-sig.ok{border-color:rgba(47,109,95,.3);background:rgba(47,109,95,.07)}',
    '.zwx-sig.ok b{color:#2a6155}',
    '.zwx-hours{display:flex;flex-wrap:wrap;gap:8px;margin-top:12px}',
    '.zwx-hour{flex:1 1 108px;padding:8px 10px;border:1px solid var(--line);border-radius:3px;background:var(--paper-2)}',
    '.zwx-hour small{display:block;font-size:10px;color:var(--muted-2)}',
    '.zwx-hour b{display:block;margin-top:3px;font-size:13px;font-variant-numeric:tabular-nums}',
    '.zwx-hour i{display:block;margin-top:3px;font-style:normal;font-size:10px;color:var(--muted)}',
    '.zwx-src{margin:12px 0 0;padding-top:9px;border-top:1px dashed var(--line);font-size:10px;line-height:1.8;color:var(--muted-2)}',
    '@media (max-width:560px){.zwx-temp{text-align:left}}'
  ].join('\n');
  document.head.appendChild(style);
}

function wxTime(value) {
  if (!value) return '时间未知';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  const hhmm = date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
  const today = new Date();
  const sameDay = date.toDateString() === today.toDateString();
  return sameDay ? '今天 ' + hhmm : date.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' }) + ' ' + hhmm;
}

function wxMetric(label, value, unit) {
  if (value == null) return '';
  return '<span><i>' + esc(label) + '</i><b>' + esc(String(value)) + (unit || '') + '</b></span>';
}

function wxMarkup(data) {
  if (!data || data.available !== true) {
    const reason = WX_REASON[(data && data.reason) || ''] || (data && data.message) || '暂时拿不到这个地方的气象数据。';
    return '<div class="zwx zwx-miss">' +
        '<div class="zwx-miss-head">' + wxIcon('fog') + '<b>没有显示气象数据</b></div>' +
        '<p>' + esc(reason) + '这里保持真实空状态，不用估算值填充。</p>' +
      '</div>';
  }
  const cur = data.current || {};
  const place = data.place || {};
  const placeName = place.name || place.query || '未知地点';
  const matched = place.matched && place.matched !== placeName ? '（匹配到「' + place.matched + '」）' : '';
  const coord = (place.lat != null && place.lon != null) ? '坐标 ' + place.lat + ', ' + place.lon : '';
  const signals = (data.signals || []).map((signal) => {
    const cls = signal.tone === 'warn' ? ' warn' : (signal.tone === 'ok' ? ' ok' : '');
    return '<span class="zwx-sig' + cls + '"><b>' + esc(signal.label) + '</b>' + (signal.detail ? '<i>' + esc(signal.detail) + '</i>' : '') + '</span>';
  }).join('');
  const hours = (cur.nextHours || []).slice(0, 3);
  const hoursBlock = hours.length
    ? '<div class="zwx-hours">' + hours.map((hour) => (
        '<div class="zwx-hour">' +
          '<small>' + esc(wxTime(hour.time)) + '</small>' +
          '<b>' + (hour.temperature == null ? '—' : esc(String(hour.temperature)) + '°') + '</b>' +
          '<i>' + esc(hour.condition || '—') + (hour.precipitation ? ' · 降水 ' + esc(String(hour.precipitation)) + ' 毫米' : '') + '</i>' +
        '</div>'
      )).join('') + '</div>'
    : '';
  return '<div class="zwx">' +
      '<div class="zwx-head">' +
        '<div class="zwx-place">' + wxIcon(cur.icon) +
          '<div><b>' + esc(placeName) + matched + '</b>' +
          '<small>观测时间 ' + esc(wxTime(cur.observedAt)) + (coord ? ' · ' + esc(coord) : '') + '</small></div>' +
        '</div>' +
        '<div class="zwx-temp">' +
          '<b>' + (cur.temperature == null ? '—' : esc(String(cur.temperature)) + '°') + '</b>' +
          '<small>' + esc(cur.condition || '天气未知') + (cur.apparent == null ? '' : ' · 体感 ' + esc(String(cur.apparent)) + '°') + '</small>' +
        '</div>' +
      '</div>' +
      '<div class="zwx-metrics">' +
        wxMetric('湿度', cur.humidity, '%') +
        wxMetric('风速', cur.windSpeed, ' 公里/小时') +
        wxMetric('降水', cur.precipitation, ' 毫米') +
        wxMetric('云量', cur.cloudCover, '%') +
      '</div>' +
      (signals ? '<div class="zwx-signals">' + signals + '</div>' : '') +
      hoursBlock +
      '<p class="zwx-src">气象数据来自 ' + esc((data.source && data.source.name) || '公开气象接口') + '，属于逐小时预报模型，不是官方气象台发布的实况；服务端缓存 10 分钟。它只描述客观观测，不替这条求证结论作证。</p>' +
    '</div>';
}

async function loadWeatherBlock(place) {
  const slot = document.getElementById('zwx');
  if (!slot) return;
  const query = String(place == null ? '' : place).trim();
  if (!query) { slot.innerHTML = ''; return; }
  wxStyleOnce();
  slot.innerHTML = '<div class="zwx zwx-loading">正在读取「' + esc(query) + '」的实时气象观测…</div>';
  try {
    const data = await request('/api/weather?place=' + encodeURIComponent(query));
    slot.innerHTML = wxMarkup(data);
  } catch (error) {
    slot.innerHTML = '<div class="zwx zwx-miss"><div class="zwx-miss-head">' + wxIcon('fog') + '<b>没有显示气象数据</b></div><p>' + esc(error.message || '请求失败') + '</p></div>';
  }
}

/* ---------- 首页「真实案例」 ---------- */
/* 这一段的数据全部来自服务端 /api/cases：只列已经收到真实现场反馈的问题，
   同一个问题只出现证据最完整的一条；人数、时间、结论强度都是读出来的，不做任何修饰。 */

const SHOWCASE_TONE = {
  verified: { bg: 'rgba(47,109,95,.13)', fg: '#2a6155', dot: '#2f6d5f' },
  corroborated: { bg: 'rgba(47,109,95,.10)', fg: '#2a6155', dot: '#2f6d5f' },
  single: { bg: 'rgba(240,162,2,.18)', fg: '#7f5500', dot: '#f0a202' },
  conflict: { bg: 'rgba(232,86,42,.13)', fg: '#b03d18', dot: '#e8562a' },
  pending: { bg: 'rgba(20,26,23,.06)', fg: '#5e685f', dot: '#8b958d' }
};

function showcaseStyleOnce() {
  if (document.getElementById('showcase-style')) return;
  const style = document.createElement('style');
  style.id = 'showcase-style';
  style.textContent = [
    '#real-cases{margin:clamp(30px,5vw,58px) 0 0}',
    '.zshow-head{display:flex;flex-wrap:wrap;gap:16px 30px;align-items:flex-end;justify-content:space-between;border-top:1px solid var(--ink);padding-top:16px}',
    '.zshow-head h2{margin:0;font-family:var(--serif);font-size:clamp(19px,2.4vw,26px);font-weight:700}',
    '.zshow-head p{margin:8px 0 0;max-width:54ch;font-size:11.5px;line-height:1.85;color:var(--muted)}',
    '.zshow-stat{text-align:right;line-height:1.25}',
    '.zshow-stat b{display:block;font-size:clamp(22px,3vw,30px);font-variant-numeric:tabular-nums}',
    '.zshow-stat small{font-size:10.5px;color:var(--muted)}',
    '.zshow-grid{display:grid;gap:12px;grid-template-columns:repeat(auto-fill,minmax(268px,1fr));margin-top:20px}',
    '.zshow-card{display:flex;flex-direction:column;gap:10px;padding:16px 16px 14px;background:var(--white);border:1px solid var(--line);border-radius:3px;text-decoration:none;color:inherit;transition:transform .16s ease,box-shadow .16s ease,border-color .16s ease}',
    '.zshow-card:hover{transform:translateY(-2px);border-color:var(--ink);box-shadow:0 14px 28px -22px rgba(20,26,23,.65)}',
    '.zshow-top{display:flex;align-items:center;justify-content:space-between;gap:8px}',
    '.zbadge{display:inline-flex;align-items:center;gap:5px;padding:2px 8px;border-radius:999px;font-size:10px;white-space:nowrap}',
    '.zbadge i{width:5px;height:5px;border-radius:50%;display:block}',
    '.ztime{font-size:10px;color:var(--muted-2);white-space:nowrap}',
    '.zshow-card h3{margin:0;font-family:var(--serif);font-size:15.5px;font-weight:600;line-height:1.5}',
    '.zmeta{display:flex;flex-wrap:wrap;gap:4px 14px;font-size:10.5px;color:var(--muted)}',
    '.zmeta b{color:var(--ink);font-variant-numeric:tabular-nums}',
    '.ztags{display:flex;flex-wrap:wrap;gap:5px;margin-top:auto}',
    '.zsig{padding:1px 7px;border:1px solid var(--line-2);border-radius:999px;font-size:9.5px;color:var(--muted)}',
    '.zsig-answer{border-color:var(--acid-deep);background:rgba(217,244,95,.22);color:var(--ink)}',
    '.zgo{font-size:10.5px;color:var(--teal)}',
    '.zshow-more{margin:14px 0 0;font-size:10.5px;color:var(--muted-2)}',
    '@media (max-width:560px){.zshow-stat{text-align:left}.zshow-grid{grid-template-columns:1fr}}'
  ].join('\n');
  document.head.appendChild(style);
}

function showcaseCardMarkup(item) {
  const tone = SHOWCASE_TONE[item.code] || SHOWCASE_TONE.pending;
  const fresh = freshness(item.updatedAt || item.createdAt);
  const signals = (item.signalLabels || []).slice(0, 3)
    .map((label) => '<span class="zsig">' + esc(label) + '</span>').join('');
  return '<a class="zshow-card" href="' + esc(item.caseUrl) + '">' +
      '<div class="zshow-top">' +
        '<span class="zbadge" style="background:' + tone.bg + ';color:' + tone.fg + '">' +
          '<i style="background:' + tone.dot + '"></i>' + esc(item.label) + ' · ' + esc(String(item.confidence)) + '%' +
        '</span>' +
        '<span class="ztime">' + esc(fresh.label) + ' · ' + agoText(fresh.hours) + '</span>' +
      '</div>' +
      '<h3>' + esc(item.question) + '</h3>' +
      '<div class="zmeta">' +
        '<span><b>' + esc(String(item.feedbackCount)) + '</b> 条现场反馈</span>' +
        '<span><b>' + esc(String(item.independentCount)) + '</b> 位独立到场</span>' +
      '</div>' +
      '<div class="ztags">' + signals + (item.hasAnswer ? '<span class="zsig zsig-answer">已生成结论</span>' : '') + '</div>' +
      '<span class="zgo">查看完整证据链 →</span>' +
    '</a>';
}

async function loadShowcase() {
  const anchor = document.querySelector('.examples-legend') || document.querySelector('.examples');
  if (!anchor || document.getElementById('real-cases')) return;
  let data = null;
  try {
    data = await request('/api/cases?limit=6');
  } catch (error) {
    return;
  }
  const items = (data && data.cases) || [];
  if (!items.length) return;
  showcaseStyleOnce();
  const section = document.createElement('section');
  section.id = 'real-cases';
  section.innerHTML =
    '<div class="zshow-head">' +
      '<div>' +
        '<h2>这些不是演示数据</h2>' +
        '<p>下面每个问题都收到过真实提交的现场反馈。来源关系、独立到场人数、最近更新时间全部读自服务端真实数据；证据不够的会直说不够，不做美化。</p>' +
      '</div>' +
      '<div class="zshow-stat"><b>' + esc(String(data.total)) + '</b><small>个问题已有现场反馈</small></div>' +
    '</div>' +
    '<div class="zshow-grid">' + items.map(showcaseCardMarkup).join('') + '</div>' +
    (data.total > items.length
      ? '<p class="zshow-more">还有 ' + esc(String(data.total - items.length)) + ' 个问题已有现场反馈，点进去可以看完整证据链。</p>'
      : '');
  anchor.insertAdjacentElement('afterend', section);
}

/* ---------- 启动 ---------- */

$('#start').onclick = start;
$('#question').addEventListener('keydown', (event) => {
  if ((event.metaKey || event.ctrlKey || event.key === 'Enter') && event.key === 'Enter') {
    event.preventDefault();
    start();
  }
});
/* 示例问题：两组对照，让第一次打开的人一眼看懂产品边界。
   ① 现场类：知乎上不可能有现成答案，系统会如实留空——这正是「在场」要补的缺口；
   ② 背景类：知乎上确实有公开内容，系统给出真实匹配——证明检索真的在工作，不是摆设。
   两组并排，谁都能自己点一遍验证，不需要听我们解释。 */
const EXAMPLE_QUESTIONS = [
  { text: '现在去首都机场 T3 还来得及吗', kind: '现场' },
  { text: '此刻西湖断桥人多吗，现在去合适吗', kind: '现场' },
  { text: '如何让老板给我升职加薪', kind: '背景' },
  { text: '不想学习的时候怎么逼自己学习', kind: '背景' }
];

const KIND_STYLE = {
  '现场': 'display:inline-block;margin-right:6px;padding:1px 6px;border-radius:999px;font-size:9px;letter-spacing:.04em;background:rgba(20,26,23,.075);color:var(--muted);vertical-align:1px',
  '背景': 'display:inline-block;margin-right:6px;padding:1px 6px;border-radius:999px;font-size:9px;letter-spacing:.04em;background:transparent;border:1px solid var(--line-2);color:var(--muted);vertical-align:1px'
};

document.querySelectorAll('.examples button').forEach((button, index) => {
  const item = EXAMPLE_QUESTIONS[index];
  const text = (item && item.text) || button.textContent.trim();
  button.innerHTML = item
    ? '<i style="' + KIND_STYLE[item.kind] + '">' + item.kind + '</i>' + esc(text)
    : esc(text);
  button.onclick = () => { $('#question').value = text; $('#question').focus(); };
});

/* 在示例按钮下方补一行对照说明：评委不用猜，点之前就知道会看到什么。 */
(function () {
  const row = document.querySelector('.examples');
  if (!row || row.nextElementSibling && row.nextElementSibling.classList.contains('examples-legend')) return;
  const legend = document.createElement('p');
  legend.className = 'examples-legend';
  legend.setAttribute('style', 'margin:10px 0 0;font-size:10.5px;line-height:1.75;color:var(--muted)');
  legend.innerHTML = '标 <b style="color:var(--ink)">现场</b> 的两个，知乎上没有现成答案，系统会如实留空，请把求证链接发给正在现场的人；标 <b style="color:var(--ink)">背景</b> 的两个，知乎上有公开内容，系统会给出真实匹配——两边都可以自己点开验证。';
  row.insertAdjacentElement('afterend', legend);
})();
/* 知乎账号登录：只有配置了开放平台凭证才跳转，未配置时如实说明，不把用户丢到报错页。 */
function loginNotice(message) {
  const existing = document.querySelector('.notice');
  if (existing) existing.remove();
  const el = document.createElement('div');
  el.className = 'notice';
  el.setAttribute('role', 'status');
  el.textContent = message;
  document.body.appendChild(el);
  setTimeout(() => { if (el.parentElement) el.remove(); }, 6000);
}

$('#login').onclick = () => {
  if (state.healthLoaded && !state.oauthConfigured) {
    loginNotice('账号登录需要开放平台凭证，本机演示未配置，可先用完整流程。');
    return;
  }
  location.href = '/oauth/login';
};
loadHealth();
loadShowcase();
