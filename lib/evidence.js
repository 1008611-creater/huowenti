import crypto from 'node:crypto';

const RELATION_TYPES = {
  witness: { code: 'witness', label: '本人到场', weight: 3, independent: true },
  relay: { code: 'relay', label: '转述他人', weight: 1, independent: false },
  official: { code: 'official', label: '官方或机构渠道', weight: 4, independent: true },
  archived: { code: 'archived', label: '历史记录', weight: 1, independent: false }
};

/* 时间表述（闭馆时间、晚上九点）描述的是时刻，不是现场状态，先剥离 */
const TIME_NOISE = /(?:开馆|闭馆|营业|开放|关门|打烊|截止|入场|开始|结束|上班|下班)时间|(?:凌晨|早上|上午|中午|下午|傍晚|晚上|夜里|今晚|明早|明天|今天|每天)?[\d一二三四五六七八九十两]{1,4}\s*[点时](?:\s*半|\s*\d{1,2}\s*分)?|\d{1,2}:\d{2}/g;

/* 先归一化：把口语说法映射到统一表达，再做信号识别 */
/* 否定式必须先改写：「暂停开放 / 没开门 / 不能进」原本会被正向的「开放」规则命中，
   把实际已经关闭的现场判成开放——这是会翻转结论的错误，所以放在所有替换之前。 */
const CLOSED_SPEAK = /(?:(?:暂|暂时|临时)(?:停|停止)|暂停)开放|不开放|(?:还|尚)?没(?:有)?开门|尚未开门|未开门|没开放|尚未开放|不能(?:进|进入)|无法(?:进|进入)|不让(?:进|进入)|谢绝入场/g;
const CLEAR_SPEAK = /不用排队|无需排队|不排队|没有排队|不用等|无需等待|不用等待|不堵|不拥堵|不拥挤|不挤|人流少|人很少|人不多|人不多不少|人不算多|人不太多|没什么人|很空|空着|比较空|直接进|随时可进|一路畅通|通行顺畅|(?<!不)顺畅|很快就到|很好走|(?<!不)好走/g;
const CROWD_SPEAK = /排了[^，。；,;、]{0,8}?(?:队|长队|很久|[0-9一二三四五六七八九十百两]+\s*(?:分钟|小时))|排起[^，。；,;、]{0,6}队|队伍(?:很长|排得很长|特别长)|人(?:很多|特别多|非常多|超级多|超多|巨多|贼多|好多|太多了)|人山人海|水泄不通|人挤人|人满为患|寸步难行|挤不动|走不动|爆满|拥挤|堵车|拥堵|堵塞|堵住|挤不进去|要等/g;
/* 短时排队是"能顺利进去"的口语说法，不是拥堵：
   「排队两三分钟」「等一会儿就进去了」描述的是顺利通过，若当成拥堵，
   会和另一位"不用排队"的反馈撞成假矛盾（实测旗舰案例就是这样被误判的）。
   只吸收分钟级的短时长；「排队 15 分钟」「等了半个小时」仍然算拥堵。 */
const SHORT_WAIT_SPEAK = /(?:排队|等候|等待|等|排)[^，。；,;、]{0,3}(?:一会儿|一小会儿|片刻|几分钟|一两分钟|两三分钟|三四分钟|三五分钟|(?<![一二三四五六七八九十两])[一二三四五六七八九]分钟|(?<!\d)[1-9]\s*分钟)/g;

/* “不用预约 / 不限流”里的关键词不代表被管控，先剥离 */
const THROTTLE_NOISE = /(?:不用|无需|不需要|没有必要|没有)预约|(?:不|没有|无)限流/g;

const SOFT_SPEAK = [/(?:排队|队伍|人流|人)[^，。；,;、]{0,6}?不(?:算|怎么|太|会|是)?(?:长|久|多|挤|严重|厉害|夸张)/g, /不(?:算|太|怎么)(?:长|久|多|挤|严重)/g];

