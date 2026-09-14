/* 在场 — 可分享的求证结论页 */

const caseId = location.pathname.split('/').filter(Boolean).pop();
const mount = document.querySelector('#case');
const VERDICT_CLASS = { pending: 'v-pending', single: 'v-single', conflict: 'v-conflict', corroborated: 'v-corroborated', verified: 'v-verified' };
/* 分维度结论的颜色映射 */
const DIM_STATUS_CLASS = { '一致': 'd-ok', '单一': 'd-one', '中性': 'd-neutral', '分歧': 'd-bad', '参考': 'd-ref' };
let payload = null;
let lanUrls = [];
const qrCache = {};

function esc(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function clock(value) {
  if (!value) return '刚刚';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '刚刚';
  return date.toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
}

/* 时效：此刻类问题里，旧观察不能冒充当前现场 */
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

/* ---------- 扫码到场 ---------- */

function qrTargetUrl(link) {
  let parsed;
  try { parsed = new URL(link); } catch (error) { return { url: link, lan: false, ok: true }; }
  const local = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname === '::1' || parsed.hostname === '[::1]';
  if (!local) return { url: link, lan: false, ok: true };
  const lan = lanUrls[0];
  if (!lan) return { url: '', lan: false, ok: false };
  return { url: lan + parsed.pathname + parsed.search, lan: true, ok: true };
}

function qrSvg(url) {
  if (qrCache[url]) return qrCache[url];
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
    qrCache[url] = svg;
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
        '<p>现在打开的是本机演示地址，手机连不上。把求证链接发给到场的人，或把本页部署到公网后再生成二维码——我们不会给出扫不开的码。</p>' +
      '</div>' +
    '</div>';
  }
  const svg = qrSvg(target.url);
  if (!svg) return '';
  return '<div class="qr-block" data-qr-url="' + esc(target.url) + '">' +
    '<div class="qr-figure">' + svg + '</div>' +
    '<div class="qr-copy">' +
      '<b>扫码 · 把这条求证发到现场</b>' +
      '<p>' + (target.lan
        ? '手机与这台电脑连同一个 Wi-Fi，扫码即可打开求证页并提交现场观察。二维码指向局域网地址，仅供现场演示。'
        : '扫码即可在手机上打开这条求证，把现场观察发回来。') +
      '</p>' +
      '<code>' + esc(target.url) + '</code>' +
    '</div>' +
  '</div>';
}

/* ---------- 真实气象信号 ---------- */
/* 与工作台同源：数据来自服务端 /api/cases/<id>/weather，服务端负责从问题里拆地点。
   只展示客观观测；拿不到就如实留空，不估算、不填充。 */

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
  no_place: '这个问题里没有出现可以定位的地点，所以不显示气象数据。',
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
    '.zwx{margin-top:22px;padding:16px 18px;border:1px solid var(--line);border-radius:3px;background:var(--white)}',
    '.zwx-loading,.zwx-miss{font-size:11.5px;color:var(--muted);line-height:1.9}',
    '.zwx-miss-head{display:flex;align-items:center;gap:8px;color:var(--ink);font-size:12.5px;margin-bottom:6px}',
    '.zwx-miss p{margin:0;font-size:11.5px;line-height:1.9;color:var(--muted)}',
    '.zwx-head{display:flex;flex-wrap:wrap;gap:12px 20px;align-items:center;justify-content:space-between}',
    '.zwx-place{display:flex;align-items:center;gap:10px;min-width:0}',
    '.zwx-place .zwx-icon{width:30px;height:30px;color:var(--teal);flex:none}',
    '.zwx-place b{display:block;font-family:var(--serif);font-size:14.5px;font-weight:600}',
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
  const sameDay = date.toDateString() === new Date().toDateString();
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
        '<p>' + esc(reason) + '</p>' +
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

