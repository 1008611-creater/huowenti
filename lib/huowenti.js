/* 活问题 · 服务端核心逻辑
   ------------------------------------------------------------------
   本模块只做四件事：
   1. 用真实抓取到的知乎公开内容，算出当前问题的内容分布与覆盖不足区；
   2. 把用户自述的一段经历整理成一份可确认的个人贡献卡；
   3. 依据新贡献，说明问题发生了什么变化，并生成下一问；
   4. 判断一个新问题适合启动活问题、已有内容充分、还是边界过宽。
   所有对外数字都来自真实抓取或用户提交，没有来源就不显示数字。
   ------------------------------------------------------------------ */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getCorpus } from './corpus.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const dataDir = path.join(root, 'data');
const storeFile = path.join(dataDir, 'huowenti.json');
const settingsFile = path.join(dataDir, 'llm.json');

/* ---------- 一、固定问题骨架（PRD 第三章） ---------- */

export const SUBTOPICS = [
  { key: 'background', name: '初始背景', need: '学校背景、专业、已有实习和已有项目' },
  { key: 'project', name: '项目经历', need: '项目是否可运行、是否有真实用户、个人贡献是什么' },
  { key: 'apply', name: '投递过程', need: '投递渠道、投递数量、目标公司类型' },
  { key: 'screen', name: '面试筛选', need: '简历反馈、面试阶段、具体淘汰位置' },
  { key: 'company', name: '公司差异', need: '大厂、成熟公司和 AI 创业公司的判断差异' },
  { key: 'result', name: '最终结果与失败过程', need: '最好进度、Offer 情况、做过但没有产生效果的准备' }
];

export const GAPS = [
  {
    key: 'gap-fail',
    title: '普通本科、没有互联网实习者的完整失败过程',
    detail: '当前检索范围内，能读到的是方法与建议，读不到条件普通的人从投递到被拒的完整过程。',
    subtopics: ['background', 'apply', 'result']
  },
  {
    key: 'gap-recruiter',
    title: '招聘参与者对简历淘汰和面试判断的具体说明',
    detail: '当前检索范围内没有来自招聘一侧的内容，求职者只能靠猜测解释自己被淘汰的原因。',
    subtopics: ['screen', 'company']
  },
  {
    key: 'gap-company',
    title: '同一种项目经历在不同公司类型中的实际结果差异',
    detail: '当前检索范围内所有内容都没有区分大厂、成熟公司和 AI 创业公司对同一种项目的反应。',
    subtopics: ['project', 'company']
  }
];

export const QUESTION = {
  id: 'ai-pm-intern-2027',
  title: '2027 届普通本科生找第一段 AI 产品实习到底有多难？',
  subtitle: '一个会主动寻找回答者的问题',
  boundary: '当前内容不足以计算普通本科生获得 AI 产品实习的整体概率。这个问题正在收集不同背景的真实过程，先回答大家通常卡在哪里，以及哪些差异值得继续验证。',
  known: '公开讨论普遍认为项目经历可以帮助学生展示能力，但不同内容对「什么样的项目有效」描述不一致。',
  missing: '普通本科生的失败过程；招聘参与者的判断依据；不同公司类型对同一种项目的反应。',
  seeking: '没有大厂实习、拥有真实项目，并经历过 AI 产品岗位筛选的人。',
  demoIdentity: '演示身份：2027 届普通本科生，曾分享校园产品经历，目前正在投递 AI 产品岗位。',
  matchReason: '你曾分享校园产品和产品实习经历。当前问题缺少「没有大厂经历的普通本科生，怎样获得第一次 AI 产品面试」的真实过程。你可能知道其中一部分。',
  matchConfirm: '这次只希望确认：你的项目在当时是什么状态，以及招聘方实际问到了哪一层。',
  matchCost: '预计 1 至 2 分钟。可以随时退出，也可以选择匿名。',
  demoInput: '普通本科，无互联网实习；主要投递 AI 创业公司；投递 27 份，获得 3 次面试，最好进度二面；做过一个可运行的校园产品，有真实用户。'
};

/* ---------- 二、四类参与身份（PRD 第八章） ---------- */

export const ROLES = {
  seeker: {
    key: 'seeker',
    name: '我正在找第一段 AI 产品实习',
    short: '还在准备中',
    entry: ['background', 'apply'],
    effect: '增加一条需求信号，帮助问题决定下一步优先调查什么，不修改结果性结论。',
    questions: [
      { id: 'school', label: '你现在的学校与专业背景', hint: '例如：普通本科 · 信息管理 · 大三', type: 'text', required: true },
      { id: 'internship', label: '你已经有的实习经历', hint: '没有就写「无」', type: 'text', required: true },
      { id: 'project', label: '你手上正在做的项目', hint: '例如：一个校园二手交易小程序，还没有真实用户', type: 'textarea', required: true },
      { id: 'target', label: '你打算投哪一类公司', hint: '大厂 / 成熟公司 / AI 创业公司，可以多选', type: 'text', required: true },
      { id: 'started', label: '你开始投递了吗', hint: '还没开始 / 刚开始 / 已经投了一段时间', type: 'text', required: true }
    ]
  },
  gained: {
    key: 'gained',
    name: '我已经拿到实习或进入面试',
    short: '有面试或 offer',
    entry: ['project', 'screen', 'result'],
    effect: '补充一条成功路径，同时生成一条寻找条件相近失败者的对照任务。',
    questions: [
      { id: 'school', label: '你的学校与专业背景', hint: '例如：普通本科 · 计算机 · 大四', type: 'text', required: true },
      { id: 'company', label: '给你机会的是哪一类公司', hint: '大厂 / 成熟公司 / AI 创业公司', type: 'text', required: true },
      { id: 'channel', label: '这个机会是通过什么渠道来的', hint: '例如：官网投递、内推、社群、比赛', type: 'text', required: true },
      { id: 'project', label: '你当时最关键的一段项目经历', hint: '说清它能不能运行、有没有真实用户、你负责哪一部分', type: 'textarea', required: true },
      { id: 'progress', label: '你走到过最远的一步', hint: '例如：二面、终面、拿到 offer', type: 'text', required: true },
      { id: 'asked', label: '面试官具体追问过什么', hint: '尽量回忆原话', type: 'textarea', required: true }
    ]
  },
  rejected: {
    key: 'rejected',
    name: '我投递过，但没有结果',
    short: '投了没回音',
    entry: ['apply', 'screen', 'result'],
    effect: '补充一条失败过程，并推动系统区分学历、公司类型、项目可验证性和简历表达。',
    questions: [
      { id: 'school', label: '你的学校与专业背景', hint: '例如：普通本科 · 新闻 · 大三', type: 'text', required: true },
      { id: 'count', label: '你大概投了多少份', hint: '写一个数字就可以', type: 'text', required: true },
      { id: 'channel', label: '主要从哪里投的', hint: '例如：招聘 App、官网、内推、社群', type: 'text', required: true },
      { id: 'company', label: '主要投了哪一类公司', hint: '大厂 / 成熟公司 / AI 创业公司', type: 'text', required: true },
      { id: 'project', label: '你当时的项目状态', hint: '课程作业 / 能运行 / 有真实用户，选一个最接近的', type: 'text', required: true },
      { id: 'stuck', label: '你觉得卡在哪一步', hint: '例如：简历没回音、一面被刷、不知道哪里出问题', type: 'textarea', required: true }
    ]
  },
  recruiter: {
    key: 'recruiter',
    name: '我参与过招聘或面试',
    short: '招聘一侧',
    entry: ['screen', 'company'],
    effect: '补充招聘方视角，验证或推翻求职者对淘汰原因的猜测。',
    questions: [
      { id: 'company', label: '你参与招聘的公司类型', hint: '大厂 / 成熟公司 / AI 创业公司', type: 'text', required: true },
      { id: 'role', label: '招的是哪一类岗位', hint: '例如：AI 产品实习生、产品经理', type: 'text', required: true },
      { id: 'stage', label: '你本人处在哪个环节', hint: '例如：筛简历、一面、终面、用人方复核', type: 'text', required: true },
      { id: 'cut', label: '最常见的淘汰发生在哪里', hint: '尽量具体', type: 'textarea', required: true },
      { id: 'look', label: '你实际会看哪些信息', hint: '例如：项目是否能打开、有没有数据、个人贡献是否写清', type: 'textarea', required: true }
    ]
  }
};

export const ROLE_ORDER = ['gained', 'rejected', 'seeker', 'recruiter'];