const SIGNAL_RULES = [
  { code: 'open', label: '开放 / 可进入', dimension: 'access', polarity: 1, pattern: /开放|开门|(?<!没|不|未)开着|在营业|可以进|能进|可通行|畅通|正常通行|可以走|已恢复|恢复了|顺利进入|进去了|没关门|还没关门/ },
  { code: 'throttled', label: '限流 / 人数管控', dimension: 'access', polarity: 0, pattern: /限流|限号|预约|预约制|分时段|人数管控|控制人流/ },
  { code: 'closed', label: '关闭 / 不可进入', dimension: 'access', polarity: -1, pattern: /关闭|封闭|闭馆|停运|停业|暂停开放|不能进|无法进入|进不去|封路|封了|不放行|已满|约满|售罄|没票|取消了|取消|打烊|谢绝入场/ },
  { code: 'crowded', label: '拥堵 / 排队', dimension: 'flow', polarity: -1, pattern: /排队|人(?:很多|特别多|非常多|超级多|超多|巨多|贼多|好多|太多了)|人山人海|水泄不通|人挤人|人满为患|寸步难行|挤不动|走不动|爆满|拥挤|堵车|拥堵|堵塞|堵住|挤不进去|队伍很长|要等|(?:等|排)了.{0,4}(?:分钟|小时)|(?:等|排)[^，。；,;、]{0,3}[0-9一二三四五六七八九十百两]+\s*(?:分钟|小时)/ },
  { code: 'clear', label: '通畅 / 无需等待', dimension: 'flow', polarity: 1, pattern: /不用排队|无需排队|不排队|不堵|不拥堵|不拥挤|不挤|人流少|人很少|人不多|人不算多|人不太多|没什么人|很空|比较空|直接进|随时可进|一路畅通|通行顺畅|(?<!不)顺畅|不用等|很好走|(?<!不)好走/ },
  { code: 'hazard', label: '存在风险或异常', dimension: 'safety', polarity: -1, pattern: /积水|淹|塌|事故|起火|着火|停电|停水|封闭施工|施工|检修|故障|危险|不安全|摔|受伤/ },
  { code: 'normal', label: '现场正常', dimension: 'safety', polarity: 1, pattern: /正常(?!开放|营业|通行|进出|运行)|没问题|秩序井然|没听说.{0,4}(?:问题|异常)/ }
];

/* 只有在同一个维度上出现相反说法，才算真正的冲突 */
const OPPOSING = [
  ['open', 'closed'],
  ['crowded', 'clear'],
  ['hazard', 'normal']
];

const LABELS = {};
const DIMENSIONS = {};
const DIM_LABELS = { access: '是否开放 / 能否进入', flow: '人流与等待', safety: '现场是否安全' };
const POLARITIES = {};
SIGNAL_RULES.forEach(function (rule) { LABELS[rule.code] = rule.label; DIMENSIONS[rule.code] = rule.dimension; POLARITIES[rule.code] = rule.polarity; });

/* 现场信息的时效：在“此刻”类问题里，一条 20 小时前的反馈和一条 5 分钟前的反馈不是一回事。
   超过 48 小时的观察不再计入当前判断，但会如实保留在页面上并单独说明。 */
export const AGE_TIERS = [
  { code: 'live', label: '现场有效', maxHours: 2, weight: 1 },
  { code: 'recent', label: '仍然新鲜', maxHours: 12, weight: 1 },
  { code: 'aging', label: '开始过时', maxHours: 48, weight: 1 },
  { code: 'stale', label: '已过时', maxHours: Infinity, weight: 0 }
];

export function freshnessOf(createdAt, reference) {
  const base = Number.isFinite(reference) ? reference : Date.now();
  const stamp = createdAt ? new Date(createdAt).getTime() : NaN;
  if (!Number.isFinite(stamp) || stamp > base) return { code: 'live', label: '现场有效', weight: 1, hours: 0 };
  const hours = Math.round(((base - stamp) / 3600000) * 10) / 10;
  const tier = AGE_TIERS.find(function (item) { return hours <= item.maxHours; }) || AGE_TIERS[AGE_TIERS.length - 1];
  return { code: tier.code, label: tier.label, weight: tier.weight, hours: hours };
}

function hashContent(value) {
  return crypto.createHash('sha1').update(String(value || '').replace(/\s+/g, '').toLowerCase()).digest('hex').slice(0, 16);
}

function normalize(text) {
  let probe = String(text == null ? '' : text);
  probe = probe.replace(TIME_NOISE, ' ');
  probe = probe.replace(CLOSED_SPEAK, ' 已关闭 ');
  probe = probe.replace(THROTTLE_NOISE, ' 略过 ');
  probe = probe.replace(CLEAR_SPEAK, ' 很空 ');
  probe = probe.replace(SHORT_WAIT_SPEAK, ' 很空 ');
  probe = probe.replace(CROWD_SPEAK, ' 排队 ');
  SOFT_SPEAK.forEach(function (pattern) { probe = probe.replace(pattern, ' 略过 '); });
  return probe;
}

