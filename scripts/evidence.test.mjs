/* 在场 — 证据判定回归测试
 * 运行： node scripts/evidence.test.mjs
 */
import { classify, evaluate, freshnessOf } from '../lib/evidence.js';
import { extractEntities, rankDocs, terms } from '../lib/matcher.js';

let pass = 0;
let fail = 0;
const failures = [];

function check(name, condition, detail) {
  if (condition) { pass += 1; }
  else { fail += 1; failures.push(name + (detail ? ' → ' + detail : '')); }
}

function codes(content, relation) {
  return classify(content, relation || 'witness').signals.map(function (s) { return s.code; }).sort().join(',');
}

/* ---------- 1. 基础信号识别 ---------- */
check('开放被识别', codes('入口是开放的').includes('open'), codes('入口是开放的'));
check('“门口还开着”被识别为开放', codes('我在现场，入口是开着的').includes('open'), codes('我在现场，入口是开着的'));
check('“没开着”不算开放', !codes('今天没开着').includes('open'), codes('今天没开着'));
check('关闭被识别', codes('今天闭馆了').includes('closed'), codes('今天闭馆了'));
check('排队被识别', codes('安检口排队 15 分钟').includes('crowded'), codes('安检口排队 15 分钟'));
check('通畅被识别', codes('不用排队，直接进').includes('clear'), codes('不用排队，直接进'));
check('风险被识别', codes('路口积水了').includes('hazard'), codes('路口积水了'));
check('正常被识别', codes('一切正常').includes('normal'), codes('一切正常'));

/* ---------- 2. 曾经的误判，必须不再出现 ---------- */
check('“闭馆时间是九点”不判为关闭', !codes('闭馆时间是晚上九点').includes('closed'), codes('闭馆时间是晚上九点'));
check('“开放到晚上九点”保留开放', codes('开放到晚上九点').includes('open'), codes('开放到晚上九点'));
check('“不堵”不判为拥堵', !codes('路上不堵，很快就到').includes('crowded'), codes('路上不堵，很快就到'));
check('“排队不算长”不判为拥堵', !codes('值机柜台排队不算长').includes('crowded'), codes('值机柜台排队不算长'));
check('“不排队”不算拥堵', !codes('门口不排队').includes('crowded'), codes('门口不排队'));

/* ---------- 3. 五档状态 ---------- */
const none = evaluate([]);
check('无反馈 → pending', none.code === 'pending' && none.confidence === 0, none.code);

const one = evaluate([
  { relationType: 'witness', content: '我在现场，入口开放，排队大概二十分钟。' }
]);
check('单条独立反馈 → single', one.code === 'single' && one.confidence === 30, one.code);

const twoAgree = evaluate([
  { relationType: 'witness', content: '我刚到，入口开放，人不多。' },
  { relationType: 'witness', content: '我在这里，可以正常进，安检很快。' }
]);
check('两条独立一致 → corroborated', twoAgree.code === 'corroborated' && twoAgree.confidence === 70, twoAgree.code);

const conflict = evaluate([
  { relationType: 'witness', content: '门口排队很长，人非常多，进不去。' },
  { relationType: 'witness', content: '不用排队，很空，直接进就行。' }
]);
check('互相矛盾 → conflict', conflict.code === 'conflict', conflict.code);
check('冲突状态列出分歧点', (conflict.conflicts || []).length > 0, JSON.stringify(conflict.conflicts));

const official = evaluate([
  { relationType: 'witness', content: '我在现场，入口开放，人不多。' },
  { relationType: 'official', content: '园区官方公告显示正常开放。' }
]);
check('官方渠道 → verified', official.code === 'verified' && official.confidence === 80, official.code);

