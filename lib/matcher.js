const STOP = new Set(['现在','今天','明天','昨天','此刻','此时','今晚','上午','下午','晚上','中午','早上','刚刚','马上','已经','曾经','周末','假期','节假日','这个','那个','什么','怎么','如何','可以','是否','有没有','吗','呢','吧','的','了','我','你','他','她','它','在','和','与','就','都','还','要','会','能','这','那','哪些','哪个','一个','一下','们','是','不','有','到','去','来','过','很','太','真的','请问','知道','告诉','大概','可能','应该','需要','多久','多少','几点','时候','时间','地方','这里','那里','我们','你们','他们','因为','所以','但是','如果','就是','还是','只是','一直','附近','周边','这边','那边']);

/* 这些词只说明「时间」或「提问口吻」，本身不携带主题信息。
   正文里偶然出现一个这样的词，不能当成「这篇内容与问题相关」。 */
const WEAK_TERMS = new Set(['自己','这回','那样','这样','怎样','一样','这些','那些','他是','她是','只有','不能','不会','没有','什么','可是','然后','而且','虽然','为了','关于','对于','通过','进行','方面','问题','一个','一些','此刻','此时','今晚','上午','下午','晚上','中午','早上','刚刚','马上','已经','曾经','周末','假期','时候','时间','地方','情况','状态','现场','多少','多久','几点','是否','能不能','可以','怎么','如何','什么','这个','那个','这里','那里','我们','你们','他们','真的','其实','因为','所以','但是','如果','就是','还是','只是','一直','可能','应该','需要','知道','告诉','请问','大概','怎么样','合适','值得','推荐','来得及']);

const PLACE_SUFFIX = ['机场','火车站','高铁站','地铁站','车站','医院','学校','大学','学院','食堂','图书馆','公园','景区','博物馆','美术馆','商场','超市','菜市场','路','街','大道','广场','体育馆','球场','码头','口岸','收费站','服务区','隧道','大桥','校区','小区','园区','大厦','中心','门口','入口','出口','航站楼','候机楼','候车厅','影城','剧院','livehouse','剧场','东门','南门','西门','北门','正门','大门','侧门','后门','前门','桥','山','湖','塔','寺','庙','园','馆','城','岛','湾','港','口','站','艺术区','步行街','商业街','小吃街','停车场','换乘站','地下通道','过街天桥','老街','古镇','广场'];

/* 单独出现时过于泛化，必须带上前置修饰语才值得展示（「机场」不如「首都机场」）。 */
const GENERIC_BARE = new Set(['路','街','大道','广场','中心','大厦','园区','校区','小区','门口','入口','出口','车站','医院','学校','商场','超市','公园','桥','山','湖','塔','寺','庙','园','馆','城','岛','湾','港','口','站','菜市场','图书馆','食堂','大学','学院','地铁站','高铁站','火车站','机场','收费站','服务区','隧道','大桥','体育馆','球场','码头','口岸','影城','剧院','剧场','livehouse','博物馆','美术馆','景区','航站楼','候机楼','候车厅','展览']);

/* 只有泛称、没有任何限定语时（「那个超市」「这条街」），不当作已识别地点。 */
const BARE_DROP = new Set(['路','街','大道','广场','中心','大厦','园区','校区','小区','车站','桥','山','湖','塔','寺','庙','园','馆','城','岛','湾','港','口','站','机场','火车站','地铁站','高铁站','超市','食堂','菜市场','学校','医院','公园','菜市场']);

/* 拼出来仍是泛称的直接丢掉，避免「路」「主路」这类噪声占位。 */
const PLACE_NOISE = new Set(['主路','大路','小路','马路','公路','道路','路口','路上','路边','人口','窗口','缺口','地方','这里','那里','路上','进站','出站','上车','下车','换乘']);