export const DEMO_ANSWERS = {
  role: 'gained',
  answers: {
    school: '普通本科 · 某省属高校 · 信息管理 · 大三',
    company: 'AI 创业公司（早期团队，20 人左右）',
    channel: '官网投递，之后被转给用人方直接联系',
    project: '做过一个可运行的校园产品：帮同学拼单和约自习的小程序，上线三个月，注册 400 多人，日活大概 60。我负责需求整理、原型和上线后的迭代，开发由另一位同学完成。',
    progress: '投了 27 份，拿到 3 次面试，最好走到二面，最后拿到一个实习 offer。',
    asked: '面试官先问了这个产品是怎么找到第一批用户的，然后问我具体负责哪一部分，最后问日活和留存数据是不是我自己统计的。'
  },
  followUpAnswer: '面试官更关注产品功能，还是具体的用户数量、使用情况和个人贡献？请回忆一个实际追问。',
  followUpReply: '面试官问过「这个 60 日活是你自己数的还是后台导的」，还问「开发是你做的还是别人做的」。他们更在意数据和个人贡献能不能对上，功能本身反而没怎么问。'
};

/* ---------- 三、真实来源：把抓到的知乎公开内容如实归类 ---------- */

/* 知乎内容 ID 是雪花 ID，可以按官方公布的位规则推算出创建时间。
   接口本身不返回发布时间，因此这里的时间一律标注为「按内容 ID 推算」，
   页面上也会如实显示这个说明，不把它当成接口给出的时间。 */
export function estimateCreatedAt(workId) {
  try {
    const ms = (BigInt(String(workId)) >> 22n) + 1288834974657n;
    const date = new Date(Number(ms));
    if (Number.isNaN(date.getTime())) return null;
    return date.toISOString();
  } catch {
    return null;
  }
}

const SUBTOPIC_KEYWORDS = {
  background: ['学校', '专业', '学历', '本科', '大学生', '应届', '背景', '心理', '主动', '性格', '心态', '目标', '学习', '专注', '注意力', '自我', '习惯'],
  project: ['项目', '作品', '实践', '校园', '产品', '案例', '动手'],
  apply: ['投递', '简历', '求职', '应聘', '渠道', '内推', '招聘会', '岗位'],
  screen: ['面试', '筛选', '笔试', '淘汰', '反馈', '录用', 'offer', 'Offer'],
  company: ['大厂', '公司', '创业', '团队', '行业', '职场', '升职', '发展', '管理', '领导', '同事'],
  result: ['结果', '失败', '倦怠', '拒绝', '薪资', '加薪', '工资', '收入', '晋升', '转行']
};

const QUESTION_KEYWORDS = ['实习', '求职', '面试', '简历', '招聘', '应届', '校招', '职场', '职业', '工作', '大学生', '就业', '升职', '加薪', '职业倦怠', '职业发展', '产品经理'];

/* 归类规则：标题与摘要里出现哪个子命题的关键词最多，就归到哪一条数据带。
   没有任何关键词命中时，如实标为「与问题无直接关联」，不强行塞进地图。 */
export function classifySource(doc) {
  const text = String(doc.title || '') + ' ' + String(doc.description || '');
  let best = null;
  let bestScore = 0;
  let tie = false;
  SUBTOPICS.forEach(function (topic) {
    let score = 0;
    SUBTOPIC_KEYWORDS[topic.key].forEach(function (word) {
      if (text.indexOf(word) !== -1) score += 1;
    });
    if (score > bestScore) { bestScore = score; best = topic.key; tie = false; }
    else if (score === bestScore && score > 0) { tie = true; }
  });
  const relevant = QUESTION_KEYWORDS.some(function (word) { return text.indexOf(word) !== -1; });
  return { subtopic: relevant && best ? best : null, score: bestScore, relevant: relevant, ambiguous: tie };
}

function pickString(value, max) {
  const raw = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  return raw.slice(0, max);
}

/* 体验样本：已全部移除。本产品只呈现真实抓取到的知乎公开内容与当事人确认提交的经历。
   保留这个空数组，是为了让所有统计口径与界面文案保持一致的「零假数据」状态。 */
const EXPERIENCE_SAMPLES = [];

export function listSamples() {
  return EXPERIENCE_SAMPLES.map(function (item) { return Object.assign({}, item); });
}

export async function buildSources() {
  const corpus = await getCorpus({});
  const related = [];
  const excluded = [];
  corpus.docs.forEach(function (doc) {
    const cls = classifySource(doc);
    const created = estimateCreatedAt(doc.workId);
    const date = created ? new Date(created) : null;
    const entry = {
      id: 'zhihu-' + doc.kind + '-' + doc.workId,
      origin: 'zhihu',
      originLabel: '知乎来源',
      layer: 'source',
      kind: doc.kind,
      workId: doc.workId,
      title: pickString(doc.title, 160),
      summary: pickString(doc.description, 200),
      url: doc.url,
      labels: Array.isArray(doc.labels) ? doc.labels.slice(0, 6) : [],
      subtopic: cls.subtopic,
      score: cls.score,
      ambiguous: cls.ambiguous,
      createdAt: created,
      year: date ? date.getUTCFullYear() : null,
      month: date ? date.getUTCMonth() + 1 : null,
      timeSource: 'estimated-from-id',
      timeNote: '接口未提供发布时间，此处按知乎内容 ID 的位规则推算，仅用于展示时间分布。'
    };
    if (cls.relevant && cls.subtopic) related.push(entry);
    else excluded.push(entry);
  });
  return { related: related, excluded: excluded, fetchedAt: corpus.fetchedAt, stale: corpus.stale };
}

export function yearMonth(source) {
  if (!source.year) return '时间未知';
  const month = source.month ? String(source.month).padStart(2, '0') : '01';
  return source.year + '-' + month;
}

export function timeLabel(source) {
  if (!source.year) return '时间未知（接口未提供，且无法从内容 ID 推算）';
  return yearMonth(source) + '（按内容 ID 推算）';
}

/* ---------- 四、贡献卡存储 ---------- */

const memory = {
  loaded: false,
  contributions: [],
  llm: { configured: false, provider: '', model: '', source: '' }
};

