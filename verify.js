/* 在场 — 现场反馈表单 */

const caseId = location.pathname.split('/').filter(Boolean).pop();
const questionNode = document.querySelector('#case-question');
const form = document.querySelector('#feedback-form');
const result = document.querySelector('#result');
const grid = document.querySelector('#relation-grid');
let relationTypes = [];

function esc(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

const FALLBACK_TYPES = [
  { code: 'witness', label: '本人到场', hint: '我刚刚亲自在现场看到' },
  { code: 'relay', label: '转述他人', hint: '我朋友 / 群里的人在现场，我转述' },
  { code: 'official', label: '官方或机构渠道', hint: '来自公告、客服、工作人员' },
  { code: 'archived', label: '历史记录', hint: '是我以前去过时的情况' }
];

const HINTS = {
  witness: '我刚刚亲自在现场看到',
  relay: '我朋友或群里的人在现场，我转述',
  official: '来自公告、客服或现场工作人员',
  archived: '是我以前到过时的情况'
};

function renderRelations(types) {
  const list = types.length ? types : FALLBACK_TYPES;
  grid.innerHTML = list.map((type, index) => (
    '<label><input type="radio" name="relationType" value="' + esc(type.code) + '"' + (index === 0 ? ' checked' : '') + '>' +
    '<span><b>' + esc(type.label) + '</b><small>' + esc(type.hint || HINTS[type.code] || '') + '</small></span></label>'
  )).join('');
}

async function boot() {
  try {
    const [caseResponse, healthResponse] = await Promise.all([
      fetch('/api/cases/' + encodeURIComponent(caseId)),
      fetch('/api/health')
    ]);
    if (healthResponse.ok) {
      const health = await healthResponse.json();
      relationTypes = health.relationTypes || [];
    }
    renderRelations(relationTypes);

    const data = await caseResponse.json();
    if (!caseResponse.ok) throw new Error(data.message || '这条求证请求不存在或已失效。');
    questionNode.innerHTML = '<small>正在求证的问题</small><strong>' + esc(data.question) + '</strong>' +
      (data.feedback.length ? '<small style="margin:14px 0 0">已有 ' + data.feedback.length + ' 条现场反馈 · 当前状态：' + esc(data.evidenceState.label) + '</small>' : '');
  } catch (error) {
    questionNode.innerHTML = '<small>无法打开</small><strong>' + esc(error.message) + '</strong>';
    form.remove();
  }
}

function setMessage(text, kind) {
  result.textContent = text;
  result.className = 'form-msg' + (kind ? ' ' + kind : '');
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = document.querySelector('#submit');
  const payload = Object.fromEntries(new FormData(form).entries());
  payload.relation = (relationTypes.find((type) => type.code === payload.relationType) || {}).label || '本人到场';
  button.disabled = true;
  setMessage('正在提交…', '');
  try {
    const response = await fetch('/api/cases/' + encodeURIComponent(caseId) + '/feedback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.message || data.error || '提交失败');
    if (data.duplicate) {
      setMessage('已收到。这条内容与已有反馈重复，已标记为重复来源，不会重复计入证据强度。', 'ok');
    } else {
      setMessage('已收到，谢谢。当前案件状态：' + data.evidenceState.label + '（置信度 ' + data.evidenceState.confidence + '%）。', 'ok');
    }
    form.querySelector('textarea').value = '';
    button.disabled = false;
  } catch (error) {
    setMessage(error.message, 'err');
    button.disabled = false;
  }
});

boot();