/* 知名地标：没有「机场 / 博物馆」这类后缀，但一眼就能认出。 */
const LANDMARKS = ['上海','北京','深圳','杭州','苏州','成都','重庆','西安','南京','武汉','长沙','青岛','厦门','大连','天津','香港','澳门','台北','上海虹桥火车站','上海虹桥站','虹桥火车站','北京西站','北京站','广州东站','广州站','深圳站','南京南站','杭州站','成都东站','成都南站','重庆北站','武汉站','西安北站','天津站','长沙南站','首都机场','大兴机场','浦东机场','虹桥机场','白云机场','宝安机场','天府机场','咸阳机场','萧山机场','首都t3','首都t2','北京南站','上海虹桥站','广州南站','深圳北站','杭州东站','798','故宫','天安门','颐和园','天坛','长城','西湖','断桥','外滩','三里屯','环球影城','环球度假区','迪士尼','兵马俑','秦始皇陵','黄山','泰山','华山','嵩山','峨眉山','武当山','普陀山','五台山','南锣鼓巷','宽窄巷子','大唐不夜城','大唐芙蓉园','太古里','中山陵','黄鹤楼','东方明珠','上海中心','鼓浪屿','九寨沟','张家界','布达拉宫','大雁塔','小雁塔','拙政园','趵突泉','橘子洲','洪崖洞','夫子庙','豫园','南京路','王府井','西单','国贸','陆家嘴','广州塔','小蛮腰','华强北','中关村','什刹海','后海','洱海','青海湖','武夷山','都江堰','乐山大佛','莫高窟','龙门石窟','云冈石窟','平遥古城','丽江古城','凤凰古城','乌镇','周庄','西塘','宏村','婺源','香格里拉','稻城亚丁','茶卡盐湖','鸣沙山','月牙泉','天山','喀纳斯','呼伦贝尔','长白山','亚龙湾','天涯海角','鸟巢','水立方','首钢园','欢乐谷','长隆','方特','动物园','植物园','科技馆','国家博物馆','首都博物馆','上海博物馆','陕西历史博物馆','碑林','钟楼','鼓楼','回民街','永兴坊','大明宫','华清池'];

/* 只把真正的时间点算作「时间」。提问口吻（几点、还来得及）不算。 */
const TIME_HINTS = ['现在','今天','明天','昨天','今晚','今夜','明早','今早','今晨','早上','上午','中午','下午','傍晚','晚上','凌晨','深夜','刚刚','马上','已经','周末','这周末','下周末','假期','节假','高峰期','末班','首班'];

/* 这些字不能当地名的一部分：虚词、动词、疑问词、时间词、量词。 */
/* 注意：「大」「达」这类字常出现在地名里（大悦城、万达广场、八达岭），
   不能当停用字，否则「朝阳大悦城」会被切成「悦城」、「万达广场」会被整条丢掉。 */
const PLACE_STOP_CHARS = new Set(('的了是在和与就都还这那我你他她它们吗呢吧啊呀之其而也把被让给对从向为以及或但却才又再没' +
  '往去来到过走停排堵看问说想要有超过离距赶进出乘坐打' +
  '几什么怎么是否请问知道告诉概可能应该需要多少多久' +
  '天年月日时今明昨早中晚夜凌晨上下左右前后里外内间旁附近周边边此该刻午晨傍晚夜' +
  '人个条件次点分秒').split(''));

function isPlaceChar(ch) {
  if (!ch) return false;
  if (/[\u4e00-\u9fa5]/.test(ch)) return !PLACE_STOP_CHARS.has(ch);
  return /[a-z0-9]/.test(ch);
}

/* 单字规则太容易误伤：「封面」「闭幕」「开封」会被当成封闭，「无限流」会被当成限流，
   「堵心」会被当成堵车。这里只保留带语境的词形。 */