/* ---------- 3.4 否定式与口语说法（关键回归：会翻转结论） ---------- */
check('“暂停开放”判为关闭', codes('官方通知今日暂停开放').includes('closed'), codes('官方通知今日暂停开放'));
check('“暂停开放”不再误判为开放', !codes('官方通知今日暂停开放').includes('open'), codes('官方通知今日暂停开放'));
check('“不能进”判为关闭', codes('今天不能进').includes('closed'), codes('今天不能进'));
check('“不能进”不再误判为开放', !codes('今天不能进').includes('open'), codes('今天不能进'));
check('“没开门”判为关闭', codes('还没有开门').includes('closed'), codes('还没有开门'));
check('“没开门”不再误判为开放', !codes('还没有开门').includes('open'), codes('还没有开门'));
check('“人山人海”判为拥堵', codes('人山人海').includes('crowded'), codes('人山人海'));
check('“水泄不通”判为拥堵', codes('水泄不通').includes('crowded'), codes('水泄不通'));
check('“通行顺畅”判为通畅', codes('通行顺畅').includes('clear'), codes('通行顺畅'));
check('“人流少了些，通行顺畅”判为通畅', codes('人流比刚才少了些，通行顺畅').includes('clear'), codes('人流比刚才少了些，通行顺畅'));
check('“人不算多”判为通畅', codes('人不算多').includes('clear'), codes('人不算多'));
check('“比较空”判为通畅', codes('比较空').includes('clear'), codes('比较空'));
check('“没什么人”判为通畅', codes('没什么人').includes('clear'), codes('没什么人'));
check('“不拥挤”判为通畅', codes('现场不拥挤').includes('clear'), codes('现场不拥挤'));
check('“很好走”判为通畅', codes('不堵车，很好走').includes('clear'), codes('不堵车，很好走'));
check('“不顺畅”不会被当成通畅', !codes('路况不顺畅').includes('clear'), codes('路况不顺畅'));
check('关闭与通畅可以并存', codes('暂停开放，但周边道路通行顺畅').includes('closed') && codes('暂停开放，但周边道路通行顺畅').includes('clear'), codes('暂停开放，但周边道路通行顺畅'));

/* ---------- 3.5 不同维度不算冲突（关键） ---------- */
const crossDimension = evaluate([
  { relationType: 'witness', content: '我刚从T3出来，入口开放，安检排队大概15分钟。' },
  { relationType: 'witness', content: '我在T3，可以正常进，值机柜台排队不算长。' }
]);
check('排队与开放不是矛盾', crossDimension.code === 'corroborated', crossDimension.code);
check('不同维度不产生分歧点', (crossDimension.conflicts || []).length === 0, JSON.stringify(crossDimension.conflicts));

const queueVsClear = evaluate([
  { relationType: 'witness', content: '门口排了很长的队，人非常多。' },
  { relationType: 'witness', content: '不用排队，很空，直接进就行。' }
]);
check('排队与不排队才是矛盾', queueVsClear.code === 'conflict', queueVsClear.code);

const openVsClosed = evaluate([
  { relationType: 'witness', content: '入口正常开放，可以进。' },
  { relationType: 'witness', content: '今天闭馆了，进不去。' }
]);
check('开放与关闭才是矛盾', openVsClosed.code === 'conflict', openVsClosed.code);

const officialPlusWitness = evaluate([
  { relationType: 'witness', content: '入口开放，排队大概十分钟。' },
  { relationType: 'official', content: '官方公告：今日正常开放。' }
]);
check('官方与现场一致 → verified', officialPlusWitness.code === 'verified', officialPlusWitness.code);

const officialConflict = evaluate([
  { relationType: 'witness', content: '现在闭馆了，进不去。' },
  { relationType: 'official', content: '官方公告：今日正常开放。' }
]);
check('官方与现场矛盾优先报冲突', officialConflict.code === 'conflict', officialConflict.code);