async function readJson(file, fallback) {
  try {
    const raw = await fs.readFile(file, 'utf8');
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

async function writeJson(file, value) {
  await fs.mkdir(dataDir, { recursive: true });
  const temporary = file + '.tmp';
  await fs.writeFile(temporary, JSON.stringify(value, null, 2), 'utf8');
  await fs.rename(temporary, file);
}

export async function hydrateStore() {
  const saved = await readJson(storeFile, { contributions: [] });
  memory.contributions = Array.isArray(saved.contributions) ? saved.contributions : [];
  memory.loaded = true;
  await loadLlmConfig();
  return memory.contributions.length;
}

async function loadLlmConfig() {
  const fileConfig = await readJson(settingsFile, null);
  const envKey = String(process.env.HUOWENTI_LLM_KEY || process.env.DEEPSEEK_API_KEY || process.env.OPENAI_API_KEY || '').trim();
  const envBase = String(process.env.HUOWENTI_LLM_BASE || '').trim();
  const envModel = String(process.env.HUOWENTI_LLM_MODEL || '').trim();
  if (envKey) {
    memory.llm = {
      configured: true,
      provider: envBase ? 'custom' : 'deepseek',
      baseUrl: envBase || 'https://api.deepseek.com',
      model: envModel || 'deepseek-chat',
      apiKey: envKey,
      source: 'env'
    };
    return;
  }
  if (fileConfig && String(fileConfig.apiKey || '').trim()) {
    memory.llm = {
      configured: true,
      provider: pickString(fileConfig.provider, 40) || 'deepseek',
      baseUrl: pickString(fileConfig.baseUrl, 200) || 'https://api.deepseek.com',
      model: pickString(fileConfig.model, 80) || 'deepseek-chat',
      apiKey: String(fileConfig.apiKey).trim(),
      source: 'file'
    };
    return;
  }
  memory.llm = { configured: false, provider: '', baseUrl: '', model: '', apiKey: '', source: '' };
}

export async function reloadLlmConfig() {
  await loadLlmConfig();
  return llmStatus();
}

export function llmStatus() {
  return {
    configured: Boolean(memory.llm.configured),
    provider: memory.llm.provider || '',
    model: memory.llm.model || '',
    source: memory.llm.source || '',
    note: memory.llm.configured
      ? '已配置语言模型：追问与整理会调用真实模型，并限制只能使用你提供的信息。'
      : '未配置语言模型：追问与整理由本地规则生成，同样只使用你提供的信息，不会补充未提供的事实。'
  };
}

export function listContributions() {
  return memory.contributions.map(function (item) { return Object.assign({}, item); });
}

export function findContribution(id) {
  return memory.contributions.find(function (item) { return item.id === id; }) || null;
}

export async function addContribution(item) {
  memory.contributions.unshift(item);
  await writeJson(storeFile, { savedAt: new Date().toISOString(), contributions: memory.contributions.slice(0, 2000) });
  return item;
}

export async function removeContribution(id) {
  const index = memory.contributions.findIndex(function (item) { return item.id === id; });
  if (index === -1) return false;
  memory.contributions.splice(index, 1);
  await writeJson(storeFile, { savedAt: new Date().toISOString(), contributions: memory.contributions.slice(0, 2000) });
  return true;
}


/* ==================================================================
   五、调查结论状态机
   结论只由两类东西生成：真实抓取到的知乎公开内容，以及用户确认过的贡献卡。
   没有任何来源时如实显示「当前检索范围内覆盖不足」，不给数字、不给概率。
   ================================================================== */

const SUBTOPIC_BY_KEY = {};
SUBTOPICS.forEach(function (item) { SUBTOPIC_BY_KEY[item.key] = item; });

export function subtopicName(key) {
  const item = SUBTOPIC_BY_KEY[key];
  return item ? item.name : key;
}

function cellKey(subtopic, year) {
  return String(subtopic) + '@' + String(year);
}

function safeText(value, max) {
  return pickString(value, max || 400);
}

function answerText(answers) {
  const source = answers && typeof answers === 'object' ? answers : {};
  return Object.keys(source).map(function (key) { return String(source[key] == null ? '' : source[key]); }).join(' ');
}

/* 贡献卡实际触及了哪些子命题：以身份入口为骨架，再按用户真正写下的内容补充。
   补充只依据用户原文里的词，不做任何推测。 */
const EXTRA_RULES = [
  { key: 'company', words: ['大厂', '成熟公司', '创业公司', 'AI 创业', '公司类型', '互联网公司', '外企', '国企'] },
  { key: 'project', words: ['项目', '小程序', '作品', '上线', '产品'] },
  { key: 'apply', words: ['投递', '简历', '内推', '招聘 App', '渠道', '官网'] },
  { key: 'screen', words: ['面试', '一面', '二面', '终面', '筛选', '笔试', '被刷', '淘汰'] },
  { key: 'result', words: ['offer', 'Offer', 'offer', '录用', '没有结果', '没回音', '失败', '拒绝'] },
  { key: 'background', words: ['本科', '专科', '硕士', '专业', '学校', '大三', '大四', '应届'] }
];

export function contributionSubtopics(item) {
  const role = ROLES[item && item.roleKey];
  const base = role ? role.entry.slice() : [];
  const text = answerText(item && item.answers);
  const extra = [];
  EXTRA_RULES.forEach(function (rule) {
    if (base.indexOf(rule.key) !== -1) return;
    const hit = rule.words.some(function (word) { return text.indexOf(word) !== -1; });
    if (hit) extra.push(rule.key);
  });
  return { primary: base, extra: extra, all: base.concat(extra) };
}

/* 把一段贡献原文拆成可核对的事实条目。只搬运用户写下的内容，不补充任何信息。 */
export function buildContributionCard(roleKey, answers) {
  const role = ROLES[roleKey];
  if (!role) return null;
  const facts = [];
  role.questions.forEach(function (question) {
    const raw = safeText(answers ? answers[question.id] : '', 600);
    if (!raw) return;
    facts.push({ field: question.id, label: question.label, value: raw });
  });
  return {
    roleKey: roleKey,
    roleName: role.name,
    subtopics: contributionSubtopics({ roleKey: roleKey, answers: answers }).all,
    facts: facts,
    factCount: facts.length,
    statement: '这是一份个人经历，不代表行业整体情况。确认后，它将进入当前调查，不会自动发布成知乎回答。'
  };
}

/* ---------- 覆盖度统计 ---------- */

function emptyStat(key) {
  return {
    key: key,
    name: subtopicName(key),
    need: (SUBTOPIC_BY_KEY[key] || {}).need || '',
    realCount: 0,
    sampleCount: 0,
    contributionCount: 0,
    totalCount: 0,
    years: {},
    evidenceState: 'empty',
    evidenceLabel: '当前检索范围内覆盖不足'
  };
}

export async function buildCoverage() {
  const sources = await buildSources();
  const stats = {};
  SUBTOPICS.forEach(function (topic) { stats[topic.key] = emptyStat(topic.key); });

  sources.related.forEach(function (item) {
    const stat = stats[item.subtopic];
    if (!stat) return;
    stat.realCount += 1;
    if (item.year) stat.years[item.year] = (stat.years[item.year] || 0) + 1;
  });

  listSamples().forEach(function (sample) {
    const stat = stats[sample.subtopic];
    if (!stat) return;
    stat.sampleCount += 1;
    if (sample.year) stat.years[sample.year] = (stat.years[sample.year] || 0) + 1;
  });

  listContributions().forEach(function (item) {
    const touched = contributionSubtopics(item);
    touched.all.forEach(function (key) {
      const stat = stats[key];
      if (!stat) return;
      stat.contributionCount += 1;
      const year = new Date(item.createdAt || Date.now()).getUTCFullYear();
      stat.years[year] = (stat.years[year] || 0) + 1;
    });
  });

  Object.keys(stats).forEach(function (key) {
    const stat = stats[key];
    stat.totalCount = stat.realCount + stat.sampleCount + stat.contributionCount;
    if (stat.contributionCount >= 2) {
      stat.evidenceState = 'multi-case';
      stat.evidenceLabel = '已有多份个人经历，可以开始比较条件差异';
    } else if (stat.contributionCount === 1) {
      stat.evidenceState = 'single-case';
      stat.evidenceLabel = '只有一份个人经历，还不能说明普遍情况';
    } else if (stat.realCount > 0) {
      stat.evidenceState = 'public-only';
      stat.evidenceLabel = '只有公开讨论，缺少当事人提供的完整过程';
    } else {
      stat.evidenceState = 'empty';
      stat.evidenceLabel = '当前检索范围内覆盖不足';
    }
  });

  return { stats: stats, sources: sources };
}

/* ---------- 当前认识 / 适用条件 / 相反经历 / 仍未解决 ---------- */

export async function buildConclusions() {
  const coverage = await buildCoverage();
  const stats = coverage.stats;
  const contributions = listContributions();

  const items = SUBTOPICS.map(function (topic) {
    const stat = stats[topic.key];
    const related = coverage.sources.related.filter(function (item) { return item.subtopic === topic.key; });
    const mine = contributions.filter(function (item) {
      return contributionSubtopics(item).all.indexOf(topic.key) !== -1;
    });

    const current = [];
    if (stat.realCount > 0) {
      current.push('公开讨论里与「' + topic.name + '」相关的内容有 ' + stat.realCount + ' 条，覆盖的时间是 ' + describeYears(stat.years, related) + '。');
      current.push('这些内容提供的是方法和观点，没有一条写清一个具体的人在这一步的完整经过。');
    } else {
      current.push('当前检索范围内，没有找到与「' + topic.name + '」直接相关的公开讨论。');
    }
    if (mine.length > 0) {
      current.push('已有 ' + mine.length + ' 份当事人提交的经历进入这一条。');
    }

    const conditions = [];
    mine.forEach(function (item) {
      const text = answerText(item.answers);
      const marks = [];
      ['本科', '专科', '硕士', '大厂', '创业公司', '成熟公司', '无实习', '有实习', '有真实用户', '课程作业'].forEach(function (word) {
        if (text.indexOf(word) !== -1) marks.push(word);
      });
      if (marks.length > 0) conditions.push({ contributionId: item.id, marks: marks });
    });

    const contrast = [];
    for (let i = 0; i < mine.length; i += 1) {
      for (let j = i + 1; j < mine.length; j += 1) {
        const a = mine[i];
        const b = mine[j];
        const aOutcome = outcomeOf(a);
        const bOutcome = outcomeOf(b);
        if (!aOutcome || !bOutcome || aOutcome === bOutcome) continue;
        const shared = sharedMarks(a, b);
        if (shared.length === 0) continue;
        contrast.push({
          aId: a.id,
          bId: b.id,
          shared: shared,
          aOutcome: aOutcome,
          bOutcome: bOutcome,
          note: '两份经历在「' + shared.join('、') + '」上条件相近，结果却相反，值得继续追问。'
        });
      }
    }

    const open = [];
    if (stat.realCount === 0) open.push('这一条在公开内容里完全没有对应讨论。');
    if (mine.length === 0) open.push('还没有当事人提供这一步的完整过程。');
    else if (mine.length === 1) open.push('只有一份经历，无法判断它是个别情况还是普遍情况。');
    if (contrast.length > 0) open.push('已经出现条件相近但结果相反的记录，需要继续补充同类人来判断分界在哪里。');
    if (open.length === 0) open.push('这一步已经有多份经历，下一步是核对条件相近但结果相反的记录。');

    return {
      key: topic.key,
      name: topic.name,
      need: topic.need,
      evidenceState: stat.evidenceState,
      evidenceLabel: stat.evidenceLabel,
      counts: {
        real: stat.realCount,
        sample: stat.sampleCount,
        contribution: stat.contributionCount,
        total: stat.totalCount
      },
      current: current,
      conditions: conditions,
      contrast: contrast,
      open: open,
      sources: related.map(function (item) { return publicSource(item); }),
      contributions: mine.map(function (item) { return publicContribution(item); })
    };
  });

  return {
    question: QUESTION,
    generatedAt: new Date().toISOString(),
    corpus: {
      fetchedAt: coverage.sources.fetchedAt,
      stale: coverage.sources.stale,
      related: coverage.sources.related.length,
      excluded: coverage.sources.excluded.length
    },
    items: items,
    headline: headlineOf(items)
  };
}

function describeYears(years, related) {
  const list = Object.keys(years).map(function (value) { return Number(value); }).sort(function (a, b) { return a - b; });
  if (list.length === 0) return '时间无法确定';
  const withTime = related.filter(function (item) { return item.year; }).length;
  const label = list.join('、') + ' 年';
  return withTime === related.length ? label + '（按内容 ID 推算）' : label + '（部分内容无法推算时间）';
}

function outcomeOf(item) {
  const text = answerText(item.answers);
  if (/没有结果|没回音|没消息|被拒|失败|都没有|石沉大海/.test(text)) return 'negative';
  if (/offer|Offer|录用|拿到|通过|进入面试|二面|终面/.test(text)) return 'positive';
  return '';
}

function sharedMarks(a, b) {
  const words = ['本科', '专科', '硕士', '大厂', '创业公司', '成熟公司', '无实习', '有实习', '有真实用户', '课程作业'];
  const ta = answerText(a.answers);
  const tb = answerText(b.answers);
  return words.filter(function (word) { return ta.indexOf(word) !== -1 && tb.indexOf(word) !== -1; });
}

function publicSource(item) {
  return {
    id: item.id,
    title: item.title,
    url: item.url,
    origin: 'zhihu',
    originLabel: '知乎来源',
    timeLabel: timeLabel(item),
    timeNote: item.timeNote
  };
}

function publicContribution(item) {
  return {
    id: item.id,
    roleKey: item.roleKey,
    roleName: item.roleName,
    createdAt: item.createdAt,
    subtopics: contributionSubtopics(item).all,
    anonymous: Boolean(item.anonymous),
    facts: (item.card && item.card.facts ? item.card.facts : []).map(function (fact) {
      return { label: fact.label, value: fact.value };
    })
  };
}

function headlineOf(items) {
  const empty = items.filter(function (item) { return item.counts.real === 0; });
  const noContribution = items.filter(function (item) { return item.counts.contribution === 0; });
  const parts = [];
  parts.push('当前问题在公开内容里能找到 ' + items.reduce(function (sum, item) { return sum + item.counts.real; }, 0) + ' 条相关讨论。');
  if (empty.length > 0) parts.push('其中 ' + empty.length + ' 条子命题在公开内容里完全没有对应讨论。');
  if (noContribution.length > 0) parts.push('还有 ' + noContribution.length + ' 条子命题没有任何当事人提交经历。');
  parts.push('这份结论会随着新经历进入持续更新。');
  return parts.join('');
}


/* ==================================================================
   六、一份新经历进入后，问题发生了什么变化
   变化只对比「进入前」和「进入后」两次真实统计，不做任何夸大。
   ================================================================== */

export async function snapshotCoverage() {
  const coverage = await buildCoverage();
  const map = {};
  SUBTOPICS.forEach(function (topic) {
    const stat = coverage.stats[topic.key];
    map[topic.key] = {
      real: stat.realCount,
      sample: stat.sampleCount,
      contribution: stat.contributionCount,
      evidenceState: stat.evidenceState
    };
  });
  return map;
}

export function diffCoverage(before, after) {
  const changes = [];
  SUBTOPICS.forEach(function (topic) {
    const a = before[topic.key];
    const b = after[topic.key];
    if (!a || !b) return;
    const delta = b.contribution - a.contribution;
    if (delta <= 0 && a.evidenceState === b.evidenceState) return;
    changes.push({
      key: topic.key,
      name: topic.name,
      contributionDelta: delta,
      beforeState: a.evidenceState,
      afterState: b.evidenceState,
      beforeLabel: stateLabel(a.evidenceState, a.contribution),
      afterLabel: stateLabel(b.evidenceState, b.contribution),
      reason: changeReason(topic, a, b)
    });
  });
  return changes;
}

function stateLabel(state, count) {
  if (state === 'multi-case') return '已有 ' + count + ' 份个人经历，可以开始比较条件差异';
  if (state === 'single-case') return '有 1 份个人经历，还不能说明普遍情况';
  if (state === 'public-only') return '只有公开讨论，缺少当事人提供的完整过程';
  return '当前检索范围内覆盖不足';
}

function changeReason(topic, before, after) {
  if (before.contribution === 0 && after.contribution === 1) {
    return '「' + topic.name + '」第一次有了当事人提供的完整过程，此前只有公开讨论或完全没有内容。';
  }
  if (before.evidenceState !== after.evidenceState) {
    return '「' + topic.name + '」从「' + stateLabel(before.evidenceState, before.contribution) + '」变成「' + stateLabel(after.evidenceState, after.contribution) + '」。';
  }
  return '「' + topic.name + '」新增 1 份经历，可以开始和已有记录对照。';
}

/* ---------- 下一问：问谁 / 问什么 / 为什么 ---------- */

/* 一段贡献里的结果方向：只按用户自己写下的词判断，不做推测。 */
function contributionOutcome(item) {
  return outcomeOf(item);
}

/* 一段贡献里出现过的条件标记。 */
function marksOf(item) {
  const text = answerText(item && item.answers);
  return ['本科', '专科', '硕士', '大厂', '创业公司', '成熟公司', '无实习', '有实习', '有真实用户', '课程作业']
    .filter(function (word) { return text.indexOf(word) !== -1; });
}

/* 一个缺口是否真的被补上：必须由对应身份的当事人提供，不能靠别的身份顺带覆盖。
   gap-fail      → 需要有「投递过但没有结果」的人，或明确写了负面结果的求职者
   gap-recruiter → 需要有「参与过招聘或面试」的人
   gap-company   → 需要两种以上公司类型下、同一种项目经历的记录 */
function gapClosedBy(gapKey, contributions) {
  if (gapKey === 'gap-recruiter') {
    return contributions.some(function (item) { return item.roleKey === 'recruiter'; });
  }
  if (gapKey === 'gap-fail') {
    return contributions.some(function (item) {
      if (item.roleKey === 'rejected') return true;
      return item.roleKey === 'seeker' && contributionOutcome(item) === 'negative';
    });
  }
  if (gapKey === 'gap-company') {
    const types = [];
    contributions.forEach(function (item) {
      const text = answerText(item.answers);
      const mark = [];
      if (text.indexOf('大厂') !== -1) mark.push('big');
      if (text.indexOf('成熟公司') !== -1) mark.push('mature');
      if (text.indexOf('创业公司') !== -1 || text.indexOf('AI 创业') !== -1) mark.push('startup');
      mark.forEach(function (key) { if (types.indexOf(key) === -1) types.push(key); });
    });
    return types.length >= 2;
  }
  return false;
}

export async function buildNextQuestion(contribution) {
  const coverage = await buildCoverage();
  const conclusions = await buildConclusions();
  const contributions = listContributions();
  const mine = contributionSubtopics(contribution || { roleKey: 'seeker', answers: {} });

  /* 第一优先：已经出现条件相近但结果相反的记录，先找同类人验证分界。 */
  const contrast = [];
  conclusions.items.forEach(function (item) {
    item.contrast.forEach(function (pair) { contrast.push({ subtopic: item.name, pair: pair }); });
  });
  if (contrast.length > 0) {
    const first = contrast[0];
    return {
      kind: 'contrast',
      who: '和这两份经历条件相近的人',
      what: '在「' + first.subtopic + '」这一步，你遇到的结果和其中哪一份更接近，中间还有什么差别？',
      why: '已经出现「' + first.pair.shared.join('、') + '」相同但结果相反的记录，需要同类经历来判断真正的分界在哪里。',
      subtopics: []
    };
  }

  /* 第二优先：刚进入的这段经历有明确结果方向，但还没有条件相近、结果相反的人。
     这一问用来区分：是项目本身、简历表达，还是公司类型造成了不同结果。 */
  const myOutcome = contributionOutcome(contribution);
  if (myOutcome) {
    const hasCounterpart = contributions.some(function (item) {
      if (item.id === (contribution && contribution.id)) return false;
      const other = contributionOutcome(item);
      return other && other !== myOutcome;
    });
    if (!hasCounterpart) {
      const myMarks = marksOf(contribution);
      const sharedLabel = myMarks.length > 0 ? myMarks.slice(0, 4).join('、') : '项目状态和投递过程';
      const wantPositive = myOutcome === 'negative';
      return {
        kind: 'contrast',
        who: wantPositive
          ? '条件相近、但已经进入面试或拿到机会的人'
          : '同样拥有可运行项目和真实用户，但没有获得 AI 产品面试的人',
        what: wantPositive
          ? '你的条件和这份经历接近吗？你做对了哪一步，中间有什么不同？'
          : '你的项目状态和投递过程和这份经历接近吗？你卡在哪一步，中间有什么不同？',
        why: '当前调查里只有「' + sharedLabel + '」这一种结果方向的记录，还没有条件相近但结果相反的当事人。'
          + '这类经历才能帮助区分项目本身、简历表达和公司类型的影响。',
        subtopics: mine.all
      };
    }
  }

  /* 第三优先：三个首轮缺口里，按身份判断仍然没有当事人经历的那一个。 */
  for (let i = 0; i < GAPS.length; i += 1) {
    const gap = GAPS[i];
    if (gapClosedBy(gap.key, contributions)) continue;
    const missingNames = gap.subtopics.map(subtopicName).join('和');
    return {
      kind: 'gap',
      gapKey: gap.key,
      who: gap.key === 'gap-recruiter' ? '参与过招聘或面试的人' : (gap.key === 'gap-company' ? '在两类以上公司投递过同一种项目的人' : '条件普通、投递过但没有结果的人'),
      what: gap.key === 'gap-recruiter'
        ? '你在筛简历或面试时，实际会因为什么原因淘汰一个学生？'
        : (gap.key === 'gap-company'
          ? '同一段项目经历，在不同类型的公司那里得到的反馈有什么不同？'
          : '从开始投递到被拒，中间每一步具体发生了什么？'),
      why: '当前检索范围内，「' + gap.title + '」仍然没有对应身份的当事人提供完整过程。这一问会补上' + missingNames + '。',
      subtopics: gap.subtopics
    };
  }

  /* 第四优先：找到覆盖最薄的子命题，继续补充。 */
  const thinnest = SUBTOPICS.map(function (topic) {
    const stat = coverage.stats[topic.key];
    return { topic: topic, score: stat.realCount + stat.contributionCount * 3 + stat.sampleCount };
  }).sort(function (a, b) { return a.score - b.score; })[0];

  const thinStat = coverage.stats[thinnest.topic.key];
  return {
    kind: 'thin',
    who: '经历过「' + thinnest.topic.name + '」的人',
    what: '你在「' + thinnest.topic.name + '」这一步具体做了什么，结果是什么？',
    why: '这一条目前只有 ' + thinStat.realCount + ' 条公开内容、' + thinStat.contributionCount + ' 份当事人经历，是当前最薄的一处。它需要的是：' + thinnest.topic.need + '。',
    subtopics: [thinnest.topic.key]
  };
}

/* ==================================================================
   七、追问：必须基于用户刚写下的内容，且只能使用他提供的信息
   ================================================================== */

const FOLLOWUP_RULES = [
  {
    key: 'data-method',
    test: function (text) { return /[0-9０-９]+\s*(人|个|份|次|%|日活|留存|注册|用户)/.test(text) && !/(后台|后台数据|统计口径|导出来|数据后台|自己数|怎么算|如何统计)/.test(text); },
    ask: '你提到的这个数字，是从哪里得到的？是后台导出、自己统计，还是估算？',
    why: '数字本身说明不了什么，来源决定它能不能被别人核对。'
  },
  {
    key: 'own-part',
    test: function (text) { return /(项目|小程序|产品|作品|App|app)/.test(text) && !/(我负责|我做的|我写|我设计|我整理|由我|我自己|另一位同学|开发由)/.test(text); },
    ask: '这段项目里，哪一部分是你本人做的？哪一部分是别人做的？',
    why: '招聘方判断的是个人贡献，而项目整体做得再好，也不能说明你做了哪一层。'
  },
  {
    key: 'real-user',
    test: function (text) { return /(项目|小程序|产品|作品)/.test(text) && !/(真实用户|用户|上线|发布|投入使用)/.test(text); },
    ask: '这个项目当时有人真的在用吗？如果有，大概是什么规模？',
    why: '「能不能运行」和「有没有人用」是两种完全不同的状态，招聘方在意的往往是后者。'
  },
  {
    key: 'interview-detail',
    test: function (text) { return /(面试|一面|二面|终面)/.test(text) && !/(问|追问|提问|让我说|考)/.test(text); },
    ask: '面试官当时具体追问了什么？尽量回忆他问的原话。',
    why: '「面试没通过」和「他问到了哪一层」是两件事，后者才是能帮到别人的信息。'
  },
  {
    key: 'stage',
    test: function (text) { return /(投递|投了|投过)/.test(text) && !/(一面|二面|终面|笔试|初筛|简历关|没有回音|没回音|已读不回|offer)/.test(text); },
    ask: '这些投递里，你走到过最远的一步是哪里？其余的卡在了哪一步？',
    why: '「投了很多」需要拆成每一步的通过情况，才能看出卡点在哪里。'
  },
  {
    key: 'channel',
    test: function (text) { return /(投递|投了|投过|应聘)/.test(text) && !/(官网|内推|招聘 App|招聘App|Boss|BOSS|猎聘|拉勾|社群|公众号|校园招聘|校招网)/.test(text); },
    ask: '你主要是从哪个渠道投的？这些渠道里哪一个给过回应？',
    why: '同一个人的同一份简历，走不同渠道得到的反馈可能完全不同。'
  },
  {
    key: 'company-type',
    test: function (text) { return /(公司|投了|投递)/.test(text) && !/(大厂|成熟公司|创业公司|互联网公司|外企|国企|初创)/.test(text); },
    ask: '你投的公司里，大厂、成熟公司和 AI 创业公司各占多少？它们的反馈有区别吗？',
    why: '当前最缺的一处，正是同一种项目在不同类型公司得到的反应差异。'
  },
  {
    key: 'outcome',
    test: function (text) { return text.length > 40 && !/(offer|Offer|录用|拿到|通过|没有结果|没回音|被拒|失败|放弃)/.test(text); },
    ask: '这段经历最后的结果是什么？是拿到机会、被拒绝，还是到现在还没有回音？',
    why: '没有结果的经过同样重要，它能说明卡点在哪一步。'
  }
];

export function ruleFollowUp(roleKey, answers) {
  const role = ROLES[roleKey];
  const text = answerText(answers);
  for (let i = 0; i < FOLLOWUP_RULES.length; i += 1) {
    const rule = FOLLOWUP_RULES[i];
    if (rule.test(text)) {
      return { question: rule.ask, reason: rule.why, source: 'rule', ruleKey: rule.key, basedOn: snippetOf(text) };
    }
  }
  /* 没有触发任何规则时，问「这一步的判断依据」，同样只针对他写下的内容。 */
  const need = role && role.entry.length > 0 ? (SUBTOPIC_BY_KEY[role.entry[0]] || {}).need : '这段经历的完整过程';
  return {
    question: '你说的这段经历里，当时你自己最不确定的是什么？',
    reason: '这一问针对的是「' + (need || '这段经历') + '」，也就是当前最难从公开内容里读到的部分。',
    source: 'rule',
    ruleKey: 'uncertainty',
    basedOn: snippetOf(text)
  };
}

function snippetOf(text) {
  const raw = String(text || '').replace(/\s+/g, ' ').trim();
  return raw.length > 60 ? raw.slice(0, 60) + '…' : raw;
}

/* ---------- 调用真实模型（只有配置了 Key 才会走这条路） ---------- */

async function callLlm(messages, maxTokens) {
  const cfg = memory.llm;
  if (!cfg.configured || !cfg.apiKey) return null;
  const base = String(cfg.baseUrl || '').replace(/\/+$/, '');
  const url = /\/v1$/.test(base) ? base + '/chat/completions' : base + '/v1/chat/completions';
  const controller = new AbortController();
  const timer = setTimeout(function () { controller.abort(); }, 25000);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + cfg.apiKey },
      body: JSON.stringify({
        model: cfg.model,
        messages: messages,
        temperature: 0.2,
        max_tokens: maxTokens || 600
      }),
      signal: controller.signal
    });
    if (!response.ok) return null;
    const data = await response.json();
    const choice = data && data.choices && data.choices[0];
    const content = choice && choice.message ? choice.message.content : '';
    const text = String(content || '').trim();
    return text || null;
  } catch (error) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