const INTENT_RULES = [
  { code: 'access', short: '能否进入', label: '能否进入 / 是否开放', pattern: /开放|开着(?!车)|还开吗|开了吗|开没开|营业中|没开门|未开门|开门|关门|营业|营业时间|能不能进|能不能进去|可以进|可以进吗|能进吗|能进么|让进吗|让不让进|进的去吗|进得去吗|能进去|不让进|进不去|通行|封闭|封锁|封路|封园|封馆|封山|封站|封控|关闭|闭馆|闭园|闭门|停运|停业|(?<!无)限流|预约|门票|售罄|还有票|安检/ },
  { code: 'crowd', short: '人流与排队', label: '人流与排队', pattern: /排队|人多|人少|拥挤|拥堵|堵车|堵死|堵住|堵得|堵吗|堵不堵|不堵|很堵|太堵|好堵|人流|客流|等候|等多久|队伍|满员|爆满|人挤|挤不挤|挤满|很挤|太挤|挤爆/ },
  { code: 'condition', short: '现场状况', label: '现场状况', pattern: /积水|下雨|天气|路况|塌方|事故|修路|施工|停电|停水|信号|温度|空气|安全/ },
  { code: 'practical', short: '是否值得去', label: '可行性与建议', pattern: /值得|推荐|建议|合适|划算|好吃|怎么走|路线|停车|车位|充电|厕所|寄存/ },
  { code: 'experience', short: '真实体验', label: '真实体验', pattern: /体验|感受|怎么样|好不好|踩坑|避雷|真实|亲历|经历/ },
  { code: 'timing', short: '能否赶上', label: '能否赶上 / 时间是否够', pattern: /来得及|赶得上|赶不上|赶不及|会迟到|会不会迟到|时间够不够|时间够吗|够不够时间/ }
];

/* 每个意图对应的「要向现场问什么」，直接生成自然中文，避免拼出「的能否赶上」这类硬邦邦的句子。 */
const INTENT_QUESTIONS = {
  access: '此刻是否开放、能不能进',
  crowd: '此刻人多不多、要排多久',
  condition: '此刻的现场状况如何（天气、积水、路况、故障等）',
  practical: '此刻去是否合适、值不值得',
  experience: '此刻的真实体验如何',
  timing: '现在过去是否还来得及'
};

function normalize(input) {
  return String(input == null ? '' : input)
    .replace(/[\uFF01-\uFF5E]/g, function (ch) { return String.fromCharCode(ch.charCodeAt(0) - 0xFEE0); })
    .toLowerCase();
}

/* 这些是「提问口吻 / 营业信息」，不是时间点，但仍会污染关键词匹配，单独列为弱词。 */
const WEAK_SUBSTRINGS = ['几点','来得及','营业时间','开放时间','什么时候','多久','多少','多长时间'];

function isWeakTerm(term) {
  if (WEAK_TERMS.has(term)) return true;
  if (WEAK_SUBSTRINGS.some(function (hint) { return hint.length > 1 && hint.indexOf(term) !== -1; })) return true;
  return TIME_HINTS.some(function (hint) { return hint.length > 1 && hint.indexOf(term) !== -1; });
}

/* 单个虚词不携带主题信息，跨虚词切出来的双字词也是噪声（如「的小」「己在」）。 */
const FUNCTION_CHARS = new Set('的了是在和与就都还这那我你他她它们吗呢吧啊呀之其而也把被让给对从向为以及或但却才又再没\u4e48\u5982\u4f55'.split(''));

/* 有些词含虚词，但本身是实义主题词（「被动」里的「被」、「对话」里的「对」）。
   不加白名单会被下面的虚词过滤误伤，导致「被动」这类词整条消失。 */
const KEEP_GRAMS = new Set(['被动','把柄','把手','让座','让利','给予','给力','对话','对象','对策','对方','对面','对比','对待','相对','方向','向往','倾向','作为','行为','人为','成为','认为','为了','从容','从来','以及','以后','所以','或者','但是','而非','与否','从而','以外','以内','之一','之后','之前','之中','之间','之外']);