export function classify(content, relation) {
  const text = String(content == null ? '' : content);
  const probe = normalize(text);
  const signals = SIGNAL_RULES
    .filter(function (rule) { return rule.pattern.test(probe); })
    .map(function (rule) { return { code: rule.code, label: rule.label, dimension: rule.dimension, polarity: rule.polarity }; });
  const positive = signals.filter(function (signal) { return signal.polarity > 0; }).length;
  const negative = signals.filter(function (signal) { return signal.polarity < 0; }).length;
  const polarity = positive === negative ? 0 : (positive > negative ? 1 : -1);
  const kind = RELATION_TYPES[relation] || RELATION_TYPES.witness;
  return {
    signals: signals,
    polarity: polarity,
    positive: positive,
    negative: negative,
    weight: kind.weight,
    independent: kind.independent,
    fingerprint: hashContent(text)
  };
}

function tallySignals(items) {
  const tally = new Map();
  items.forEach(function (entry) {
    (entry.analysis.signals || []).forEach(function (signal) {
      const current = tally.get(signal.code) || { code: signal.code, label: signal.label, polarity: signal.polarity, count: 0 };
      current.count += 1;
      tally.set(signal.code, current);
    });
  });
  return Array.from(tally.values()).sort(function (a, b) { return b.count - a.count; });
}

function holdersOf(items, code) {
  return items.filter(function (entry) {
    return (entry.analysis.signals || []).some(function (signal) { return signal.code === code; });
  });
}