const LLM_SYSTEM = [
  '你在帮助一个公共调查项目向当事人提问。',
  '严格约束：',
  '1. 只能使用用户已经写下的信息，不得补充、推测或虚构任何事实、数字、公司名或经历。',
  '2. 不得给出概率、百分比、行业整体判断，不得说「大多数人」「普遍认为」。',
  '3. 不得评价用户的对错，不得给建议或鼓励。',
  '4. 只输出一个追问，问的是「只有这个人知道、而公开内容里读不到」的具体细节。',
  '5. 用中文，一句话，不超过 60 字，直接是问题本身，不要任何前缀或解释。'
].join('\n');

export async function generateFollowUp(roleKey, answers) {
  const role = ROLES[roleKey];
  const lines = [];
  if (role) {
    role.questions.forEach(function (question) {
      const value = safeText(answers ? answers[question.id] : '', 500);
      if (value) lines.push(question.label + '：' + value);
    });
  }
  if (lines.length === 0) return ruleFollowUp(roleKey, answers);

  const llm = await callLlm([
    { role: 'system', content: LLM_SYSTEM },
    { role: 'user', content: '这个人参与的身份是：' + (role ? role.name : '未知') + '\n他写下的内容：\n' + lines.join('\n') + '\n\n请只根据以上内容，提出一个追问。' }
  ], 200);

  if (llm) {
    const cleaned = llm.replace(/^["「『]|["」』]$/g, '').split('\n')[0].trim().slice(0, 120);
    if (cleaned) {
      const fallback = ruleFollowUp(roleKey, answers);
      return {
        question: cleaned,
        reason: '这一问由语言模型根据你写下的内容生成，只使用你提供的信息。' + (fallback.reason ? '（同时命中的规则方向：' + fallback.reason + '）' : ''),
        source: 'llm',
        ruleKey: fallback.ruleKey,
        basedOn: fallback.basedOn
      };
    }
  }
  return ruleFollowUp(roleKey, answers);
}