/* ---------- 3.6 限流不等于关闭（关键回归） ---------- */
check('“正常开放，实施限流”不判为关闭', !codes('官方公告：正常开放，实施限流').includes('closed'), codes('官方公告：正常开放，实施限流'));
check('“限流”会被单独标记', codes('官方公告：正常开放，实施限流').includes('throttled'), codes('官方公告：正常开放，实施限流'));
check('“不限流”不产生任何管控信号', !codes('现场不限流，随到随进').includes('throttled'), codes('现场不限流，随到随进'));
check('“不用预约”不产生管控信号', !codes('不用预约，直接进').includes('throttled'), codes('不用预约，直接进'));
check('“正常开放”不误判为现场安全正常', !codes('入口正常开放').includes('normal'), codes('入口正开放'));

const throttleOnly = evaluate([
  { relationType: 'official', content: '官方公告：正常开放，实施限流。' }
]);
check('限流公告不产生“开放/关闭”冲突', (throttleOnly.conflicts || []).length === 0, JSON.stringify(throttleOnly.conflicts));
check('限流公告不影响安全维度结论', !(throttleOnly.dimensions || []).some(function (d) { return d.dimension === 'safety' && d.status === '一致'; }), JSON.stringify(throttleOnly.dimensions));

const mixedDim = evaluate([
  { relationType: 'witness', content: '门口排队很长，人非常多。' },
  { relationType: 'witness', content: '不用排队，很空，直接进就行。' },
  { relationType: 'official', content: '官方公告：正常开放，实施限流。' }
]);
check('混合反馈下仍能区分维度', Array.isArray(mixedDim.dimensions) && mixedDim.dimensions.length >= 2, JSON.stringify((mixedDim.dimensions || []).map(function (d) { return d.dimension + ':' + d.status; })));
const accessDim = (mixedDim.dimensions || []).filter(function (d) { return d.dimension === 'access'; })[0];
check('入口维度不被排队分歧污染', Boolean(accessDim) && accessDim.status !== '分歧', JSON.stringify(accessDim));
const flowDim = (mixedDim.dimensions || []).filter(function (d) { return d.dimension === 'flow'; })[0];
check('人流维度正确报出分歧', Boolean(flowDim) && flowDim.status === '分歧', JSON.stringify(flowDim));

/* ---------- 3.7 维度“一致”必须来自两位独立到场者（关键回归） ---------- */
function dimOf(ev2, name) {
  return ((ev2 && ev2.dimensions) || []).filter(function (d) { return d.dimension === name; })[0] || null;
}

const onePersonManyDims = evaluate([
  { relationType: 'witness', content: '我刚到现场，入口开放，人不多，一切正常。' }
]);
check('单条反馈的任何维度都不算“一致”',
  (onePersonManyDims.dimensions || []).length > 0 && (onePersonManyDims.dimensions || []).every(function (d) { return d.status !== '一致'; }),
  JSON.stringify((onePersonManyDims.dimensions || []).map(function (d) { return d.dimension + ':' + d.status; })));

const oneDimTwoPeople = evaluate([
  { relationType: 'witness', content: '入口开放，可以进。' },
  { relationType: 'witness', content: '入口是开放的，能进。' }
]);
const okDim = dimOf(oneDimTwoPeople, 'access');
check('同维度两位独立到场者一致 → 一致', Boolean(okDim) && okDim.status === '一致', JSON.stringify(okDim));

const splitDims = evaluate([
  { relationType: 'witness', content: '入口开放，可以进。' },
  { relationType: 'witness', content: '人很多，排队很长。' }
]);
const splitAccess = dimOf(splitDims, 'access');
const splitFlow = dimOf(splitDims, 'flow');
check('只有一人提过的维度不再误判为一致', Boolean(splitAccess) && splitAccess.status === '单一', JSON.stringify(splitAccess));
check('另一维度同样保持单一', Boolean(splitFlow) && splitFlow.status === '单一', JSON.stringify(splitFlow));
check('维度结论携带持该结论的人数', Boolean(splitAccess) && splitAccess.witnesses === 1, JSON.stringify(splitAccess));
/* ---------- 4. 去重与权重 ---------- */
const duplicate = evaluate([
  { relationType: 'witness', content: '入口开放，人不多。' },
  { relationType: 'witness', content: '入口开放，人不多。' }
]);
check('重复内容不计入独立来源', duplicate.stats.independent === 1, JSON.stringify(duplicate.stats));
check('重复内容回到 single', duplicate.code === 'single', duplicate.code);