export function evaluate(feedback, options) {
  const list = Array.isArray(feedback) ? feedback : [];
  const reference = options && Number.isFinite(options.now) ? options.now : Date.now();
  const enriched = list.map(function (item) {
    return {
      item: item,
      analysis: classify(item.content, item.relationType),
      freshness: freshnessOf(item.createdAt, reference)
    };
  });
  const base = { total: list.length, independent: 0, positive: 0, negative: 0, neutral: 0, stale: 0, freshest: null };
  if (!list.length) {
    return {
      code: 'pending', label: '待现场确认', level: 0, confidence: 0,
      reason: '还没有收到现场反馈，任何结论都缺少依据。',
      stats: base, signals: [], conflicts: [], dimensions: [], latest: null, freshness: null
    };
  }

  const seen = new Set();
  const independentItems = [];
  enriched.forEach(function (entry) {
    const key = (entry.item.relationType || 'witness') + ':' + entry.analysis.fingerprint;
    const seenBefore = seen.has(key);
    if (!seenBefore) seen.add(key);
    const duplicate = Boolean(entry.item.duplicateOf) || seenBefore;
    const stale = entry.freshness.weight === 0;
    entry.duplicate = duplicate;
    entry.stale = stale;
    if (!duplicate && !stale) {
      base[entry.analysis.polarity > 0 ? 'positive' : entry.analysis.polarity < 0 ? 'negative' : 'neutral'] += 1;
    }
    if (entry.analysis.independent && !duplicate && !stale) independentItems.push(entry);
  });
  base.independent = independentItems.length;
  base.stale = enriched.filter(function (entry) { return entry.stale; }).length;
  const freshest = enriched.length
    ? enriched.slice().sort(function (a, b) { return a.freshness.hours - b.freshness.hours; })[0]
    : null;
  base.freshest = freshest ? freshest.freshness : null;
  const freshnessNote = base.stale
    ? '另有 ' + base.stale + ' 条反馈提交于 48 小时之前，已经不能代表此刻的现场，因此不计入这次的判断，但仍然保留在下面。'
    : (freshest && freshest.freshness.code === 'aging'
      ? '最新一条反馈已经过去 ' + freshest.freshness.hours + ' 小时，现场可能已经变化，建议再确认一次。'
      : '');

  const conflicts = [];
  OPPOSING.forEach(function (pair) {
    const left = holdersOf(independentItems, pair[0]);
    const right = holdersOf(independentItems, pair[1]);
    const crossed = left.some(function (a) { return right.some(function (b) { return b !== a; }); });
    if (crossed) {
      conflicts.push({
        code: pair[0] + '_vs_' + pair[1],
        dimension: DIMENSIONS[pair[0]] || '',
        summary: LABELS[pair[0]] + ' ↔ ' + LABELS[pair[1]],
        positive: { code: pair[0], label: LABELS[pair[0]], count: left.length },
        negative: { code: pair[1], label: LABELS[pair[1]], count: right.length }
      });
    }
  });

  const latest = enriched[enriched.length - 1];
  const signals = tallySignals(enriched).slice(0, 6);
  const hasOfficial = independentItems.some(function (entry) { return (entry.item.relationType || '') === 'official'; });

  /* 按维度给出结论：哪个方面已被确认，哪个方面仍有分歧。
     用户不会因为"人流说法不一致"就误以为"入口是否开放"也不可信。 */
  const conflictByDimension = new Map();
  conflicts.forEach(function (item) { conflictByDimension.set(item.dimension, item); });

  const dimensionOrder = [];
  const codesByDimension = new Map();
  const holdersByDimension = new Map();
  independentItems.forEach(function (entry) {
    (entry.analysis.signals || []).forEach(function (signal) {
      if (!codesByDimension.has(signal.dimension)) {
        codesByDimension.set(signal.dimension, new Set());
        holdersByDimension.set(signal.dimension, new Map());
        dimensionOrder.push(signal.dimension);
      }
      codesByDimension.get(signal.dimension).add(signal.code);
      const holders = holdersByDimension.get(signal.dimension);
      const list = holders.get(signal.code) || [];
      list.push(entry);
      holders.set(signal.code, list);
    });
  });

  const dimensions = dimensionOrder.map(function (dim) {
    const codes = Array.from(codesByDimension.get(dim) || []);
    const holders = holdersByDimension.get(dim) || new Map();
    /* 限流 / 预约这类中性信息不代表“开放”或“关闭”，不能拉低该维度的结论强度 */
    const decisive = codes.filter(function (code) { return (POLARITIES[code] || 0) !== 0; });
    const conflict = conflictByDimension.get(dim);
    /* “一致”必须看这个维度里有几位独立到场者指向同一结论，
       而不是整个问题下收到了几条反馈——否则只有一个人随口提过的方面
       也会被误标成已经确认。 */
    const witnesses = decisive.reduce(function (max, code) {
      return Math.max(max, (holders.get(code) || []).length);
    }, 0);
    let status = '参考';
    if (conflict) status = '分歧';
    else if (decisive.length === 0) status = '中性';
    else if (decisive.length === 1) status = witnesses >= 2 ? '一致' : '单一';
    return {
      dimension: dim,
      label: DIM_LABELS[dim] || dim,
      codes: codes,
      labels: codes.map(function (code) { return LABELS[code] || code; }),
      status: status,
      witnesses: witnesses,
      conflict: conflict ? conflict.summary : null
    };
  });

  if (conflicts.length) {
    return {
      code: 'conflict', label: '存在冲突', level: 2, confidence: 35,
      reason: '出现了相互矛盾的现场描述，分歧点：' + conflicts.map(function (item) { return item.summary; }).join('、') +
        '。可能来自不同入口、不同时间或转述误差，结论必须保留分歧。' + (freshnessNote ? ' ' + freshnessNote : ''),
      stats: base, signals: signals, conflicts: conflicts, dimensions: dimensions, latest: latest.item,
      freshness: base.freshest, freshnessNote: freshnessNote
    };
  }
  if (hasOfficial) {
    return {
      code: 'verified', label: '有官方依据', level: 3, confidence: 80,
      reason: '来自官方或机构渠道的说法已经出现，可信度高于个人转述，但仍要注意时效性。' + (freshnessNote ? ' ' + freshnessNote : ''),
      stats: base, signals: signals, conflicts: [], dimensions: dimensions, latest: latest.item,
      freshness: base.freshest, freshnessNote: freshnessNote
    };
  }
  if (independentItems.length >= 2) {
    return {
      code: 'corroborated', label: '交叉印证', level: 3, confidence: 70,
      reason: '至少两位独立到场的用户给出一致描述，可视为较可信的现场状态。' + (freshnessNote ? ' ' + freshnessNote : ''),
      stats: base, signals: signals, conflicts: [], dimensions: dimensions, latest: latest.item,
      freshness: base.freshest, freshnessNote: freshnessNote
    };
  }
  if (independentItems.length === 0) {
    /* 有反馈，但没有一条是“现在还站得住”的独立观察：旧记录或纯转述都不能撑起结论。 */
    const reason = base.stale
      ? '目前所有现场反馈都提交于 48 小时之前，已经不能代表此刻的现场。它们作为记录保留，但不计入结论。'
      : '目前的反馈都来自转述，没有本人到场的独立观察，不足以形成结论。';
    return {
      code: 'pending', label: '待现场确认', level: 0, confidence: 0,
      reason: reason, stats: base, signals: signals, conflicts: [], dimensions: dimensions,
      latest: latest.item, freshness: base.freshest, freshnessNote: freshnessNote
    };
  }
  return {
    code: 'single', label: '单一来源', level: 1, confidence: 30,
    reason: '目前只有一条独立反馈。它提供了线索，但不足以当作已确认的事实。' + (freshnessNote ? ' ' + freshnessNote : ''),
    stats: base, signals: signals, conflicts: [], dimensions: dimensions, latest: latest.item,
    freshness: base.freshest, freshnessNote: freshnessNote
  };
}

export function relationTypes() {
  return Object.values(RELATION_TYPES);
}
