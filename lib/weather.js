/* 在场 Zaichang — 真实气象信号（环境信号层）
   原则：
   1. 只用真实数据源（Open-Meteo，免费、无需密钥）；拿不到就如实说拿不到，绝不编造。
   2. 地点坐标优先查内置坐标表（人工核对过），网络地名检索只作补充。
      实测 Open-Meteo 的地名检索会把「西湖」解析到重庆、「断桥」解析到四川，
      因此不能只依赖上游检索，否则会把用户带到错误的地方。
   3. 结果按地点缓存 10 分钟；失败结果短缓存 60 秒，避免反复打上游。
   4. 气象只是「环境信号」，不能替代现场的人。页面必须显示数据来源与观测时间。 */

const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';
const GEOCODE_URL = 'https://geocoding-api.open-meteo.com/v1/search';
const CACHE_TTL = 10 * 60 * 1000;
const FAIL_TTL = 60 * 1000;
const TIMEOUT_MS = 7000;
const HOURLY_HOURS = 6;
const PLACE_MAX = 40;

/* 人工核对过的坐标表：名称|纬度|经度。同名多地取最常被问的那一处。 */
const COORD_TEXT = [
  '北京|39.9042|116.4074',
  '上海|31.2304|121.4737',
  '广州|23.1291|113.2644',
  '深圳|22.5431|114.0579',
  '杭州|30.2741|120.1551',
  '南京|32.0603|118.7969',
  '苏州|31.2989|120.5853',
  '成都|30.5728|104.0668',
  '重庆|29.5630|106.5516',
  '西安|34.3416|108.9398',
  '武汉|30.5928|114.3055',
  '长沙|28.2282|112.9388',
  '青岛|36.0671|120.3826',
  '厦门|24.4798|118.0894',
  '大连|38.9140|121.6147',
  '天津|39.3434|117.3616',
  '香港|22.3193|114.1694',
  '澳门|22.1987|113.5439',
  '台北|25.0330|121.5654',
  '郑州|34.7466|113.6254',
  '济南|36.6512|117.1201',
  '沈阳|41.8057|123.4315',
  '哈尔滨|45.8038|126.5350',
  '昆明|24.8801|102.8329',
  '贵阳|26.6470|106.6302',
  '福州|26.0745|119.2965',
  '合肥|31.8206|117.2272',
  '南昌|28.6820|115.8579',
  '石家庄|38.0428|114.5149',
  '太原|37.8706|112.5489',
  '兰州|36.0611|103.8343',
  '西宁|36.6171|101.7782',
  '银川|38.4872|106.2309',
  '乌鲁木齐|43.8256|87.6168',
  '拉萨|29.6520|91.1721',
  '南宁|22.8170|108.3665',
  '海口|20.0444|110.1999',
  '三亚|18.2528|109.5119',
  '呼和浩特|40.8414|111.7519',
  '长春|43.8171|125.3235',
  '宁波|29.8683|121.5440',
  '无锡|31.4912|120.3119',
  '温州|27.9938|120.6994',
  '佛山|23.0219|113.1214',
  '东莞|23.0207|113.7518',
  '珠海|22.2710|113.5767',
  '泉州|24.8741|118.6757',
  '烟台|37.4638|121.4479',
  '洛阳|34.6197|112.4540',
  '桂林|25.2736|110.2900',
  '敦煌|40.1421|94.6616',
  '徐州|34.2058|117.2848',
  '常州|31.8107|119.9741',
  '南通|31.9802|120.8943',
  '绍兴|30.0303|120.5802',
  '嘉兴|30.7469|120.7554',
  '湖州|30.8927|120.0864',
  '金华|29.0784|119.6474',
  '台州|28.6560|121.4207',
  '义乌|29.3069|120.0753',
  '昆山|31.3856|120.9807',
  '廊坊|39.5379|116.6835',
  '保定|38.8740|115.4646',
  '唐山|39.6304|118.1802',
  '秦皇岛|39.9354|119.6005',
  '承德|40.9515|117.9634',
  '大同|40.0768|113.3001',
  '包头|40.6574|109.8403',
  '淄博|36.8131|118.0548',
  '潍坊|36.7069|119.1618',
  '临沂|35.1045|118.3564',
  '开封|34.7971|114.3074',
  '南阳|32.9908|112.5286',
  '襄阳|32.0090|112.1224',
  '宜昌|30.6919|111.2865',
  '岳阳|29.3573|113.1289',
  '株洲|27.8274|113.1340',
  '湘潭|27.8295|112.9445',
  '衡阳|26.8938|112.5718',
  '赣州|25.8310|114.9348',
  '九江|29.7051|116.0019',
  '芜湖|31.3525|118.4331',
  '扬州|32.3942|119.4129',
  '镇江|32.1877|119.4250',
  '泰州|32.4558|119.9230',
  '盐城|33.3496|120.1615',
  '淮安|33.5975|119.0214',
  '连云港|34.5967|119.2216',
  '济宁|35.4149|116.5871',
  '泰安|36.1994|117.0879',
  '威海|37.5128|122.1201',
  '日照|35.4164|119.5269',
  '德州|37.4355|116.3574',
  '聊城|36.4568|115.9853',
  '安阳|36.1034|114.3931',
  '新乡|35.3030|113.9268',
  '焦作|35.2158|113.2418',
  '许昌|34.0357|113.8524',
  '信阳|32.1470|114.0911',
  '商丘|34.4146|115.6564',
  '周口|33.6258|114.6969',
  '驻马店|33.0140|114.0226',
  '三门峡|34.7733|111.2003',
  '平顶山|33.7661|113.1926',
  '运城|35.0262|111.0039',
  '临汾|36.0880|111.5190',
  '长治|36.1954|113.1163',
  '晋城|35.4907|112.8513',
  '阳泉|37.8567|113.5804',
  '忻州|38.4166|112.7342',
  '晋中|37.6870|112.7528',
  '吕梁|37.5184|111.1444',
  '朔州|39.3317|112.4329',
  '张家口|40.7686|114.8869',
  '沧州|38.3037|116.8388',
  '邢台|37.0682|114.5048',
  '邯郸|36.6253|114.5391',
  '衡水|37.7385|115.6706',
  '东营|37.4340|118.6747',
  '枣庄|34.8107|117.3238',
  '菏泽|35.2333|115.4697',
  '滨州|37.3821|117.9707',
  '沧州|38.3037|116.8388',
  '宝鸡|34.3614|107.2373',
  '咸阳|34.3296|108.7089',
  '渭南|34.4994|109.5100',
  '汉中|33.0679|107.0234',
  '榆林|38.2858|109.7346',
  '延安|36.5853|109.4898',
  '天水|34.5809|105.7249',
  '酒泉|39.7325|98.4941',
  '嘉峪关|39.7729|98.2891',
  '张掖|38.9257|100.4498',
  '武威|37.9283|102.6380',
  '西双版纳|22.0088|100.7975',
  '大理|25.6065|100.2679',
  '丽江|26.8721|100.2299',
  '腾冲|25.0176|98.4900',
  '遵义|27.7256|106.9274',
  '六盘水|26.5920|104.8300',
  '安顺|26.2456|105.9322',
  '柳州|24.3146|109.4281',
  '北海|21.4733|109.1194',
  '玉林|22.6540|110.1647',
  '湛江|21.2707|110.3594',
  '汕头|23.3535|116.6820',
  '惠州|23.1115|114.4161',
  '中山|22.5170|113.3928',
  '江门|22.5787|113.0815',
  '肇庆|23.0470|112.4653',
  '茂名|21.6627|110.9254',
  '揭阳|23.5498|116.3728',
  '梅州|24.2886|116.1225',
  '韶关|24.8104|113.5972',
  '清远|23.6817|113.0562',
  '莆田|25.4310|119.0078',
  '三明|26.2634|117.6389',
  '漳州|24.5133|117.6473',
  '龙岩|25.0751|117.0173',
  '南平|26.6417|118.1775',
  '宁德|26.6656|119.5477',
  '嘉兴|30.7469|120.7554',
  '舟山|29.9853|122.2073',
  '丽水|28.4518|119.9225',
  '衢州|28.9700|118.8593',
  '黄山|30.1330|118.1650',
  '安庆|30.5086|117.0470',
  '蚌埠|32.9163|117.3893',
  '阜阳|32.8900|115.8145',
  '宿州|33.6463|116.9643',
  '六安|31.7528|116.5077',
  '马鞍山|31.6705|118.5063',
  '铜陵|30.9445|117.8123',
  '宣城|30.9457|118.7585',
  '滁州|32.3018|118.3167',
  '黄山风景区|30.1330|118.1650',
  '宜春|27.8144|114.4162',
  '吉安|27.1139|114.9929',
  '上饶|28.4548|117.9434',
  '景德镇|29.2688|117.1784',
  '萍乡|27.6229|113.8548',
  '新余|27.8175|114.9174',
  '抚州|27.9490|116.3582',
  '鹰潭|28.2601|117.0695',
  '首都机场|40.0801|116.5846',
  '首都机场t1|40.0799|116.6031',
  '首都机场t2|40.0799|116.6031',
  '首都机场t3|40.0525|116.6110',
  '大兴机场|39.5098|116.4105',
  '浦东机场|31.1443|121.8083',
  '虹桥机场|31.1979|121.3363',
  '白云机场|23.3924|113.2988',
  '宝安机场|22.6393|113.8107',
  '天府机场|30.3125|104.4418',
  '双流机场|30.5785|103.9471',
  '咸阳机场|34.4471|108.7516',
  '萧山机场|30.2295|120.4344',
  '禄口机场|31.7420|118.8620',
  '新郑机场|34.5197|113.8409',
  '遥墙机场|36.8572|117.2160',
  '周水子机场|38.9657|121.5386',
  '高崎机场|24.5440|118.1277',
  '江北机场|29.7192|106.6417',
  '长水机场|25.1019|102.9292',
  '龙洞堡机场|26.5385|106.8007',
  '北京西站|39.8949|116.3220',
  '北京站|39.9029|116.4270',
  '北京南站|39.8653|116.3786',
  '北京北站|39.9448|116.3535',
  '上海虹桥站|31.1943|121.3200',
  '上海站|31.2494|121.4559',
  '上海南站|31.1548|121.4290',
  '广州南站|22.9891|113.2688',
  '广州东站|23.1496|113.3255',
  '广州站|23.1490|113.2630',
  '深圳北站|22.6100|114.0290',
  '深圳站|22.5320|114.1180',
  '深圳东站|22.6045|114.1180',
  '南京南站|31.9680|118.7970',
  '南京站|32.0910|118.7990',
  '杭州站|30.2440|120.1830',
  '杭州东站|30.2905|120.2126',
  '杭州西站|30.2980|119.9850',
  '成都东站|30.6290|104.1420',
  '成都南站|30.6060|104.0620',
  '重庆北站|29.6070|106.5560',
  '重庆西站|29.5000|106.4300',
  '武汉站|30.6090|114.4240',
  '汉口站|30.6200|114.2500',
  '武昌站|30.5400|114.3200',
  '西安北站|34.3790|108.9360',
  '西安站|34.2780|108.9600',
  '天津站|39.1350|117.2110',
  '天津西站|39.1730|117.1700',
  '长沙南站|28.1460|113.0640',
  '长沙站|28.1930|113.0100',
  '郑州东站|34.7570|113.7730',
  '济南西站|36.6340|116.8890',
  '青岛北站|36.1220|120.3700',
  '沈阳北站|41.8180|123.4330',
  '哈尔滨西站|45.7060|126.5900',
  '合肥南站|31.8000|117.2800',
  '南昌西站|28.6520|115.7900',
  '福州站|26.1140|119.3170',
  '厦门北站|24.6400|118.0200',
  '昆明南站|24.8700|102.8700',
  '贵阳北站|26.6200|106.6500',
  '南宁东站|22.8420|108.3800',
  '兰州西站|36.0700|103.7600',
  '太原南站|37.7900|112.5900',
  '石家庄站|38.0200|114.4800',
  '798|39.9843|116.4957',
  '798艺术区|39.9843|116.4957',
  '故宫|39.9163|116.3972',
  '天安门|39.9087|116.3975',
  '颐和园|39.9999|116.2755',
  '天坛|39.8822|116.4066',
  '八达岭长城|40.3597|116.0200',
  '慕田峪长城|40.4319|116.5704',
  '居庸关长城|40.2900|116.0700',
  '南锣鼓巷|39.9370|116.4030',
  '什刹海|39.9370|116.3860',
  '后海|39.9370|116.3830',
  '三里屯|39.9370|116.4550',
  '王府井|39.9150|116.4100',
  '西单|39.9070|116.3740',
  '国贸|39.9080|116.4590',
  '中关村|39.9840|116.3170',
  '鸟巢|39.9928|116.3975',
  '水立方|39.9930|116.3904',
  '首钢园|39.9100|116.1800',
  '北京环球度假区|39.8557|116.6747',
  '北京欢乐谷|39.8900|116.5000',
  '北京动物园|39.9400|116.3300',
  '北京植物园|40.0000|116.2100',
  '中国科技馆|39.9970|116.3900',
  '国家博物馆|39.9050|116.4000',
  '首都博物馆|39.9050|116.3600',
  '北京儿童医院|39.9230|116.3400',
  '协和医院|39.9130|116.4170',
  '北大人民医院|39.9370|116.3600',
  '西湖|30.2489|120.1551',
  '断桥|30.2585|120.1509',
  '灵隐寺|30.2400|120.1000',
  '雷峰塔|30.2340|120.1480',
  '苏堤|30.2420|120.1400',
  '河坊街|30.2400|120.1700',
  '西溪湿地|30.2700|120.0700',
  '千岛湖|29.6000|119.0400',
  '外滩|31.2397|121.4909',
  '南京路|31.2350|121.4750',
  '豫园|31.2270|121.4920',
  '陆家嘴|31.2390|121.5030',
  '东方明珠|31.2397|121.4998',
  '上海中心|31.2336|121.5054',
  '上海迪士尼|31.1443|121.6570',
  '上海博物馆|31.2300|121.4740',
  '迪士尼|31.1443|121.6570',
  '广州塔|23.1066|113.3245',
  '小蛮腰|23.1066|113.3245',
  '长隆|23.0000|113.3300',
  '华强北|22.5470|114.0880',
  '世界之窗|22.5390|113.9740',
  '大梅沙|22.5960|114.3100',
  '兵马俑|34.3853|109.2785',
  '秦始皇陵|34.3818|109.2535',
  '大雁塔|34.2186|108.9640',
  '小雁塔|34.2440|108.9500',
  '大唐不夜城|34.2130|108.9640',
  '大唐芙蓉园|34.2160|108.9700',
  '西安钟楼|34.2610|108.9450',
  '回民街|34.2660|108.9400',
  '永兴坊|34.2680|108.9800',
  '大明宫|34.3000|108.9600',
  '华清池|34.3600|109.2100',
  '陕西历史博物馆|34.2270|108.9530',
  '碑林|34.2520|108.9600',
  '宽窄巷子|30.6690|104.0550',
  '成都太古里|30.6520|104.0810',
  '太古里|30.6520|104.0810',
  '锦里|30.6420|104.0430',
  '武侯祠|30.6420|104.0430',
  '杜甫草堂|30.6600|104.0300',
  '大熊猫繁育研究基地|30.7330|104.1470',
  '春熙路|30.6570|104.0810',
  '洪崖洞|29.5630|106.5780',
  '解放碑|29.5570|106.5770',
  '磁器口|29.5830|106.4500',
  '李子坝|29.5620|106.5100',
  '黄鹤楼|30.5450|114.3020',
  '户部巷|30.5480|114.3060',
  '武汉大学|30.5400|114.3600',
  '橘子洲|28.1780|112.9620',
  '岳麓山|28.1800|112.9400',
  '中山陵|32.0600|118.8500',
  '夫子庙|32.0230|118.7900',
  '总统府|32.0450|118.7900',
  '拙政园|31.3240|120.6290',
  '平江路|31.3180|120.6300',
  '虎丘|31.3400|120.5700',
  '金鸡湖|31.3100|120.6800',
  '趵突泉|36.6610|117.0120',
  '大明湖|36.6720|117.0200',
  '泰山|36.2550|117.1000',
  '华山|34.4830|110.0850',
  '嵩山|34.4900|112.9600',
  '峨眉山|29.5200|103.3300',
  '武当山|32.4000|111.0000',
  '普陀山|30.0100|122.3900',
  '五台山|39.0000|113.5900',
  '黄山|30.1330|118.1650',
  '九华山|30.4800|117.8000',
  '鼓浪屿|24.4470|118.0680',
  '环岛路|24.4400|118.1300',
  '曾厝垵|24.4300|118.1200',
  '九寨沟|33.2600|103.9180',
  '张家界|29.1171|110.4792',
  '凤凰古城|27.9480|109.6000',
  '布达拉宫|29.6570|91.1170',
  '大昭寺|29.6530|91.1320',
  '洱海|25.7900|100.1900',
  '大理古城|25.6900|100.1600',
  '丽江古城|26.8721|100.2299',
  '玉龙雪山|27.1000|100.1800',
  '青海湖|36.8900|100.1800',
  '茶卡盐湖|36.7000|99.0800',
  '鸣沙山|40.0900|94.6700',
  '月牙泉|40.0880|94.6680',
  '莫高窟|40.0360|94.8090',
  '龙门石窟|34.5550|112.4700',
  '云冈石窟|40.1100|113.1300',
  '平遥古城|37.2000|112.1800',
  '乔家大院|37.3800|112.5200',
  '乌镇|30.7450|120.4900',
  '周庄|31.1150|120.8500',
  '西塘|30.9450|120.8900',
  '宏村|29.9100|117.9900',
  '婺源|29.2480|117.8620',
  '千户苗寨|26.4900|108.1800',
  '香格里拉|27.8250|99.7000',
  '稻城亚丁|28.4300|100.3300',
  '泸沽湖|27.7000|100.7800',
  '天山天池|43.8900|88.1200',
  '喀纳斯|48.7000|87.0000',
  '呼伦贝尔|49.2000|119.7000',
  '长白山|42.0000|128.0500',
  '亚龙湾|18.2200|109.6300',
  '天涯海角|18.2400|109.3400',
  '蜈支洲岛|18.3100|109.7600',
  '武夷山|27.7500|117.6700',
  '都江堰|31.0000|103.6100',
  '乐山大佛|29.5450|103.7700',
  '三峡大坝|30.8200|111.0000',
  '西递|29.9300|117.9900',
  '南浔古镇|30.8800|120.4300',
  '同里古镇|31.1500|120.7200',
  '甪直古镇|31.2700|120.8700',
  '景德镇陶溪川|29.2900|117.2200'
].join('\n');