const relayOnly = evaluate([
  { relationType: 'relay', content: '我朋友说入口开放。' },
  { relationType: 'relay', content: '听说队伍不长，可以进。' }
]);
check('转述不计入独立来源', relayOnly.stats.independent === 0, JSON.stringify(relayOnly.stats));

/* ---------- 5. 时间点不该污染判断 ---------- */
const timeOnly = evaluate([
  { relationType: 'witness', content: '营业时间是早上九点到晚上九点。' }
]);
check('纯时间表述不产生关闭信号', !(timeOnly.signals || []).some(function (s) { return s.code === 'closed'; }), JSON.stringify(timeOnly.signals));

/* ---------- 6. 时效：此刻类问题里，旧观察不能当新证据（关键） ---------- */
const H = 3600000;
const base = new Date('2026-09-11T12:00:00Z').getTime();
const at = function (hoursAgo) { return new Date(base - hoursAgo * H).toISOString(); };

check('刚提交的反馈属于现场有效', freshnessOf(at(0.2), base).code === 'live', JSON.stringify(freshnessOf(at(0.2), base)));
check('一小时前的反馈仍然有效', freshnessOf(at(1), base).code === 'live', JSON.stringify(freshnessOf(at(1), base)));
check('三小时前的反馈标记为仍然新鲜', freshnessOf(at(3), base).code === 'recent', JSON.stringify(freshnessOf(at(3), base)));
check('一天前的反馈标记为开始过时', freshnessOf(at(24), base).code === 'aging', JSON.stringify(freshnessOf(at(24), base)));
check('三天前的反馈标记为已过时', freshnessOf(at(72), base).code === 'stale', JSON.stringify(freshnessOf(at(72), base)));
check('缺失时间的反馈按有效处理', freshnessOf(null, base).code === 'live', JSON.stringify(freshnessOf(null, base)));

const freshPair = evaluate([
  { relationType: 'witness', createdAt: at(0.5), content: '我刚到，入口开放，人不多。' },
  { relationType: 'witness', createdAt: at(0.8), content: '我也是刚到，入口开着，很快就进。' }
], { now: base });
check('两条新鲜反馈 → 交叉印证', freshPair.code === 'corroborated', freshPair.code);

const stalePair = evaluate([
  { relationType: 'witness', createdAt: at(72), content: '我三天前去过，入口开放，人不多。' },
  { relationType: 'witness', createdAt: at(96), content: '我前几天去过，入口开着，很快就进。' }
], { now: base });
check('两条已过时反馈不算独立证据', stalePair.stats.independent === 0, JSON.stringify(stalePair.stats));
check('两条已过时反馈回到待确认', stalePair.code === 'pending', stalePair.code);
check('已过时条数被统计出来', stalePair.stats.stale === 2, JSON.stringify(stalePair.stats));
check('结论里说明旧反馈为何被排除', stalePair.reason.indexOf('48 小时') !== -1, stalePair.reason);

const mixedAge = evaluate([
  { relationType: 'witness', createdAt: at(0.3), content: '我刚到，入口开放，人不多。' },
  { relationType: 'witness', createdAt: at(72), content: '我三天前去过，入口开放，人不多，很顺畅。' }
], { now: base });
check('旧的同类反馈不能把单条抬成交叉印证', mixedAge.code === 'single', mixedAge.code);
check('旧的反馈被标记为过时', mixedAge.stats.stale === 1, JSON.stringify(mixedAge.stats));

const agingOnly = evaluate([
  { relationType: 'witness', createdAt: at(24), content: '我昨天去过，入口开放，人不多。' }
], { now: base });
check('一天前的单一反馈仍给出线索', agingOnly.code === 'single', agingOnly.code);
check('过时提示会写入结论', agingOnly.reason.indexOf('已经过去') !== -1, agingOnly.reason);
check('时效信息可被前端读取', Boolean(agingOnly.freshness) && agingOnly.freshness.code === 'aging', JSON.stringify(agingOnly.freshness));