/* ---------- 贡献卡整理：把回答整理成事实卡，不添加任何未提供的信息 ---------- */

export function buildCardFromAnswers(roleKey, answers, followUp) {
  const role = ROLES[roleKey];
  if (!role) return null;
  const facts = [];
  role.questions.forEach(function (question) {
    const value = safeText(answers ? answers[question.id] : '', 600);
    if (!value) return;
    facts.push({ field: question.id, label: question.label, value: value, origin: 'user' });
  });
  if (followUp && followUp.answer) {
    const value = safeText(followUp.answer, 600);
    if (value) {
      facts.push({
        field: 'followUp',
        label: followUp.question || '追问',
        value: value,
        origin: 'user',
        followUp: true
      });
    }
  }
  const touched = contributionSubtopics({ roleKey: roleKey, answers: answers });
  return {
    roleKey: roleKey,
    roleName: role.name,
    roleShort: role.short,
    subtopics: touched.all,
    primarySubtopics: touched.primary,
    extraSubtopics: touched.extra,
    facts: facts,
    factCount: facts.length,
    statement: '这是一份个人经历，不代表行业整体情况。确认后，它将进入当前调查，不会自动发布成知乎回答。'
  };
}

/* ==================================================================
   八、提出新问题：三态判定
   判定依据全部可复算：问题文本结构 + 当前真实语料覆盖 + 真实热榜命中。
   ================================================================== */