function bigrams(text) {
  const clean = text.replace(/[^\u4e00-\u9fa5a-z0-9]+/g, '');
  const out = [];
  for (let index = 0; index < clean.length - 1; index += 1) {
    const gram = clean.slice(index, index + 2);
    if (STOP.has(gram)) continue;
    if (!KEEP_GRAMS.has(gram) && (FUNCTION_CHARS.has(gram[0]) || FUNCTION_CHARS.has(gram[1]))) continue;
    out.push(gram);
  }
  return out;
}

function latinWords(text) {
  return (text.match(/[a-z0-9]{2,20}/g) || []).filter(function (word) { return !STOP.has(word); });
}

function unique(list) {
  return Array.from(new Set(list));
}

function toDisplay(name) {
  return name.replace(/[a-z]+/g, function (piece) { return piece.toUpperCase(); });
}

/* 重叠的地名只保留更完整的那一个。
   「首都机场」与「机场」、「上海虹桥火车站」与「海虹桥火车站」不会同时出现。 */
function dropContained(list) {
  const ranked = list.slice().sort(function (a, b) {
    if (b.text.length !== a.text.length) return b.text.length - a.text.length;
    return a.index - b.index;
  });
  const kept = [];
  ranked.forEach(function (item) {
    const start = item.index;
    const end = item.index + item.text.length;
    const overlaps = kept.some(function (other) {
      return start < other.index + other.text.length && other.index < end;
    });
    if (!overlaps) kept.push(item);
  });
  return kept;
}

function mergeAdjacent(list) {
  const sorted = list.slice().sort(function (a, b) { return a.index - b.index; });
  const out = [];
  sorted.forEach(function (item) {
    const last = out[out.length - 1];
    if (last && last.index + last.text.length === item.index) {
      last.text = last.text + item.text;
    } else {
      out.push({ text: item.text, index: item.index });
    }
  });
  return out;
}

export function extractEntities(question) {
  const raw = String(question == null ? '' : question);
  const normalized = normalize(raw);

  /* ---- 地点 ---- */
  const found = [];
  const suffixes = PLACE_SUFFIX.slice().sort(function (a, b) { return b.length - a.length; });
  let cursor = 0;
  while (cursor < normalized.length) {
    let hit = null;
    for (let index = 0; index < suffixes.length; index += 1) {
      if (normalized.startsWith(suffixes[index], cursor)) { hit = suffixes[index]; break; }
    }
    if (!hit) { cursor += 1; continue; }
    let start = cursor;
    /* 向左扩展，把「机场」补成「首都机场」、把「桥」补成「西湖断桥」。 */
    while (start > 0 && isPlaceChar(normalized[start - 1]) && cursor - start < 8) start -= 1;
    found.push({ text: normalized.slice(start, cursor + hit.length), index: start });
    cursor += hit.length;
  }

  LANDMARKS.forEach(function (mark) {
    const key = mark.toLowerCase();
    let at = normalized.indexOf(key);
    while (at !== -1) {
      found.push({ text: key, index: at });
      at = normalized.indexOf(key, at + 1);
    }
  });

  const CODE_RE = /(?:\d{1,4}\s*号?(?:航站楼|候机楼|楼|口|门|馆|站|区|路|街|号线|出口|入口))|(?:[a-z]{1,3}\d{1,3}(?:航站楼|楼|口|门)?)/g;
  let codeHit = CODE_RE.exec(normalized);
  while (codeHit !== null) {
    found.push({ text: codeHit[0].replace(/\s+/g, ''), index: codeHit.index });
    codeHit = CODE_RE.exec(normalized);
  }

  /* 相邻的地名片段要合并：「上海」+「迪士尼」应是「上海迪士尼」，
     「西湖」+「断桥」应是「西湖断桥」，而不是两个互不相干的碎片。 */
  const mergedFound = mergeAdjacent(found);

  const placeMap = new Map();
  mergedFound.forEach(function (item) {
    let text = item.text.trim();
    if (text.length < 2 || text.length > 12) return;
    if (PLACE_NOISE.has(text) || BARE_DROP.has(text)) return;
    if (/^[0-9]+$/.test(text) && LANDMARKS.map(function (m) { return m.toLowerCase(); }).indexOf(text) === -1) return;
    const known = placeMap.get(text);
    if (!known || item.index < known.index) placeMap.set(text, { text: text, index: item.index });
  });

  const places = dropContained(Array.from(placeMap.values()))
    .sort(function (a, b) { return a.index - b.index; })
    .slice(0, 6)
    .map(function (item) { return toDisplay(item.text); });

  /* ---- 时间 ---- */
  const timeRaw = [];
  TIME_HINTS.forEach(function (hint) {
    const at = normalized.indexOf(hint);
    if (at !== -1) timeRaw.push({ text: hint, index: at });
  });
  const times = dropContained(mergeAdjacent(timeRaw))
    .slice(0, 4)
    .map(function (item) { return item.text; });

  /* 意图只对「现场问题」有意义。纯知识类提问（推荐小说、这部电影值得看吗）
     没有地点也没有时间，硬套「能否进入 / 人流与排队」会误导用户。 */
  const sceneContext = places.length > 0 || times.length > 0 || /现场|实时|此刻|现在|当前|今天|今晚/.test(normalized);
  const intents = sceneContext
    ? INTENT_RULES.filter(function (rule) { return rule.pattern.test(normalized); })
    : [];
  return {
    places: unique(places),
    times: unique(times),
    intents: intents.slice(0, 4).map(function (rule) { return { code: rule.code, label: rule.label, short: rule.short }; })
  };
}