/* ---------- 7. 问题理解：地点与时间必须抓得准（关键回归） ---------- */
function places(q) { return extractEntities(q).places; }
function times(q) { return extractEntities(q).times; }

check('识别出 798 艺术区', places('今晚798艺术区还开着吗，从东门进要排队多久？').some(function (p) { return p.indexOf('798') !== -1; }), JSON.stringify(places('今晚798艺术区还开着吗')));
check('识别出东门', places('今晚798艺术区还开着吗，从东门进要排队多久？').indexOf('东门') !== -1, JSON.stringify(places('今晚798艺术区还开着吗，从东门进要排队多久？')));
check('识别出西湖断桥', places('此刻西湖断桥人多吗，现在去合适吗').indexOf('西湖断桥') !== -1, JSON.stringify(places('此刻西湖断桥人多吗')));
check('识别出故宫', places('明天早上故宫几点开门，要提前预约吗').indexOf('故宫') !== -1, JSON.stringify(places('明天早上故宫几点开门')));
check('识别出首都机场', places('现在去首都机场 T3 还来得及吗？安检排队多久？').indexOf('首都机场') !== -1, JSON.stringify(places('现在去首都机场 T3 还来得及吗')));
check('识别出 T3', places('现在去首都机场 T3 还来得及吗？安检排队多久？').some(function (p) { return /^T3$/i.test(p); }), JSON.stringify(places('现在去首都机场 T3 还来得及吗')));
check('识别出美术馆', places('今天下午美术馆要排队多久').indexOf('美术馆') !== -1, JSON.stringify(places('今天下午美术馆要排队多久')));
check('泛称「主路」不当地点', places('暴雨过后这条主路现在能通行吗').indexOf('主路') === -1, JSON.stringify(places('暴雨过后这条主路现在能通行吗')));
check('地点里不带时间词', places('此刻西湖断桥人多吗').every(function (p) { return p.indexOf('此刻') === -1; }), JSON.stringify(places('此刻西湖断桥人多吗')));
check('「还来得及」不算时间', times('现在去首都机场 T3 还来得及吗？安检排队多久？').indexOf('还来得及') === -1, JSON.stringify(times('现在去首都机场 T3 还来得及吗')));
check('「几点」不算时间', times('明天早上故宫几点开门，要提前预约吗').indexOf('几点') === -1, JSON.stringify(times('明天早上故宫几点开门')));
check('「今晚」算时间', times('今晚798艺术区还开着吗').indexOf('今晚') !== -1, JSON.stringify(times('今晚798艺术区还开着吗')));
check('「明天早上」合并成一个时间点', times('明天早上故宫几点开门').indexOf('明天早上') !== -1, JSON.stringify(times('明天早上故宫几点开门')));
check('「今天下午」合并成一个时间点', times('今天下午美术馆要排队多久').indexOf('今天下午') !== -1, JSON.stringify(times('今天下午美术馆要排队多久')));
check('时间点最多四个', times('今天早上、中午、下午、晚上、凌晨都想去').length <= 4, JSON.stringify(times('今天早上、中午、下午、晚上、凌晨都想去')));
check('地点最多六个', places('故宫天安门长城西湖外滩三里屯南锣鼓巷兵马俑黄山泰山').length <= 6, JSON.stringify(places('故宫天安门长城西湖外滩三里屯南锣鼓巷兵马俑黄山泰山')));