const BROAD_WORDS = ['所有', '一切', '全部', '任何', '人生', '世界', '社会', '人类', '未来', '年轻人', '大家', '怎么才能', '如何成功'];
const CONCRETE_WORDS = ['实习', '面试', '投递', '简历', 'offer', '校招', '转行', '考研', '考公', '跳槽', '薪资', '专业', '岗位', '公司', '创业', '留学', '毕业', '入职', '试用期', '裁员', '远程', '兼职'];
const BOUNDARY_WORDS = ['届', '年', '本科', '硕士', '专科', '大厂', '创业公司', '国企', '外企', '一线', '二线', '应届', '第一份', '第一段', '普通'];

export function judgeNewQuestion(rawText) {
  const text = String(rawText || '').replace(/\s+/g, ' ').trim();
  const reasons = [];
  const signals = { length: text.length, concrete: [], boundary: [], broad: [] };

  if (!text) {
    return {
      state: 'too-broad',
      label: '边界过宽',
      summary: '还没有写下具体问题，无法判断它能不能启动。',
      reasons: ['问题为空。'],
      nextStep: '把它写成一句具体的问题：谁、在什么阶段、卡在什么事情上。',
      signals: signals
    };
  }

  CONCRETE_WORDS.forEach(function (word) { if (text.indexOf(word) !== -1) signals.concrete.push(word); });
  BOUNDARY_WORDS.forEach(function (word) { if (text.indexOf(word) !== -1) signals.boundary.push(word); });
  BROAD_WORDS.forEach(function (word) { if (text.indexOf(word) !== -1) signals.broad.push(word); });

  if (signals.concrete.length === 0) reasons.push('问题里没有一个可以界定的具体场景，读的人无法判断自己算不算当事人。');
  if (signals.boundary.length === 0) reasons.push('问题里没有限定条件，任何人都可以回答，也就无法比较不同条件下的差异。');
  if (signals.broad.length > 0) reasons.push('问题里出现了「' + signals.broad.join('、') + '」这类覆盖范围过大的说法。');
  if (text.length < 8) reasons.push('问题过短，缺少可以拆成子命题的信息。');
  if (text.length > 80) reasons.push('问题过长，里面可能混着好几个不同的问题，需要拆开。');

  const tooBroad = signals.concrete.length === 0 || signals.broad.length > 0 || text.length < 8 || (signals.boundary.length === 0 && signals.concrete.length < 2);
  if (tooBroad) {
    return {
      state: 'too-broad',
      label: '边界过宽',
      summary: '这个问题现在还不适合启动，因为没法判断谁是当事人，也没法比较不同条件下的差异。',
      reasons: reasons,
      nextStep: '收窄成一句：限定一群人、一个阶段、一件具体的事。例如把「怎么找到好工作」改成「普通本科应届生投 AI 产品岗，简历关卡在哪里」。',
      signals: signals
    };
  }

  /* 具体场景成立后，再看当前真实抓取范围内是否已经覆盖充分。 */
  const corpusHit = currentCorpusHits(text);
  if (corpusHit.count >= 3) {
    return {
      state: 'saturated',
      label: '已有内容充分',
      summary: '当前抓取到的公开内容里，已经能找到 ' + corpusHit.count + ' 条与这个问题直接相关的内容，其中一部分已经写到了具体过程。',
      reasons: [
        '当前语料库中命中的内容：' + corpusHit.titles.slice(0, 3).join('；') + '。',
        '这类问题更适合先读完已有内容，再找出仍然缺失的那一小块。'
      ],
      nextStep: '把问题再收窄一层，指向一个公开内容里没有写清的环节，例如「同一段项目经历在不同类型公司得到的反馈差异」。',
      signals: signals,
      corpusHit: corpusHit
    };
  }

  return {
    state: 'ready',
    label: '适合启动',
    summary: '这个问题有具体场景和限定条件，而当前抓取到的公开内容里只有 ' + corpusHit.count + ' 条相关讨论，且没有写到完整过程。',
    reasons: [
      corpusHit.count === 0
        ? '当前抓取范围内没有与它直接相关的内容。'
        : '当前抓取范围内只有 ' + corpusHit.count + ' 条相关讨论，都是观点和方法，没有完整过程。',
      '它已经能拆出可比较的条件：' + (signals.boundary.length > 0 ? signals.boundary.join('、') : '需要补充限定条件') + '。',
      '可以按六条固定子命题拆开调查。'
    ],
    nextStep: '启动后，先按六个子命题收集真实经历，优先找「公开内容里完全没有对应讨论」的那一条。',
    signals: signals,
    corpusHit: corpusHit
  };
}

function currentCorpusHits(text) {
  const corpus = memory.corpusCache;
  const titles = [];
  let count = 0;
  if (corpus && Array.isArray(corpus.docs)) {
    corpus.docs.forEach(function (doc) {
      const hay = String(doc.title || '') + ' ' + String(doc.description || '');
      const hit = QUESTION_KEYWORDS.some(function (word) { return text.indexOf(word) !== -1 && hay.indexOf(word) !== -1; });
      if (hit) { count += 1; if (titles.length < 5) titles.push(pickString(doc.title, 60)); }
    });
  }
  return { count: count, titles: titles, total: corpus && corpus.docs ? corpus.docs.length : 0 };
}

export async function loadCorpusCache() {
  const corpus = await getCorpus({});
  memory.corpusCache = corpus;
  return corpus;
}

/* ==================================================================
   九、当前调查结论 → 可继续形成的知乎回答草稿
   草稿只由已确认的内容拼成，不添加任何没有来源的句子。
   ================================================================== */

export async function buildAnswerDraft() {
  const conclusions = await buildConclusions();
  const lines = [];
  lines.push(QUESTION.title);
  lines.push('');
  lines.push('先说清楚这份回答的边界：' + QUESTION.boundary);
  lines.push('');
  lines.push('一、目前公开内容里能读到什么');
  conclusions.items.forEach(function (item) {
    const found = item.current.filter(function (line) { return line.indexOf('公开讨论里') === 0 || line.indexOf('当前检索范围内') === 0; });
    if (found.length === 0) return;
    lines.push('· ' + item.name + '：' + found.join(''));
  });
  lines.push('');
  lines.push('二、已经有人补充的经历');
  const withContribution = conclusions.items.filter(function (item) { return item.counts.contribution > 0; });
  if (withContribution.length === 0) {
    lines.push('目前还没有当事人提交经历。这一部分会随着新经历进入自动更新。');
  } else {
    withContribution.forEach(function (item) {
      lines.push('· ' + item.name + '：已有 ' + item.counts.contribution + ' 份当事人经历。');
      item.contributions.forEach(function (entry) {
        entry.facts.forEach(function (fact) {
          lines.push('  — ' + fact.label + '：' + fact.value);
        });
      });
    });
  }
  lines.push('');
  lines.push('三、仍然没有答案的部分');
  conclusions.items.forEach(function (item) {
    item.open.forEach(function (line) { lines.push('· ' + item.name + '：' + line); });
  });
  lines.push('');
  lines.push('四、这个问题接下来在找谁');
  lines.push('· ' + (await buildNextQuestion(listContributions()[0] || { roleKey: 'seeker', answers: {} })).why);
  lines.push('');
  lines.push('这份回答不会自动发布。你可以先修改，再决定是否发布到知乎。');
  return {
    question: QUESTION,
    body: lines.join('\n'),
    contributionCount: listContributions().length,
    generatedAt: new Date().toISOString(),
    notice: '草稿由已确认的公开来源和个人经历拼成，没有添加任何未经验证的说法。发布前请自行核对。'
  };
}