async function loadWeatherBlock() {
  const slot = document.getElementById('zwx');
  if (!slot) return;
  wxStyleOnce();
  slot.innerHTML = '<div class="zwx zwx-loading">正在读取该地点的实时气象观测…</div>';
  try {
    const response = await fetch('/api/cases/' + encodeURIComponent(caseId) + '/weather');
    const data = await response.json();
    if (!response.ok) throw new Error(data.message || '气象数据暂时不可用。');
    if (!data || data.available !== true) {
      if ((data && data.reason) === 'no_place') { slot.innerHTML = ''; return; }
    }
    slot.innerHTML = wxMarkup(data);
  } catch (error) {
    slot.innerHTML = '<div class="zwx zwx-miss"><div class="zwx-miss-head">' + wxIcon('fog') + '<b>没有显示气象数据</b></div><p>' + esc(error.message || '请求失败') + '</p></div>';
  }
}

function relationLabels() {
  const map = {};
  (payload.relationTypes || []).forEach((type) => { map[type.code] = type; });
  return map;
}

async function boot() {
  try {
    try {
      const health = await fetch('/api/health');
      const hdata = await health.json();
      lanUrls = hdata.lanUrls || [];
    } catch (error) { /* 拿不到局域网地址就如实降级 */ }
    const response = await fetch('/api/cases/' + encodeURIComponent(caseId));
    const data = await response.json();
    if (!response.ok) throw new Error(data.message || '这条求证不存在或已失效。');
    payload = data;
    render(data);
  } catch (error) {
    mount.innerHTML = '<section class="narrow"><div class="error">' + esc(error.message) + '</div></section>';
  }
}