check('完整枢纽名不被切碎', places('上海虹桥火车站现在人多吗').indexOf('上海虹桥火车站') !== -1, JSON.stringify(places('上海虹桥火车站现在人多吗')));
check('不产生「海虹桥火车站」这类碎片', places('上海虹桥火车站现在人多吗').every(function (p) { return p !== '海虹桥火车站'; }), JSON.stringify(places('上海虹桥火车站现在人多吗')));
check('「首都机场」与「机场」不重复出现', (function () { const list = places('现在去首都机场 T3 还来得及吗'); return list.indexOf('首都机场') !== -1 && list.indexOf('机场') === -1; })(), JSON.stringify(places('现在去首都机场 T3 还来得及吗')));
check('泛称「那个超市」不当地点', places('我家附近那个超市几点关门').length === 0, JSON.stringify(places('我家附近那个超市几点关门')));
check('「深圳北站停车场」保留完整', places('深圳北站停车场还有车位吗').indexOf('深圳北站停车场') !== -1, JSON.stringify(places('深圳北站停车场还有车位吗')));
check('无关生活问题不误判地点', places('怎么才能提高工作效率').length === 0, JSON.stringify(places('怎么才能提高工作效率')));

/* ---------- 8. 相关度不虚高、不把无关内容当依据（关键回归） ---------- */
const fakeDocs = [
  { id: 'a', title: '职场：如何让老板给我升职加薪？', description: '和老板谈加薪的几个准备', labels: ['职场', '加薪'], url: 'https://example.com/a' },
  { id: 'b', title: '惊悚故事：午夜敲门声', description: '一个关于深夜敲门的故事', labels: ['悬疑'], url: 'https://example.com/b' }
];
const rankedFake = rankDocs(fakeDocs, '职场里怎么跟老板提升职加薪', 6);
check('相关问题能命中', rankedFake.matches.length === 1, JSON.stringify(rankedFake.matches.map(function (m) { return m.doc.id; })));
check('命中项列出具体命中词', rankedFake.matches.length === 1 && rankedFake.matches[0].keywords.length >= 2, JSON.stringify(rankedFake.matches[0] && rankedFake.matches[0].keywords));
const rankedNone = rankDocs(fakeDocs, '此刻西湖断桥人多吗，现在去合适吗', 6);
check('无关问题不硬凑结果', rankedNone.matches.length === 0, JSON.stringify(rankedNone.matches.map(function (m) { return m.doc.id; })));
check('问题被拆成可用关键词', terms('职场里怎么跟老板提升职加薪').indexOf('职场') !== -1, JSON.stringify(terms('职场里怎么跟老板提升职加薪').slice(0, 10)));

/* ---------- 9. 关键词与地名抽取的真实缺陷（关键回归） ---------- */
/* 「被动」「对话」这类词含虚词，但本身是实义主题词，不能被切掉。 */
check('「被动」不被虚词过滤误伤', terms('如何从被动的人变成主动的人').indexOf('被动') !== -1, JSON.stringify(terms('如何从被动的人变成主动的人')));
const passiveDoc = [{ id: 'p', title: '如何从心理被动的人慢慢变为主动的人？', description: '被动与主动的心理转变', labels: [], url: 'https://example.com/p' }];
check('含「被动」的问题能命中对应内容', rankDocs(passiveDoc, '如何从被动的人变成主动的人', 6).matches.length === 1, JSON.stringify(rankDocs(passiveDoc, '如何从被动的人变成主动的人', 6).matches.map(function (m) { return m.keywords; })));
check('提问口吻词不进关键词', terms('怎么让自己专注起来').indexOf('自己') === -1, JSON.stringify(terms('怎么让自己专注起来')));
check('「推荐」不进关键词', terms('推荐几本无限流小说').indexOf('推荐') === -1, JSON.stringify(terms('推荐几本无限流小说')));
check('「让座」保留完整', terms('他让座给别人').indexOf('让座') !== -1, JSON.stringify(terms('他让座给别人')));