/* ==================================================================
   十、三维图谱数据
   X 轴 = 时间；Y 轴 = 六个固定子命题；Z 轴 = 内容数量。
   三根轴共用同一个原点，都是直线。
   主展示区是 2024—2027；真实抓到的公开内容落在 2020—2023，
   因此单独划出「更早来源」区，绝不把它挪进 2024—2027 的位置。
   ================================================================== */

export const AXIS = {
  mainFrom: 2024,
  mainTo: 2027,
  earlierFrom: 2020,
  earlierTo: 2023,
  quartersPerYear: 4
};

function periodList() {
  const list = [];
  for (let year = AXIS.earlierFrom; year <= AXIS.earlierTo; year += 1) {
    for (let q = 1; q <= 4; q += 1) list.push({ key: year + 'Q' + q, year: year, quarter: q, region: 'earlier' });
  }
  for (let year = AXIS.mainFrom; year <= AXIS.mainTo; year += 1) {
    for (let q = 1; q <= 4; q += 1) list.push({ key: year + 'Q' + q, year: year, quarter: q, region: 'main' });
  }
  return list;
}

function periodOf(year, month) {
  if (!year) return null;
  const q = Math.min(4, Math.max(1, Math.ceil((month || 1) / 3)));
  const region = year < AXIS.mainFrom ? 'earlier' : 'main';
  if (year < AXIS.earlierFrom || year > AXIS.mainTo) return null;
  return { key: year + 'Q' + q, year: year, quarter: q, region: region };
}

function periodIndexOf(key) {
  const list = periodList();
  for (let i = 0; i < list.length; i += 1) if (list[i].key === key) return i;
  return -1;
}

export async function buildGraph() {
  const coverage = await buildCoverage();
  const contributions = listContributions();
  const samples = listSamples();
  const periods = periodList();
  const periodIndex = {};
  periods.forEach(function (item, index) { periodIndex[item.key] = index; });

  const points = [];
  const skipped = [];

  function pushPoint(base, layer, origin) {
    const period = periodOf(base.year, base.month);
    if (!period) {
      skipped.push({
        id: base.id,
        title: base.title || '',
        year: base.year,
        month: base.month,
        reason: base.year ? '该来源时间不在图谱展示范围内（' + base.year + ' 年）' : '时间无法确定，不放入时间轴'
      });
      return;
    }
    points.push({
      id: base.id,
      layer: layer,
      origin: origin,
      originLabel: origin === 'zhihu' ? '知乎来源' : (origin === 'sample' ? '体验样本（已停用）' : '本次贡献'),
      subtopic: base.subtopic,
      subtopicName: subtopicName(base.subtopic),
      periodKey: period.key,
      periodIndex: periodIndex[period.key],
      region: period.region,
      year: period.year,
      quarter: period.quarter,
      title: base.title || '',
      summary: base.summary || '',
      url: base.url || '',
      timeLabel: base.timeLabel || '',
      timeNote: base.timeNote || '',
      labels: base.labels || []
    });
  }

  coverage.sources.related.forEach(function (item) {
    pushPoint({
      id: item.id, subtopic: item.subtopic, year: item.year, month: item.month,
      title: item.title, summary: item.summary, url: item.url,
      timeLabel: timeLabel(item), timeNote: item.timeNote, labels: item.labels
    }, 'source', 'zhihu');
  });

  samples.forEach(function (sample) {
    pushPoint({
      id: sample.id, subtopic: sample.subtopic, year: sample.year, month: sample.month,
      title: sample.title, summary: sample.summary,
      timeLabel: sample.year + '-' + String(sample.month).padStart(2, '0') + '（体验样本，非真实来源）',
      timeNote: sample.note
    }, 'sample', 'sample');
  });

  contributions.forEach(function (item) {
    const date = new Date(item.createdAt || Date.now());
    const touched = contributionSubtopics(item);
    touched.all.forEach(function (key) {
      pushPoint({
        id: item.id + '::' + key, subtopic: key, year: date.getUTCFullYear(), month: date.getUTCMonth() + 1,
        title: '本次贡献：' + (item.roleName || '参与者'),
        summary: (item.card && item.card.facts && item.card.facts[0] ? item.card.facts[0].value : ''),
        timeLabel: date.getUTCFullYear() + '-' + String(date.getUTCMonth() + 1).padStart(2, '0') + '（本次贡献）',
        timeNote: '这条记录由本次参与者提交并确认。'
      }, 'contribution', 'contribution');
    });
  });

  /* 同一格（子命题 + 时段）里的点按顺序叠高，Z 轴高度就是内容数量。 */
  const cells = {};
  points.forEach(function (point) {
    const key = point.subtopic + '@' + point.periodKey;
    if (!cells[key]) {
      cells[key] = {
        key: key,
        subtopic: point.subtopic,
        subtopicName: point.subtopicName,
        periodKey: point.periodKey,
        periodIndex: point.periodIndex,
        region: point.region,
        year: point.year,
        quarter: point.quarter,
        count: 0,
        real: 0,
        sample: 0,
        contribution: 0,
        pointIds: []
      };
    }
    const cell = cells[key];
    cell.count += 1;
    if (point.origin === 'zhihu') cell.real += 1;
    if (point.origin === 'sample') cell.sample += 1;
    if (point.origin === 'contribution') cell.contribution += 1;
    point.z = cell.count - 1;
    cell.pointIds.push(point.id);
  });

  /* 密度微光：只表达「这一格内容多」，不可点击，也不计入任何数量统计。 */
  const glow = Object.keys(cells).map(function (key) {
    const cell = cells[key];
    return {
      key: key,
      subtopic: cell.subtopic,
      periodKey: cell.periodKey,
      region: cell.region,
      density: cell.count,
      interactive: false,
      note: '密度微光只表示这一格的内容多少，不可点击，也不计入统计。'
    };
  });

  /* 覆盖不足的时段：画虚线，不画实心柱。 */
  const gapSegments = [];
  SUBTOPICS.forEach(function (topic) {
    periods.forEach(function (period) {
      const key = topic.key + '@' + period.key;
      const cell = cells[key];
      if (cell && cell.real > 0) return;
      gapSegments.push({
        key: key,
        subtopic: topic.key,
        subtopicName: topic.name,
        periodKey: period.key,
        region: period.region,
        reason: cell
          ? (cell.contribution > 0 ? '这一时段只有当事人提交的经历，没有可核对的公开来源' : '这一时段没有内容')
          : '当前检索范围内没有找到这一时段的内容'
      });
    });
  });

  /* 联系线：默认隐藏。橙色细线 = 条件相近但结果相反。 */
  const links = [];
  const conclusions = await buildConclusions();
  conclusions.items.forEach(function (item) {
    item.contrast.forEach(function (pair) {
      const from = pair.aId + '::' + item.key;
      const to = pair.bId + '::' + item.key;
      links.push({
        id: 'contrast-' + pair.aId + '-' + pair.bId + '-' + item.key,
        from: from,
        to: to,
        kind: 'contrast',
        subtopic: item.key,
        label: '条件相近但结果相反：' + pair.shared.join('、'),
        note: pair.note,
        strength: 1
      });
    });
  });

  /* 同一子命题内的相邻经历，作为弱联系线（选中后才显示）。 */
  SUBTOPICS.forEach(function (topic) {
    const list = contributions
      .filter(function (item) { return contributionSubtopics(item).all.indexOf(topic.key) !== -1; })
      .sort(function (a, b) { return String(a.createdAt).localeCompare(String(b.createdAt)); });
    for (let i = 1; i < list.length; i += 1) {
      links.push({
        id: 'near-' + topic.key + '-' + list[i - 1].id + '-' + list[i].id,
        from: list[i - 1].id + '::' + topic.key,
        to: list[i].id + '::' + topic.key,
        kind: 'near',
        subtopic: topic.key,
        label: '同一子命题内的两份经历',
        note: '两份经历都落在「' + topic.name + '」，时间上相邻。',
        strength: 0.5
      });
    }
  });

  const counts = {
    points: points.length,
    real: points.filter(function (p) { return p.origin === 'zhihu'; }).length,
    sample: points.filter(function (p) { return p.origin === 'sample'; }).length,
    contribution: points.filter(function (p) { return p.origin === 'contribution'; }).length,
    glow: glow.length,
    links: links.length
  };

  return {
    axis: {
      x: { name: '时间', from: AXIS.earlierFrom, to: AXIS.mainTo, mainFrom: AXIS.mainFrom, mainTo: AXIS.mainTo, unit: '季度' },
      y: { name: '子命题', items: SUBTOPICS.map(function (t) { return { key: t.key, name: t.name }; }) },
      z: { name: '内容数量', unit: '条', max: Math.max(1, points.length ? Math.max.apply(null, Object.keys(cells).map(function (k) { return cells[k].count; })) : 1) },
      origin: { x: 0, y: 0, z: 0 },
      note: '三根轴共用同一个原点，都是直线。'
    },
    regions: [
      { key: 'earlier', label: '更早来源（' + AXIS.earlierFrom + '—' + AXIS.earlierTo + '）', note: '这些是真实抓到的公开内容，时间由内容 ID 推算，不放进 2024—2027 的位置。' },
      { key: 'main', label: '当前调查区间（' + AXIS.mainFrom + '—' + AXIS.mainTo + '）', note: '这一段是当前问题的调查区间。' }
    ],
    periods: periods,
    points: points,
    cells: Object.keys(cells).map(function (key) { return cells[key]; }),
    glow: glow,
    gapSegments: gapSegments,
    links: links,
    skipped: skipped,
    counts: counts,
    coverage: {
      stats: SUBTOPICS.map(function (topic) {
        const stat = coverage.stats[topic.key];
        return { key: topic.key, name: topic.name, real: stat.realCount, sample: stat.sampleCount, contribution: stat.contributionCount, total: stat.totalCount, evidenceState: stat.evidenceState, evidenceLabel: stat.evidenceLabel };
      })
    },
    sources: coverage.sources,
    fetchedAt: coverage.sources.fetchedAt,
    stale: coverage.sources.stale
  };
}