/* 别名：把用户常写的简称指到坐标表里的正式名称。 */
const ALIAS_TEXT = [
  '首都t1|首都机场t1',
  '首都t2|首都机场t2',
  '首都t3|首都机场t3',
  't1航站楼|首都机场t1',
  't2航站楼|首都机场t2',
  't3航站楼|首都机场t3',
  '首都机场t1|首都机场t1',
  '首都机场t2|首都机场t2',
  '首都机场t3|首都机场t3',
  '大兴国际机场|大兴机场',
  '北京大兴国际机场|大兴机场',
  '北京首都国际机场|首都机场',
  '上海浦东国际机场|浦东机场',
  '上海虹桥国际机场|虹桥机场',
  '广州白云国际机场|白云机场',
  '深圳宝安国际机场|宝安机场',
  '成都天府国际机场|天府机场',
  '西安咸阳国际机场|咸阳机场',
  '杭州萧山国际机场|萧山机场',
  '南京禄口国际机场|禄口机场',
  '郑州新郑国际机场|新郑机场',
  '济南遥墙国际机场|遥墙机场',
  '大连周水子国际机场|周水子机场',
  '厦门高崎国际机场|高崎机场',
  '重庆江北国际机场|江北机场',
  '昆明长水国际机场|长水机场',
  '贵阳龙洞堡国际机场|龙洞堡机场',
  '天安门广场|天安门',
  '长城|八达岭长城',
  '故宫博物院|故宫',
  '紫禁城|故宫',
  '国家博物馆|国家博物馆',
  '国博|国家博物馆',
  '上海迪士尼乐园|上海迪士尼',
  '上海迪士尼度假区|上海迪士尼',
  '北京环球影城|北京环球度假区',
  '环球影城|北京环球度假区',
  '环球度假区|北京环球度假区',
  '广州长隆|长隆',
  '长隆欢乐世界|长隆',
  '西湖断桥|断桥',
  '断桥残雪|断桥',
  '灵隐|灵隐寺',
  '黄鹤楼公园|黄鹤楼',
  '黄果树|黄果树瀑布',
  '大熊猫基地|大熊猫繁育研究基地',
  '熊猫基地|大熊猫繁育研究基地',
  '西安大雁塔|大雁塔',
  '大唐不夜城步行街|大唐不夜城',
  '钟楼|西安钟楼',
  '鼓楼|西安钟楼',
  '西溪|西溪湿地',
  '宋城|宋城千古情',
  '横店|横店影视城',
  '珠海长隆|长隆',
  '迪士尼小镇|上海迪士尼'
].join('\n');