/* 「大」「达」常出现在地名里，不能被当成停用字。 */
check('「朝阳大悦城」不被切成「悦城」', places('朝阳大悦城现在停车方便吗').indexOf('朝阳大悦城') !== -1, JSON.stringify(places('朝阳大悦城现在停车方便吗')));
check('「万达广场」不被整条丢掉', places('万达广场现在人多吗').indexOf('万达广场') !== -1, JSON.stringify(places('万达广场现在人多吗')));
check('「八达岭长城」保留完整', places('八达岭长城现在人多吗').indexOf('八达岭长城') !== -1, JSON.stringify(places('八达岭长城现在人多吗')));
check('「成都东站」保留完整', places('去成都东站要多久').indexOf('成都东站') !== -1, JSON.stringify(places('去成都东站要多久')));
check('「深圳湾公园」保留完整', places('深圳湾公园现在开放吗').indexOf('深圳湾公园') !== -1, JSON.stringify(places('深圳湾公园现在开放吗')));

/* 常见动词（回 / 出 / 进 / 乘 / 坐 / 打）当过停用字，会把真实地名截断。
   「回龙观」被切成「龙观」、「出站」被当成地名，都是实测出来的反例。 */
check('「回龙观地铁站」不被切成「龙观地铁站」', places('回龙观地铁站现在人多吗').indexOf('回龙观地铁站') !== -1, JSON.stringify(places('回龙观地铁站现在人多吗')));
check('「去回龙观地铁站」同样保留完整', places('去回龙观地铁站要多久').indexOf('回龙观地铁站') !== -1, JSON.stringify(places('去回龙观地铁站要多久')));
check('「回民街」不被截断', places('回民街现在人多吗，要排队吗').indexOf('回民街') !== -1, JSON.stringify(places('回民街现在人多吗，要排队吗')));
check('「出站」不当地点', places('首都机场 T3 出站堵不堵').indexOf('出站') === -1, JSON.stringify(places('首都机场 T3 出站堵不堵')));
check('「进站」不当地点', places('东直门地铁站进站排队吗').indexOf('进站') === -1, JSON.stringify(places('东直门地铁站进站排队吗')));
check('「去八达岭长城」保留完整', places('去八达岭长城堵车吗').indexOf('八达岭长城') !== -1, JSON.stringify(places('去八达岭长城堵车吗')));
check('「上海迪士尼」识别到地标本身', places('上海迪士尼现在排队要多久').some(function (x) { return x.indexOf('迪士尼') !== -1; }), JSON.stringify(places('上海迪士尼现在排队要多久')));
check('相邻地名片段会合并成一个地点', places('上海迪士尼现在排队要多久').some(function (x) { return x === '上海迪士尼'; }), JSON.stringify(places('上海迪士尼现在排队要多久')));
check('「北京南站」与「国贸」都识别到', (function () { const list = places('从北京南站打车到国贸要多久'); return list.indexOf('北京南站') !== -1 && list.indexOf('国贸') !== -1; })(), JSON.stringify(places('从北京南站打车到国贸要多久')));

/* 「还开着吗」是最口语的开放问法，不能被漏掉（实测「今晚798艺术区还开着吗」曾识别不出）。 */
function intents(q) { return extractEntities(q).intents.map(function (i) { return i.code; }); }
check('「还开着吗」识别为能否进入', intents('今晚798艺术区还开着吗，从东门进要排队多久').indexOf('access') !== -1, JSON.stringify(intents('今晚798艺术区还开着吗，从东门进要排队多久')));
check('「现在开着吗」识别为能否进入', intents('医院急诊现在还开着吗').indexOf('access') !== -1, JSON.stringify(intents('医院急诊现在还开着吗')));
check('「开了吗」识别为能否进入', intents('商场今天开了吗').indexOf('access') !== -1, JSON.stringify(intents('商场今天开了吗')));
check('「开车」不被误判为开放', intents('现在开车过去堵不堵').indexOf('access') === -1, JSON.stringify(intents('现在开车过去堵不堵')));

/* ---------- 输出 ---------- */
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
if (failures.length) {
  failures.forEach(function (item) { console.log('  ✗ ' + item); });
  process.exit(1);
}
console.log('EVIDENCE_TESTS_OK');