export function terms(question) {
  const normalized = normalize(question);
  /* 提问口吻与时间词（自己、推荐、来得及…）不携带主题信息，不参与关键词匹配。 */
  const grams = bigrams(normalized).filter(function (gram) { return !isWeakTerm(gram); });
  const counts = new Map();
  grams.forEach(function (gram) { counts.set(gram, (counts.get(gram) || 0) + 1); });
  const ranked = Array.from(counts.entries())
    .sort(function (a, b) { return b[1] - a[1]; })
    .map(function (entry) { return entry[0]; });
  return unique(ranked.concat(latinWords(normalized))).slice(0, 40);
}

function overlapScore(haystack, queryTerms, weight) {
  const target = normalize(haystack);
  let score = 0;
  const hits = [];
  queryTerms.forEach(function (term) {
    if (target.indexOf(term) !== -1) {
      score += weight;
      hits.push(term);
    }
  });
  return { score: score, hits: hits };
}

export function scoreDoc(doc, queryTerms, entities) {
  const title = overlapScore(doc.title, queryTerms, 3.2);
  const description = overlapScore(doc.description || '', queryTerms, 1.15);
  const labelsJoined = (doc.labels || []).join(' ');
  const labels = overlapScore(labelsJoined, queryTerms, 2.4);

  const labelHits = entities.places
    .concat(entities.times)
    .concat(entities.intents.map(function (intent) { return intent.label.replace(/\s*\/\s*/g, ' '); }))
    .filter(function (needle) { return labelsJoined.indexOf(needle) !== -1; });

  const titleStrong = title.hits.filter(function (term) { return !isWeakTerm(term); });
  const labelStrong = labels.hits.filter(function (term) { return !isWeakTerm(term); });
  const descStrong = description.hits.filter(function (term) { return !isWeakTerm(term); });
  const matched = unique(titleStrong.concat(labelStrong, descStrong));

  /* 命中条件：
     1) 必须命中标题、标签，或问题里的明确场景词——正文巧合不算；
     2) 满足下面任意一条才算合格：
        a. 至少两个不同实词命中（最稳妥）；
        b. 标题里出现实词——标题是内容主题的最强信号，同义改写的问法
           （「怎么让自己更专注」对「专注力提升」）常常只命中一个词，
           卡在「两个词」上会把真正相关的内容漏掉。
     命中一个词时要求它是标题词，正文单点巧合仍然不算，避免无关内容被带进来。 */
  const anchored = titleStrong.length > 0 || labelStrong.length > 0 || labelHits.length > 0;
  const qualified = anchored && ((matched.length + labelHits.length) >= 2 || titleStrong.length > 0);

  const strongCount =
    titleStrong.length * 3.2 + labelStrong.length * 2.4 + labelHits.length * 2.5 + descStrong.length * 1.15;

  const meaningful = queryTerms.filter(function (term) { return !isWeakTerm(term); });
  const denom = Math.max(1, Math.min(meaningful.length, 16));
  const coverage = Math.round((matched.length / denom) * 1000) / 1000;
  const relevance = Math.min(100, Math.round((matched.length / denom) * 100));

  const reasons = [];
  if (labelStrong.length) reasons.push('标签命中：' + labelStrong.slice(0, 3).join('、'));
  if (titleStrong.length) reasons.push('标题命中：' + titleStrong.slice(0, 3).join('、'));
  if (labelHits.length) reasons.push('场景匹配：' + labelHits.slice(0, 2).join('、'));
  if (!reasons.length && descStrong.length) reasons.push('正文命中：' + descStrong.slice(0, 3).join('、'));

  return {
    doc: doc,
    qualified: qualified,
    score: Math.round(strongCount * 100) / 100,
    relevance: relevance,
    keywords: matched.slice(0, 8),
    coverage: coverage,
    reasons: reasons,
    hitTerms: matched.slice(0, 8)
  };
}