/* 去掉地名后面常带的方位/设施词，让「杭州东站地铁口」也能命中「杭州东站」。 */
const PLACE_TAIL = ['地铁口', '地铁站', '航站楼', '候机楼', '停车场', '售票处', '检票口', '进站口', '出站口', '换乘站', '附近', '周边', '门口', '入口', '出口', '正门', '东门', '南门', '西门', '北门', '这边', '那边', '里面', '外面', '一带', '商圈'];

const BUILTIN = new Map();
const ALIAS = new Map();

(function parseTables() {
  COORD_TEXT.split('\n').forEach(function (line) {
    const parts = line.split('|');
    if (parts.length !== 3) return;
    const lat = Number(parts[1]);
    const lon = Number(parts[2]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
    BUILTIN.set(parts[0], { name: parts[0], lat: lat, lon: lon });
  });
  ALIAS_TEXT.split('\n').forEach(function (line) {
    const parts = line.split('|');
    if (parts.length !== 2) return;
    ALIAS.set(parts[0], parts[1]);
  });
})();

const BY_LENGTH = Array.from(BUILTIN.keys()).sort(function (a, b) { return b.length - a.length; });

const cache = new Map();

export function normalizePlace(input) {
  let value = String(input == null ? '' : input).toLowerCase().trim();
  if (!value) return '';
  value = value.replace(/[\u3000\s]+/g, '');
  value = value.replace(/[\uff01-\uff5e]/g, function (ch) { return String.fromCharCode(ch.charCodeAt(0) - 0xfee0); });
  value = value.replace(/[，。！？、；：,.!?;:'"“”‘’（）()【】\[\]《》<>·\-—_/\\|]/g, '');
  return value.slice(0, PLACE_MAX);
}

/* 内置表优先：先精确、再别名、再「长名优先」的子串匹配。 */
export function lookupBuiltin(rawPlace) {
  const place = normalizePlace(rawPlace);
  if (!place) return null;
  if (BUILTIN.has(place)) return Object.assign({ source: 'builtin', matched: place, query: String(rawPlace).trim() }, BUILTIN.get(place));

  const aliasTarget = ALIAS.get(place);
  if (aliasTarget && BUILTIN.has(aliasTarget)) {
    return Object.assign({ source: 'alias', matched: aliasTarget, query: String(rawPlace).trim() }, BUILTIN.get(aliasTarget));
  }

  const candidates = [place];
  PLACE_TAIL.forEach(function (tail) {
    if (place.length > tail.length && place.endsWith(tail)) candidates.push(place.slice(0, -tail.length));
  });
  for (let i = 0; i < candidates.length; i += 1) {
    const candidate = candidates[i];
    if (BUILTIN.has(candidate)) {
      return Object.assign({ source: i === 0 ? 'builtin' : 'builtin', matched: candidate, query: String(rawPlace).trim() }, BUILTIN.get(candidate));
    }
    const aliasHit = ALIAS.get(candidate);
    if (aliasHit && BUILTIN.has(aliasHit)) {
      return Object.assign({ source: 'alias', matched: aliasHit, query: String(rawPlace).trim() }, BUILTIN.get(aliasHit));
    }
    for (let j = 0; j < BY_LENGTH.length; j += 1) {
      const key = BY_LENGTH[j];
      if (key.length >= 2 && candidate.includes(key)) {
        return Object.assign({ source: 'builtin', matched: key, query: String(rawPlace).trim() }, BUILTIN.get(key));
      }
    }
  }
  return null;
}

/* 上游地名检索只作补充：必须是中国的「人口聚居地」或「行政单位」，且名字要对得上。 */
async function lookupUpstream(rawPlace) {
  const place = String(rawPlace == null ? '' : rawPlace).trim().slice(0, PLACE_MAX);
  if (!place) return null;
  const url = GEOCODE_URL + '?name=' + encodeURIComponent(place) + '&count=5&language=zh&format=json';
  const payload = await fetchJson(url, 6000);
  const list = (payload && payload.results) || [];
  const want = normalizePlace(place);
  for (let i = 0; i < list.length; i += 1) {
    const item = list[i];
    if (!item || item.country_code !== 'CN') continue;
    const name = normalizePlace(item.name);
    if (!name) continue;
    if (name !== want && !want.includes(name) && !name.includes(want)) continue;
    return { name: item.name, lat: item.latitude, lon: item.longitude, source: 'upstream', matched: item.name, query: place, admin: [item.admin1, item.admin2].filter(Boolean).join(' · ') };
  }
  return null;
}

export async function resolvePlace(rawPlace) {
  const builtin = lookupBuiltin(rawPlace);
  if (builtin) return builtin;
  try {
    const upstream = await lookupUpstream(rawPlace);
    if (upstream) return upstream;
  } catch (error) { /* 上游不可用时如实降级为「查不到地点」 */ }
  return null;
}

function fetchJson(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(function () { controller.abort(); }, timeoutMs || TIMEOUT_MS);
  return fetch(url, { signal: controller.signal, headers: { accept: 'application/json' } })
    .then(function (response) {
      if (!response.ok) throw new Error('upstream_' + response.status);
      return response.json();
    })
    .finally(function () { clearTimeout(timer); });
}

/* WMO 天气代码 → 中文描述。这是国际标准码表，不是我们编的。 */
const WMO = {
  0: '晴', 1: '大致晴朗', 2: '局部多云', 3: '阴',
  45: '有雾', 48: '雾凇',
  51: '小毛毛雨', 53: '毛毛雨', 55: '大毛毛雨', 56: '冻毛毛雨', 57: '强冻毛毛雨',
  61: '小雨', 63: '中雨', 65: '大雨', 66: '冻雨', 67: '强冻雨',
  71: '小雪', 73: '中雪', 75: '大雪', 77: '雪粒',
  80: '小阵雨', 81: '阵雨', 82: '强阵雨', 85: '小阵雪', 86: '大阵雪',
  95: '雷阵雨', 96: '雷阵雨伴冰雹', 99: '强雷阵雨伴冰雹'
};

const RAIN_CODES = new Set([51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82, 95, 96, 99]);
const SNOW_CODES = new Set([71, 73, 75, 77, 85, 86]);
const HEAVY_CODES = new Set([65, 67, 75, 82, 86, 99]);
const FOG_CODES = new Set([45, 48]);

export function describeCode(code) {
  const key = Number(code);
  return WMO[key] || '未知天气';
}

export function weatherIcon(code, isDay) {
  const key = Number(code);
  if (FOG_CODES.has(key)) return 'fog';
  if (SNOW_CODES.has(key)) return 'snow';
  if (key === 95 || key === 96 || key === 99) return 'storm';
  if (RAIN_CODES.has(key)) return 'rain';
  if (key === 3) return 'cloud';
  if (key === 2) return 'partly';
  if (key === 1) return isDay === false ? 'night' : 'partly';
  if (key === 0) return isDay === false ? 'night' : 'sun';
  return 'cloud';
}

function round(value, digits) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const base = Math.pow(10, digits == null ? 1 : digits);
  return Math.round(n * base) / base;
}

function pickHourly(payload, currentTime) {
  const hourly = (payload && payload.hourly) || {};
  const times = hourly.time || [];
  const temps = hourly.temperature_2m || [];
  const precs = hourly.precipitation || [];
  const codes = hourly.weather_code || [];
  if (!times.length) return { hours: [], rainWithin3h: null, maxPrecipNext3h: null, maxPrecipCode: null };
  let start = times.indexOf(currentTime);
  if (start < 0) {
    const nowMs = Date.now();
    start = 0;
    for (let i = 0; i < times.length; i += 1) {
      if (new Date(times[i]).getTime() >= nowMs) { start = i; break; }
    }
  }
  const hours = [];
  for (let i = start; i < times.length && hours.length < HOURLY_HOURS; i += 1) {
    hours.push({
      time: times[i],
      temperature: round(temps[i], 1),
      precipitation: round(precs[i], 1),
      weatherCode: Number.isFinite(Number(codes[i])) ? Number(codes[i]) : null,
      condition: describeCode(codes[i])
    });
  }
  const window3 = hours.slice(0, 3);
  let maxPrecip = 0;
  let maxCode = null;
  let sawValue = false;
  window3.forEach(function (hour) {
    if (hour.precipitation != null) {
      sawValue = true;
      if (hour.precipitation > maxPrecip) maxPrecip = hour.precipitation;
    }
    if (hour.weatherCode != null && (RAIN_CODES.has(hour.weatherCode) || SNOW_CODES.has(hour.weatherCode))) {
      maxCode = hour.weatherCode;
    }
  });
  const rainWithin3h = sawValue ? (maxPrecip >= 0.1 || maxCode != null) : null;
  return {
    hours: hours,
    rainWithin3h: rainWithin3h,
    maxPrecipNext3h: sawValue ? round(maxPrecip, 1) : null,
    maxPrecipCode: maxCode
  };
}

export async function fetchWeather(lat, lon) {
  const url = FORECAST_URL +
    '?latitude=' + encodeURIComponent(lat) + '&longitude=' + encodeURIComponent(lon) +
    '&current=temperature_2m,relative_humidity_2m,apparent_temperature,is_day,precipitation,weather_code,cloud_cover,wind_speed_10m,wind_gusts_10m,pressure_msl' +
    '&hourly=temperature_2m,precipitation,weather_code' +
    '&timezone=Asia%2FShanghai&forecast_days=1';
  const payload = await fetchJson(url, TIMEOUT_MS);
  const current = (payload && payload.current) || {};
  if (current.temperature_2m == null || current.weather_code == null) throw new Error('upstream_shape');
  const code = Number(current.weather_code);
  const isDay = current.is_day == null ? null : Number(current.is_day) === 1;
  const hourly = pickHourly(payload, current.time);
  return {
    observedAt: current.time || null,
    temperature: round(current.temperature_2m, 1),
    apparent: round(current.apparent_temperature, 1),
    humidity: round(current.relative_humidity_2m, 0),
    precipitation: round(current.precipitation, 1),
    windSpeed: round(current.wind_speed_10m, 1),
    windGust: round(current.wind_gusts_10m, 1),
    cloudCover: round(current.cloud_cover, 0),
    pressure: round(current.pressure_msl, 0),
    weatherCode: code,
    condition: describeCode(code),
    icon: weatherIcon(code, isDay),
    isDay: isDay,
    isRaining: RAIN_CODES.has(code) || (Number(current.precipitation) || 0) > 0,
    isSnowing: SNOW_CODES.has(code),
    isHeavy: HEAVY_CODES.has(code),
    isFoggy: FOG_CODES.has(code),
    elevation: round(payload.elevation, 0),
    timezone: payload.timezone || 'Asia/Shanghai',
    nextHours: hourly.hours,
    rainWithin3h: hourly.rainWithin3h,
    maxPrecipNext3h: hourly.maxPrecipNext3h,
    upstreamTime: payload.current && payload.current.time ? payload.current.time : null
  };
}

/* 把客观数值翻译成一句人话。只描述数据本身，不替用户下结论。 */
export function weatherSignals(current) {
  if (!current) return [];
  const out = [];
  if (current.isRaining) out.push({ code: 'rain', tone: 'warn', label: '正在降水', detail: '观测到降水量 ' + (current.precipitation == null ? '未知' : current.precipitation + ' 毫米') });
  if (current.isSnowing) out.push({ code: 'snow', tone: 'warn', label: '正在下雪', detail: '天气代码为降雪' });
  if (current.isHeavy) out.push({ code: 'heavy', tone: 'warn', label: '强度较大', detail: '天气代码属于大雨 / 大雪 / 强雷暴等级' });
  if (current.isFoggy) out.push({ code: 'fog', tone: 'warn', label: '有雾', detail: '能见度可能受影响' });
  if (current.rainWithin3h === true) out.push({ code: 'rain3h', tone: 'warn', label: '未来 3 小时内有降水', detail: '来自逐小时预报，最大小时降水量 ' + (current.maxPrecipNext3h == null ? '未知' : current.maxPrecipNext3h + ' 毫米') });
  if (current.rainWithin3h === false) out.push({ code: 'dry3h', tone: 'ok', label: '未来 3 小时无降水预报', detail: '来自逐小时预报' });
  if (current.apparent != null && current.apparent >= 32) out.push({ code: 'hot', tone: 'warn', label: '体感偏热', detail: '体感温度 ' + current.apparent + ' 摄氏度' });
  if (current.apparent != null && current.apparent <= 5) out.push({ code: 'cold', tone: 'warn', label: '体感偏冷', detail: '体感温度 ' + current.apparent + ' 摄氏度' });
  if (current.windSpeed != null && current.windSpeed >= 30) out.push({ code: 'wind', tone: 'warn', label: '风力较大', detail: '风速 ' + current.windSpeed + ' 公里每小时' });
  if (current.isDay === false) out.push({ code: 'night', tone: 'info', label: '当前为夜间', detail: '当地日照状态为夜间' });
  return out;
}

function cacheKey(place) {
  return String(place == null ? '' : place).toLowerCase().trim().slice(0, PLACE_MAX);
}

/* 对外唯一入口：拿不到就说拿不到，返回结构里永远带 available 字段。 */
export async function getWeather(rawPlace) {
  const query = String(rawPlace == null ? '' : rawPlace).trim().slice(0, PLACE_MAX);
  if (!query) return { available: false, reason: 'place_required', message: '没有提供地点。', place: null };

  const key = cacheKey(query);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < hit.ttl) {
    return Object.assign({}, hit.payload, { cached: true });
  }

  let resolved = null;
  try {
    resolved = await resolvePlace(query);
  } catch (error) {
    resolved = null;
  }
  if (!resolved) {
    const payload = { available: false, reason: 'place_not_found', message: '没有查到「' + query + '」的坐标，因此不显示气象数据。', place: { query: query }, cached: false };
    cache.set(key, { at: Date.now(), ttl: FAIL_TTL, payload: payload });
    return payload;
  }

  try {
    const current = await fetchWeather(resolved.lat, resolved.lon);
    const payload = {
      available: true,
      place: { query: query, name: resolved.name, matched: resolved.matched || resolved.name, lat: round(resolved.lat, 4), lon: round(resolved.lon, 4), source: resolved.source, admin: resolved.admin || null },
      current: current,
      signals: weatherSignals(current),
      source: { name: 'Open-Meteo', url: 'https://open-meteo.com/', note: '逐小时预报模型，非官方气象台发布' },
      fetchedAt: new Date().toISOString(),
      cached: false
    };
    cache.set(key, { at: Date.now(), ttl: CACHE_TTL, payload: payload });
    return payload;
  } catch (error) {
    const payload = {
      available: false,
      reason: 'upstream_unavailable',
      message: '气象数据源此刻没有响应，我们不显示任何猜测值。',
      place: { query: query, name: resolved.name, lat: round(resolved.lat, 4), lon: round(resolved.lon, 4), source: resolved.source },
      source: { name: 'Open-Meteo', url: 'https://open-meteo.com/' },
      fetchedAt: new Date().toISOString(),
      cached: false
    };
    cache.set(key, { at: Date.now(), ttl: FAIL_TTL, payload: payload });
    return payload;
  }
}

export function clearWeatherCache() {
  cache.clear();
}

export function weatherStatus() {
  return { provider: 'Open-Meteo', requiresKey: false, builtinPlaces: BUILTIN.size, aliases: ALIAS.size, cacheEntries: cache.size, cacheTtlSeconds: CACHE_TTL / 1000 };
}