function render(data) {
  const evidence = data.evidenceState;
  const answers = data.answers || [];
  const latest = answers.length ? answers[answers.length - 1] : null;

  const hero =
    '<section class="case-hero">' +
      '<div class="crumb"><span>在场 / 求证案件</span><span class="tag">' + esc(data.id.slice(0, 8)) + '</span></div>' +
      '<div class="verdict ' + (VERDICT_CLASS[evidence.code] || '') + '" style="margin-top:26px"><i></i>' + esc(evidence.label) + '</div>' +
      '<h1>' + esc(data.question) + '</h1>' +
      '<div class="confidence">' +
        '<div class="num">' + esc(evidence.confidence) + '<small>%</small></div>' +
        '<div><div class="track lv' + Math.max(0, Math.min(3, evidence.level)) + '"><i></i></div>' +
        '<p class="hint" style="margin:10px 0 0">' + esc(evidence.reason) + '</p>' +
        (evidence.freshness ? '<p class="hint" style="margin:8px 0 0">最新一条现场观察：' + esc(evidence.freshness.label) + ' · ' + agoText(evidence.freshness.hours) + '</p>' : '') + '</div>' +
      '</div>' +
    '</section>';

  const answerBlock = latest
    ? '<section class="answer" id="answer">' +
        '<div class="kicker">ANSWER · ' + clock(latest.createdAt) + ' <i>' + (latest.live ? '知乎直答生成' : '基于现场证据整理') + '</i></div>' +
        '<div class="answer-text">' + esc(latest.answer) + '</div>' +
        '<p class="note">这是基于现场反馈整理的判断，保留不确定性，不代表官方确认。</p>' +
      '</section>'
    : '<div class="empty" style="margin-top:26px"><b>还没有可以发布的结论</b><p>' +
        (data.feedback.length ? '已收到现场反馈，请回到工作台生成结论。' : '这会是一条真实案件：收到真实现场反馈之前，系统不会生成任何结论。') +
      '</p></div>';

  const feedback = (data.feedback || []).length
    ? '<div class="fb-list">' + data.feedback.map((entry) => {
        const signals = (entry.signals || []).map((signal) => '<span class="sig">' + esc(signal.label) + '</span>').join('');
        return '<div class="fb ' + (entry.duplicate ? 'dup' : '') + '">' +
          '<div class="fb-head"><b>' + esc(entry.displayName || '匿名现场用户') + '</b><span>' + clock(entry.createdAt) + '</span></div>' +
          '<p>' + esc(entry.content) + '</p>' +
          '<div class="fb-tags">' +
            (entry.relation ? '<span>' + esc(entry.relation) + '</span>' : '') +
            (entry.area ? '<span>位置 · ' + esc(entry.area) + '</span>' : '') +
            (function () {
              const f = freshness(entry.createdAt);
              const cls = (f.code === 'stale' || f.code === 'aging') ? 'warn' : '';
              return '<span class="' + cls + '">' + esc(f.label) + ' · ' + agoText(f.hours) + '</span>';
            })() +
            signals +
            (entry.duplicate ? '<span class="warn">重复内容</span>' : '') +
          '</div>' +
        '</div>';
      }).join('') + '</div>'
    : '<div class="empty"><b>还没有现场反馈</b><p>把求证链接发给真正到过现场的人，收到反馈后这里会实时更新。</p></div>';

  const conflicts = (evidence.conflicts || []).length
    ? '<div class="conflict-box" style="margin-top:24px">' +
        '<b>分歧点 · 需要谨慎</b>' +
        evidence.conflicts.map((item) => '<div class="conflict-row"><span class="side pos">' + esc(item.positive.label) + ' ×' + esc(item.positive.count) + '</span><i>与</i><span class="side neg">' + esc(item.negative.label) + ' ×' + esc(item.negative.count) + '</span></div>').join('') +
        '<p>这条结论保留分歧，没有被抹平。请优先相信时间更新、信息更具体的那一条。</p>' +
      '</div>'
    : '';

  const dims = (evidence.dimensions || []).length
    ? '<div class="dims" style="margin-top:24px">' +
        '<div class="dims-title"><b>分维度结论</b><i>哪些方面可以相信，哪些还要再问</i></div>' +
        '<div class="dim-grid">' + evidence.dimensions.map((dim) =>
          '<div class="dim ' + (DIM_STATUS_CLASS[dim.status] || 'd-ref') + '">' +
            '<div class="dim-head"><span>' + esc(dim.label) + '</span><i>' + esc(dim.status) + '</i></div>' +
            '<div class="dim-tags">' + (dim.labels || []).map((label) => '<span>' + esc(label) + '</span>').join('') + '</div>' +
            (dim.conflict ? '<p>' + esc(dim.conflict) + '</p>' : '') +
          '</div>').join('') + '</div>' +
      '</div>'
    : '';

  const matches = (data.matches || []).length
    ? '<div class="matches">' + data.matches.map((match) => (
        '<a class="match" href="' + esc(match.url) + '" target="_blank" rel="noreferrer noopener">' +
          '<div class="match-top"><b>' + esc(match.title) + '</b><span class="rel">命中 ' + ((match.keywords || []).length) + ' 个关键词</span></div>' +
          '<p>' + esc((match.labels || []).join(' · ') || '知乎公开内容') + '</p>' +
          '<div class="hit-terms">命中词：' + esc((match.keywords || []).join('、')) + '</div>' +
        '</a>'
      )).join('') + '</div>'
    : '<div class="empty"><b>没有直接相关的公开内容</b><p>这一步如实为空，我们不填充虚构来源。</p></div>';

  mount.innerHTML = hero +
    '<div class="narrow" style="max-width:860px;padding-top:34px">' +
      '<div class="zwx-slot" id="zwx"></div>' +
      answerBlock +
      conflicts +
      dims +
      '<section class="panel" style="margin-top:26px">' +
        '<div class="panel-title"><span>现场证据 · ' + data.feedback.length + ' 条</span><i>' + esc(evidence.label) + '</i></div>' +
        feedback +
      '</section>' +
      '<section class="panel">' +
        '<div class="panel-title"><span>知乎背景内容</span><i>' + (data.matches || []).length + ' MATCHES</i></div>' +
        matches +
      '</section>' +
      '<p class="privacy" style="margin-top:24px"><b>关于这条结论</b>它是基于公开内容与真实用户主动提交的现场观察整理的判断，会随新反馈更新。系统不收集精确位置，也不代替官方渠道确认。</p>' +
      (data.feedbackUrl ? qrMarkup(location.origin + data.feedbackUrl) : '') +
    '</div>';

  document.querySelector('#footer-note').textContent = '最后更新 · ' + clock(data.updatedAt || data.createdAt);
  loadWeatherBlock();
}

document.querySelector('#share').onclick = async (event) => {
  event.preventDefault();
  const link = location.href;
  const target = qrTargetUrl(link);
  const text = target.ok && target.url ? target.url : link;
  try { await navigator.clipboard.writeText(text); event.target.textContent = '已复制'; }
  catch (error) { event.target.textContent = link; }
};

boot();