export function rankDocs(docs, question, limit) {
  const queryTerms = terms(question);
  const entities = extractEntities(question);
  const scored = docs
    .map(function (doc) { return scoreDoc(doc, queryTerms, entities); })
    .filter(function (item) { return item.qualified; })
    .sort(function (a, b) {
      if (b.relevance !== a.relevance) return b.relevance - a.relevance;
      return b.score - a.score;
    });
  const picked = scored.slice(0, limit || 6);
  return { queryTerms: queryTerms, entities: entities, matches: picked, considered: docs.length };
}

export function buildAnalysis(question, ranked) {
  const entities = ranked.entities;
  const matches = ranked.matches;
  const knownFacts = [];
  if (matches.length) {
    knownFacts.push('知乎已有 ' + matches.length + ' 篇与「' + (entities.places[0] || question.slice(0, 12)) + '」相关的公开内容，可作为背景参考。');
    const topLabels = unique(matches.flatMap(function (item) { return item.doc.labels || []; })).slice(0, 5);
    if (topLabels.length) knownFacts.push('相关内容的常见标签：' + topLabels.join('、') + '。');
  } else {
    knownFacts.push('知乎内容库现有 ' + ranked.considered + ' 篇公开内容，逐条比对后没有一篇与这个问题直接相关。我们不用无关内容充数。');
  }
  /* 未知项按「地点 + 用户真正关心的那件事」生成，避免出现与提问无关的套话。
     用户没问「能不能进」，就不要硬塞一条「是否开放」。 */
  const place = entities.places[0] || '';
  const unknownFacts = [];
  const seenIntent = new Set();
  entities.intents.forEach(function (intent) {
    if (seenIntent.has(intent.code)) return;
    seenIntent.add(intent.code);
    const ask = INTENT_QUESTIONS[intent.code] || '此刻的真实现状如何';
    unknownFacts.push(place ? '「' + place + '」' + ask : '现场' + ask);
  });
  if (!unknownFacts.length) {
    unknownFacts.push(place ? '「' + place + '」此刻的现场状况如何' : '此刻的现场状况如何');
  }
  unknownFacts.push(entities.times.length
    ? '「' + entities.times[0] + '」这个时间点，上面的信息是否还成立'
    : '这条信息是否仍然有效');
  return {
    entities: entities,
    knownFacts: knownFacts,
    unknownFacts: unique(unknownFacts).slice(0, 5),
    confidence: matches.length ? '有背景资料，仍需现场确认' : '缺少依据，必须现场确认'
  };
}