/* 颜色与图层定义，前后端共用同一份，避免两边说法不一致。 */
export const LEGEND = [
  { key: 'zhihu', label: '知乎来源', color: '#4c8dff', shape: 'star', note: '真实抓取到的知乎公开内容' },
  { key: 'contribution', label: '本次贡献', color: '#3ddc84', shape: 'star', note: '本次参与者提交并确认的经历' },
  { key: 'ai', label: 'AI 整理', color: '#d9f45f', shape: 'note', note: '由 AI 把已有内容整理成的说明，不是新事实' },
  { key: 'gap', label: '覆盖不足', color: '#e8562a', shape: 'dashed', note: '这一时段或这一条没有可核对的公开来源' },
  { key: 'contrast', label: '条件相近但结果相反', color: '#f2a03d', shape: 'line', note: '两份条件相近的经历得到了相反结果' }
];


/* ==================================================================
   十一、一次参与的完整闭环（供接口调用）
   进入采访 → 生成追问 → 确认贡献卡 → 记录变化 → 给出下一问
   ================================================================== */

const drafts = new Map();

function newId(prefix) {
  const stamp = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return prefix + '-' + stamp + '-' + rand;
}

export function questionSummary() {
  return {
    question: QUESTION,
    subtopics: SUBTOPICS,
    gaps: GAPS,
    roles: ROLE_ORDER.map(function (key) {
      const role = ROLES[key];
      return {
        key: role.key,
        name: role.name,
        short: role.short,
        entry: role.entry,
        entryNames: role.entry.map(subtopicName),
        effect: role.effect,
        questionCount: role.questions.length
      };
    }),
    demo: {
      roleKey: DEMO_ANSWERS.role,
      answers: DEMO_ANSWERS.answers,
      followUpAnswer: DEMO_ANSWERS.followUpAnswer,
      followUpReply: DEMO_ANSWERS.followUpReply
    },
    legend: LEGEND,
    llm: llmStatus()
  };
}

export function roleDetail(roleKey) {
  const role = ROLES[roleKey];
  if (!role) return null;
  return {
    key: role.key,
    name: role.name,
    short: role.short,
    entry: role.entry,
    entryNames: role.entry.map(subtopicName),
    effect: role.effect,
    questions: role.questions,
    subtopics: SUBTOPICS
  };
}

/* 开始一次采访：登记草稿，返回问题清单与匹配说明。 */
export function startInterview(roleKey) {
  const role = ROLES[roleKey];
  if (!role) return null;
  const draftId = newId('draft');
  drafts.set(draftId, { id: draftId, roleKey: roleKey, createdAt: new Date().toISOString(), answers: {}, followUp: null });
  return {
    draftId: draftId,
    role: roleDetail(roleKey),
    matchReason: QUESTION.matchReason,
    matchConfirm: QUESTION.matchConfirm,
    matchCost: QUESTION.matchCost,
    statement: '这是一份个人经历，不代表行业整体情况。确认后，它将进入当前调查，不会自动发布成知乎回答。'
  };
}

export function getDraft(draftId) {
  return drafts.get(draftId) || null;
}

export async function submitInterview(draftId, answers) {
  const draft = drafts.get(draftId);
  if (!draft) return null;
  draft.answers = Object.assign({}, answers || {});
  const followUp = await generateFollowUp(draft.roleKey, draft.answers);
  draft.followUp = followUp;
  const card = buildCardFromAnswers(draft.roleKey, draft.answers, null);
  return {
    draftId: draftId,
    followUp: followUp,
    card: card,
    statement: card ? card.statement : ''
  };
}

export function applyFollowUpAnswer(draftId, answer) {
  const draft = drafts.get(draftId);
  if (!draft) return null;
  draft.followUp = Object.assign({}, draft.followUp || {}, { answer: safeText(answer, 600) });
  const card = buildCardFromAnswers(draft.roleKey, draft.answers, draft.followUp);
  return { draftId: draftId, card: card, statement: card ? card.statement : '' };
}

/* 确认并写入：写入前先存一份统计快照，写入后算出真实变化。 */
export async function confirmContribution(draftId, payload) {
  const draft = drafts.get(draftId);
  if (!draft) return null;
  const answers = Object.assign({}, draft.answers, (payload && payload.answers) || {});
  const followUp = Object.assign({}, draft.followUp || {}, (payload && payload.followUp) || {});
  const card = buildCardFromAnswers(draft.roleKey, answers, followUp);
  if (!card || card.factCount === 0) {
    return { error: 'empty-card' };
  }

  const before = await snapshotCoverage();
  const item = {
    id: newId('c'),
    roleKey: draft.roleKey,
    roleName: card.roleName,
    answers: answers,
    followUp: followUp,
    card: card,
    anonymous: Boolean(payload && payload.anonymous),
    createdAt: new Date().toISOString(),
    origin: 'contribution'
  };
  await addContribution(item);
  const after = await snapshotCoverage();
  const changes = diffCoverage(before, after);
  const next = await buildNextQuestion(item);
  drafts.delete(draftId);

  return {
    contribution: publicContribution(item),
    card: card,
    changes: changes,
    nextQuestion: next,
    graph: await buildGraph(),
    conclusions: await buildConclusions(),
    statement: '这是一份个人经历，不代表行业整体情况。它已经进入当前调查，不会自动发布成知乎回答。'
  };
}

export async function undoContribution(id) {
  const removed = await removeContribution(id);
  if (!removed) return null;
  return { removed: true, graph: await buildGraph(), conclusions: await buildConclusions() };
}

/* 初始状态：连演示数据都不写入，只有真实抓取 + 空贡献。 */
export async function fullState() {
  return {
    summary: questionSummary(),
    graph: await buildGraph(),
    conclusions: await buildConclusions()
  };
}

export async function saveLlmConfig(payload) {
  const apiKey = pickString(payload && payload.apiKey, 300);
  const provider = pickString(payload && payload.provider, 40) || 'deepseek';
  const baseUrl = pickString(payload && payload.baseUrl, 200) || (provider === 'deepseek' ? 'https://api.deepseek.com' : 'https://api.openai.com');
  const model = pickString(payload && payload.model, 80) || (provider === 'deepseek' ? 'deepseek-chat' : 'gpt-4o-mini');
  if (!apiKey) {
    await writeJson(settingsFile, { provider: provider, baseUrl: baseUrl, model: model, apiKey: '' });
    await loadLlmConfig();
    return { saved: true, cleared: true, status: llmStatus() };
  }
  await writeJson(settingsFile, { provider: provider, baseUrl: baseUrl, model: model, apiKey: apiKey, savedAt: new Date().toISOString() });
  await loadLlmConfig();
  return { saved: true, cleared: false, status: llmStatus() };
}

/* 用真实模型测一次连通性，失败时如实返回原因，不假装成功。 */
export async function testLlm() {
  if (!memory.llm.configured) return { ok: false, reason: 'not-configured', message: '还没有配置语言模型，当前使用本地规则生成追问。' };
  const started = Date.now();
  const reply = await callLlm([
    { role: 'system', content: '你只需要回复「连通」两个字。' },
    { role: 'user', content: '测试' }
  ], 20);
  if (!reply) return { ok: false, reason: 'request-failed', message: '语言模型没有返回结果，请检查 Key、模型名和网络。' };
  return { ok: true, ms: Date.now() - started, reply: reply.slice(0, 40), status: llmStatus() };
}
