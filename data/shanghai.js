/* ============================================================================
 * data/shanghai.js — 上海地铁真实运营数据
 *
 * 来源与可信度：
 *   · 线路色：上海地铁官方 vi 色值，经 chinalife.top 与中文资料交叉核对
 *   · 车站顺序：逐字对照《上海轨道交通网络示意图》D202512 版（用户提供原图，
 *     2737×3830，按 12 块切图 + 6 块定向放大逐条线读图核对，不是凭记忆写的）
 *   · 编组 / 动拖 / 设计时速：《上海轨道交通智能运营调度管理系统》公开数据
 *   · 车辆尺寸：各车型技术参数（01A07 / 14A01 / 15A01 / 17A01 实测值）
 *   · 加制动性能：01A07 型式试验值（0~36 km/h ≥1.0 m/s²，0~80 平均 ≥0.835，
 *     常用制动 1.0 m/s²，紧急制动 1.2 m/s²，制动缓解延迟约 3.8 s）
 *   · 供电：全线 DC1500V 接触网，上海地铁无第三轨
 *   · 换乘关系：由车站名在各线中的重复自动推导，不手工维护
 * ==========================================================================*/
(function (global) {
'use strict';
const SH = global.SH;

/* 车型档案：尺寸取自各批次公开技术参数，缺者按同类推算并标注 */
const STOCK = {
  A8:  { type: '8A', cars: 8, formation: '6M2T', noseShape: 'A', width: 3.00, floorY: 1.13, roofY: 3.80,
         headLen: 24.356, motorLen: 22.600, trailerLen: 23.540, gap: 0.35,
         doors: 5, doorPitch: 4.40, doorW: 1.40, doorH: 1.92,
         massT: 400, wheelR: 0.42, bogieCenters: 15.7, supply: 'oh', screen: 'full' },
  /* 1 号线专用档：车体尺寸与 A8 同源（宽 3.00 / 地板 1.13 / 顶 3.80），
     但侧板走**用户给的 BVE 模型实拍贴图**（`assets/l1train/`，见 train.js 的
     `photo` 分支）。门距与门宽不是拍的 —— 是从 side1.bmp 上量出来的：
     5 扇门、u 节距 0.2071（→ 22.0 m 车长上 4.556 m）、门宽 0.0582 u（→ 1.30 m）。 */
  A8L1: { type: '8A', cars: 8, formation: '6M2T', noseShape: 'A', width: 3.00, floorY: 1.13, roofY: 3.80,
         headLen: 24.356, motorLen: 22.600, trailerLen: 23.540, gap: 0.35,
         doors: 5, doorPitch: 4.556, doorW: 1.30, doorH: 1.92,
         massT: 400, wheelR: 0.42, bogieCenters: 15.7, supply: 'oh', screen: 'full', photo: 'l1' },
  A6:  { type: '6A', cars: 6, formation: '4M2T', noseShape: 'A', width: 3.00, floorY: 1.13, roofY: 3.80,
         headLen: 24.356, motorLen: 22.600, trailerLen: 23.540, gap: 0.35,
         doors: 5, doorPitch: 4.40, doorW: 1.40, doorH: 1.92,
         massT: 300, wheelR: 0.42, bogieCenters: 15.7, supply: 'oh', screen: 'full' },
  /* 15A01：UTO 无人值守全自动运行，5 对车门，无司机室隔间 */
  A6D: { type: '6A', cars: 6, formation: '4M2T', noseShape: 'A', width: 3.00, floorY: 1.13, roofY: 3.80,
         headLen: 24.4, motorLen: 22.6, trailerLen: 23.5, gap: 0.35,
         doors: 5, doorPitch: 4.20, doorW: 1.44, doorH: 1.92,
         massT: 300, wheelR: 0.42, bogieCenters: 15.7, supply: 'oh', screen: 'full', uto: true },
  /* 17A01：B 型车宽但 4 对车门，110 km/h */
  A6S: { type: '6A', cars: 6, formation: '4M2T', noseShape: 'A', width: 3.00, floorY: 1.13, roofY: 3.80,
         headLen: 24.4, motorLen: 22.6, trailerLen: 23.5, gap: 0.35,
         doors: 4, doorPitch: 5.30, doorW: 1.40, doorH: 1.92,
         massT: 290, wheelR: 0.42, bogieCenters: 15.7, supply: 'oh', screen: 'full' },
  /* C 型车：6/7/8 号线与 5 号线，2.6 m 宽、3 对车门 */
  C6:  { type: '6C', cars: 6, formation: '4M2T', noseShape: 'C', width: 2.60, floorY: 1.10, roofY: 3.55,
         headLen: 21.6, motorLen: 19.5, trailerLen: 19.5, gap: 0.32,
         doors: 3, doorPitch: 5.60, doorW: 1.32, doorH: 1.86,
         massT: 220, wheelR: 0.42, bogieCenters: 13.5, supply: 'oh', screen: 'half' },
  C4:  { type: '4C', cars: 4, formation: '2M2T', noseShape: 'C', width: 2.60, floorY: 1.10, roofY: 3.55,
         headLen: 21.6, motorLen: 19.5, trailerLen: 19.5, gap: 0.32,
         doors: 3, doorPitch: 5.60, doorW: 1.32, doorH: 1.86,
         massT: 150, wheelR: 0.42, bogieCenters: 13.5, supply: 'oh', screen: 'half' },
  /* 16A01：3A 小编组，120 km/h */
  A3:  { type: '3A', cars: 3, formation: '2M1T', noseShape: 'A', width: 3.00, floorY: 1.13, roofY: 3.80,
         headLen: 24.4, motorLen: 22.6, trailerLen: 23.5, gap: 0.35,
         doors: 4, doorPitch: 5.00, doorW: 1.40, doorH: 1.92,
         massT: 150, wheelR: 0.42, bogieCenters: 15.7, supply: 'third', screen: 'half' },
  /* 浦江线胶轮 APM */
  RUB: { type: 'APM', cars: 4, formation: '4M', noseShape: 'RUB', width: 2.50, floorY: 1.00, roofY: 3.20,
         headLen: 12.0, motorLen: 11.0, trailerLen: 11.0, gap: 0.20,
         doors: 2, doorPitch: 5.00, doorW: 1.60, doorH: 1.90,
         massT: 60, wheelR: 0.35, bogieCenters: 7.0, supply: 'third', screen: 'half', rubber: true },
  /* 磁浮：完全另类的导向轨 + 长定子直线电机 */
  MAG: { type: '磁浮', cars: 6, formation: '6M', noseShape: 'MAG', width: 3.70, floorY: 0.50, roofY: 3.40,
         headLen: 20.0, motorLen: 19.0, trailerLen: 19.0, gap: 0.10,
         doors: 2, doorPitch: 6.00, doorW: 1.10, doorH: 1.85,
         massT: 100, wheelR: 0.0, bogieCenters: 12.0, supply: 'stator', screen: 'none', maglev: true },
};

/* 牵引/制动性能（01A07 型式试验为基准，按编组与车型微调） */
const PERF = {
  A8:  { accLo: 1.00, accAvg: 0.835, serv: 1.00, emerg: 1.20, release: 3.8, regenFloorKmh: 8 },
  A6:  { accLo: 1.00, accAvg: 0.835, serv: 1.00, emerg: 1.20, release: 3.4, regenFloorKmh: 8 },
  A6D: { accLo: 0.98, accAvg: 0.82, serv: 1.00, emerg: 1.20, release: 3.4, regenFloorKmh: 8 },
  A6S: { accLo: 0.95, accAvg: 0.80, serv: 0.98, emerg: 1.18, release: 3.4, regenFloorKmh: 9 },
  C6:  { accLo: 0.92, accAvg: 0.75, serv: 0.95, emerg: 1.15, release: 3.0, regenFloorKmh: 8 },
  C4:  { accLo: 0.95, accAvg: 0.78, serv: 0.95, emerg: 1.15, release: 2.8, regenFloorKmh: 8 },
  A3:  { accLo: 0.90, accAvg: 0.72, serv: 0.95, emerg: 1.15, release: 3.2, regenFloorKmh: 10 },
  RUB: { accLo: 0.70, accAvg: 0.55, serv: 0.85, emerg: 1.05, release: 1.6, regenFloorKmh: 6 },
  /* 磁浮：起动 1.15 m/s²、常用 1.10、缓解 0.4 s（没有空气制动那 3 秒延迟）。
     accLo 从 1.80 降到 1.15 的约束是 _note 那句「450 s 跑完 29.088 km」：
     恒牵引区里 0→300 用时 83.3/accLo，代入加/减/巡航三段，1.15 解出 423 s，
     1.80 只有 370 s —— 快出的那 90 s 会让"全程约 8 分钟"这条口径失效。 */
  MAG: { accLo: 1.15, accAvg: 1.05, serv: 1.10, emerg: 1.60, release: 0.4, regenFloorKmh: 0 },
};

/* ------------------------------------------------------------------ 线路表
 * elevated: 高架/地面区间 [起始站序号, 结束站序号]（含端点），其余为地下
 * stock:    STOCK 键；perf: PERF 键
 * base/spread: 站间距合成参数（真实站间距未公开，用与线路特征相符的量级）
 * features: 场景地标，索引 = 站序号
 * -------------------------------------------------------------------------*/
/* 站序与站名：逐字对照《上海轨道交通网络示意图》D202512 版（2026-10 口径）。
 * 三条硬规则，改数据时必须一起改：
 *   1. elevated 用**站名区间**（含端点），不再写序号——序号会在站表增删时静默错位，
 *      加载时统一解析成序号，写错站名直接抛错。
 *   2. Y 型交路只取贯通主线（5/10/11 的支线写进 _note），游戏里一条线跑到底。
 *   3. 换乘由站名重复自动推导，所以同名即换乘；出站换乘（如 2/14 的浦东南路）
 *      在图上是两个圈，这里合并成一个换乘点，是有意简化。 */
const LINES = {
  l1: { id: 'l1', name: '1号线', full: '上海轨道交通1号线', color: '#E4002B', stock: 'A8L1', perf: 'A8',
    maxKmh: 80, base: 1180, spread: 520, opened: '1993-05-28', hub: '莘庄↔富锦路',
    elevated: [['莘庄', '外环路']],
    stations: ['莘庄','外环路','莲花路','锦江乐园','上海南站','漕宝路','上海体育馆','徐家汇','衡山路','常熟路','陕西南路','一大会址·黄陂南路','人民广场','新闸路','汉中路','上海火车站','中山北路','延长路','上海马戏城','汶水路','彭浦新村','共康路','通河新村','呼兰路','共富新村','宝安公路','友谊西路','富锦路'] },

  l2: { id: 'l2', name: '2号线', full: '上海轨道交通2号线', color: '#8CC63E', stock: 'A8', perf: 'A8',
    maxKmh: 80, base: 1350, spread: 700, opened: '2000-06-11', hub: '虹桥↔浦东机场',
    elevated: [['徐泾东', '虹桥火车站'], ['海天三路', '浦东1号2号航站楼']],
    stations: ['蟠祥路·国家会计学院','徐泾东','虹桥火车站','虹桥2号航站楼','淞虹路','北新泾','威宁路','娄山关路','中山公园','江苏路','静安寺','南京西路','人民广场','南京东路','陆家嘴','浦东南路','世纪大道','上海科技馆','世纪公园','龙阳路','张江高科','金科路','广兰路','唐镇','创新中路','华夏东路','川沙','凌空路','远东大道','海天三路','浦东1号2号航站楼'],
    _note: '西端已延到 蟠祥路·国家会计学院；东昌路已改名 浦东南路（与 14 号线同名不同站，出站换乘）' },

  l3: { id: 'l3', name: '3号线', full: '上海轨道交通3号线（明珠线）', color: '#FFD100', color2: '#5B2D8D', stock: 'A6', perf: 'A6',
    maxKmh: 80, base: 1250, spread: 600, opened: '2000-12-26', hub: '上海南站',
    elevated: [['上海南站', '虹桥路'], ['宝山路', '江杨北路']],   // 除 虹桥路~宝山路 地下段外全程高架：中国第一条城市轨道交通高架线
    /* 跨水点：地理事实，写在这里而不是相机表里 —— 线形生成时就要知道哪里有江
       （大桥必须落在直线 + 水平段上），而 VIEWSPOTS 只管"到了那里怎么拍"。
       第三项是水道量级：crossing = 江河（水面半宽 223~447 m），creek = 运河。 */
    crossings: [['长江南路', '淞发路', 'creek']],
    screen: 'half',
    stations: ['上海南站','石龙路','龙漕路','漕溪路','宜山路','虹桥路','延安西路','中山公园','金沙江路','镇坪路','曹杨路','上海火车站','宝山路','东宝兴路','虹口足球场','赤峰路','大柏树','江湾镇','殷高西路','长江南路','淞发路','张华浜','淞滨路','水产路','宝杨路','友谊路','铁力路','江杨北路'] },

  l4: { id: 'l4', name: '4号线', full: '上海轨道交通4号线（环线）', color: '#5B2D8D', stock: 'A6', perf: 'A6',
    maxKmh: 80, base: 1150, spread: 480, opened: '2005-12-31', loop: true, hub: '枢纽环线',
    elevated: [['上海火车站', '宝山路'], ['虹桥路', '中潭路']],
    screen: 'half',
    stations: ['上海火车站','宝山路','海伦路','临平路','大连路','杨树浦路','浦东大道','世纪大道','浦电路','蓝村路','塘桥','南浦大桥','西藏南路','鲁班路','大木桥路','东安路','上海体育场','宜山路','虹桥路','延安西路','中山公园','金沙江路','曹杨路','镇坪路','中潭路','上海火车站'],
    _note: '环线，终点与起点同为上海火车站；宝山路~虹桥路与 3 号线共线' },

  l5: { id: 'l5', name: '5号线', full: '上海轨道交通5号线', color: '#ED348C', stock: 'C4', perf: 'C4',
    maxKmh: 80, base: 1400, spread: 900, opened: '2003-11-25', hub: '闵行/奉贤',
    elevated: [['春申路', '望园路']], screen: 'half',
    crossings: [['西渡', '萧塘', 'crossing']],
    stations: ['莘庄','春申路','银都路','颛桥','北桥','剑川路','东川路','江川路','西渡','萧塘','奉浦大道','环城东路','望园路','金海湖','奉贤新城'],
    /* 支线站序按《上海轨道交通网络示意图》D202512 版逐字抄录（见 _note）。
       站间距不新造数字：`_gaps()` 按"站名对"哈希生成，与主线同一套规则。
       elevated 给的是事实：5 号线是郊区线，东川路以西整段在高架上。 */
    branch: { at: '东川路', stations: ['金平路','华宁路','文井路','闵行开发区'], elevated: [['东川路','闵行开发区']] },
    _note: '东川路 分岔支线：金平路—华宁路—文井路—闵行开发区（本游戏跑主线到奉贤新城）' },

  l6: { id: 'l6', name: '6号线', full: '上海轨道交通6号线', color: '#F17CBA', stock: 'C6', perf: 'C6',
    maxKmh: 80, base: 950, spread: 380, opened: '2007-12-29', hub: '浦东',
    elevated: [['港城路', '外高桥保税区北'], ['巨峰路', '五莲路']], screen: 'half',
    crossings: [['巨峰路', '五莲路', 'creek']],
    stations: ['港城路','外高桥保税区北','航津路','外高桥保税区南','洲海路','五洲大道','东靖路','巨峰路','五莲路','博兴路','金桥路','云山路','德平路','北洋泾路','民生路','源深体育中心','世纪大道','浦电路','上海儿童医学中心','高科西路','东明路','高青路','华夏西路','上南路','灵岩南路','东方体育中心'],
    _note: '巨峰路~五莲路 以桥梁形式两次跨越浦东运河，桥-墩-桥连续结构' },

  l7: { id: 'l7', name: '7号线', full: '上海轨道交通7号线', color: '#FF772B', stock: 'A6', perf: 'A6',
    maxKmh: 80, base: 1150, spread: 520, opened: '2009-12-05', hub: '静安/后滩',
    elevated: [], screen: 'full',
    stations: ['美兰湖','罗南新村','潘广路','刘行','顾村公园','祁华路','上海大学','南陈路','上大路','场中路','大场镇','行知路','大华三路','新村路','岚皋路','镇坪路','长寿路','昌平路','静安寺','常熟路','肇嘉浜路','东安路','龙华中路','后滩','长清路','耀华路','云台路','杨高南路','锦绣路','芳华路','龙阳路','花木路'] },

  l8: { id: 'l8', name: '8号线', full: '上海轨道交通8号线', color: '#009CD3', stock: 'C6', perf: 'C6',
    maxKmh: 80, base: 1100, spread: 480, opened: '2007-12-29', hub: '杨浦/世博',
    elevated: [['市光路', '嫩江路'], ['杨思', '东方体育中心']], screen: 'half',
    stations: ['市光路','嫩江路','翔殷路','黄兴公园','延吉中路','黄兴路','江浦路','鞍山新村','四平路','曲阳路','虹口足球场','西藏北路','中兴路','人民广场','大世界','老西门','陆家浜路','西藏南路','中华艺术宫','成山路','杨思','东方体育中心','凌兆新村','芦恒路','浦江镇','江月路','联航路','沈杜公路'],
    _note: '南端 沈杜公路 换 浦江线（胶轮 APM）' },

  l9: { id: 'l9', name: '9号线', full: '上海轨道交通9号线', color: '#7D99BE', stock: 'A6', perf: 'A6',
    maxKmh: 80, base: 1300, spread: 700, opened: '2007-12-29', hub: '松江↔曹路',
    elevated: [['上海松江站', '松江体育中心'], ['佘山', '泗泾']], screen: 'half',
    stations: ['上海松江站','醉白池','松江体育中心','松江新城','松江大学城','佘山','洞泾','泗泾','九亭','中春路','七宝','星中路','合川路','漕河泾开发区','桂林路','宜山路','徐家汇','肇嘉浜路','嘉善路','打浦桥','马当路','陆家浜路','小南门','商城路','世纪大道','杨高南路','芳甸路','台儿庄路','蓝天路','碧云路','金桥','金桥公园','曹路'] },

  l10: { id: 'l10', name: '10号线', full: '上海轨道交通10号线', color: '#C1A2DB', stock: 'A6', perf: 'A6',
    maxKmh: 80, base: 1050, spread: 460, opened: '2010-04-10', hub: '虹桥/新江湾',
    elevated: [['基隆路', '新江湾城']], screen: 'full', uto: true,
    crossings: [['双江路', '高桥西', 'creek']],
    stations: ['基隆路','港城路','高桥','高桥西','双江路','国帆路','新江湾城','殷高东路','三门路','江湾体育场','五角场','国权路','同济大学','邮电新村','海伦路','四川北路','天潼路','南京东路','豫园','老西门','一大会址·新天地','陕西南路','上海图书馆','交通大学','宋园路','伊犁路','水城路','龙溪路','上海动物园','虹桥1号航站楼','虹桥火车站'],
    /* 10 号线是市区地下线，龙溪路以西的支线同样在地下，所以不给 elevated。 */
    branch: { at: '龙溪路', stations: ['龙柏新村','紫藤路','航中路'] },
    _note: '龙溪路 分岔支线：龙柏新村—紫藤路—航中路（本游戏跑主线到虹桥火车站）' },

  l11: { id: 'l11', name: '11号线', full: '上海轨道交通11号线', color: '#8A2BE2', stock: 'A6', perf: 'A6',
    maxKmh: 100, base: 1400, spread: 800, opened: '2009-12-31', hub: '迪士尼/花桥',
    elevated: [['嘉定北', '南翔'], ['三林', '迪士尼']], screen: 'full',
    stations: ['嘉定北','嘉定西','白银路','嘉定新城','上海赛车场','马陆','南翔','桃浦新村','武威路','祁连山路','李子园','上海西站','真如','枫桥路','曹杨路','隆德路','交通大学','徐家汇','上海游泳馆','龙华','云锦路','龙耀路','东方体育中心','三林','三林东','浦三路','御桥','罗山路','秀沿路','康新公路','迪士尼'],
    /* 安亭以西（花桥段）是高架/地面段，这是全国首条跨省级行政区的轨道交通线。 */
    branch: { at: '嘉定新城', stations: ['昌吉东路','上海汽车城','安亭','光明路','兆丰路','花桥'], elevated: [['嘉定新城','花桥']] },
    _note: '全国首条跨省级行政区轨道交通线（江苏昆山花桥段）；嘉定新城 分岔 昌吉东路—上海汽车城—安亭—光明路—兆丰路—花桥' },

  l12: { id: 'l12', name: '12号线', full: '上海轨道交通12号线', color: '#00A5A8', stock: 'A6', perf: 'A6',
    maxKmh: 80, base: 1050, spread: 430, opened: '2013-12-29', hub: '七莘路↔金海路',
    elevated: [], screen: 'full',
    stations: ['七莘路','虹莘路','顾戴路','东兰路','虹梅路','虹漕路','桂林公园','漕宝路','龙漕路','龙华中路','大木桥路','嘉善路','陕西南路','南京西路','汉中路','曲阜路','天潼路','国际客运中心','提篮桥','江浦公园','宁国路','隆昌路','复兴岛','爱国路','东陆路','巨峰路','杨高北路','金京路','申江路','金海路'] },

  l13: { id: 'l13', name: '13号线', full: '上海轨道交通13号线', color: '#F694B8', stock: 'A6', perf: 'A6',
    maxKmh: 80, base: 1100, spread: 460, opened: '2013-12-31', hub: '金运路↔张江路',
    elevated: [['金运路', '金沙江西路'], ['张江路', '张江路']], screen: 'full',
    stations: ['金运路','金沙江西路','丰庄','祁连山南路','真北路','大渡河路','金沙江路','隆德路','武宁路','长寿路','江宁路','汉中路','自然博物馆','南京西路','淮海中路','一大会址·新天地','马当路','世博会博物馆','世博大道','长清路','成山路','东明路','华鹏路','下南路','北蔡','陈春路','莲溪路','华夏中路','中科路','学林路','张江路'] },

  l14: { id: 'l14', name: '14号线', full: '上海轨道交通14号线', color: '#717F89', stock: 'A8', perf: 'A8',
    maxKmh: 80, base: 1150, spread: 480, opened: '2021-12-30', hub: '封浜↔桂桥路',
    elevated: [], screen: 'full', uto: true,
    stations: ['封浜','乐秀路','临洮路','嘉怡路','定边路','真新新村','真光路','铜川路','中宁路','曹家渡','武定路','静安寺','一大会址·黄陂南路','大世界','豫园','陆家嘴','浦东南路','源深路','昌邑路','歇浦路','云山路','蓝天路','黄杨路','云顺路','浦东足球场','金粤路','桂桥路'],
    _note: '8A 编组 UTO 全自动运行；陆家嘴绕行段 2024-12-22 开通' },

  l15: { id: 'l15', name: '15号线', full: '上海轨道交通15号线', color: '#A6CE39', stock: 'A6D', perf: 'A6D',
    maxKmh: 80, base: 1150, spread: 500, opened: '2021-01-23', hub: '顾村公园↔紫竹高新区',
    elevated: [], screen: 'full', uto: true,
    stations: ['顾村公园','锦秋路','丰翔路','南大路','祁安路','古浪路','武威东路','上海西站','梅岭北路','铜川路','大渡河路','长风公园','红宝石路','姚虹路','吴中路','桂林路','桂林公园','上海南站','华东理工大学','罗秀路','朱梅路','景洪路','虹梅南路','景西路','曙建路','双柏路','元江路','永德路','紫竹高新区'],
    _note: '上海首条 UTO（无人值守全自动运行）线路，车头设观景窗——本游戏里可以体验"没有司机室的驾驶室"。15 号线走西区切线，全程不进市中心' },

  l16: { id: 'l16', name: '16号线', full: '上海轨道交通16号线', color: '#00B0CD', stock: 'A3', perf: 'A3',
    maxKmh: 100, base: 2100, spread: 1600, opened: '2013-12-29', hub: '龙阳路↔滴水湖',
    elevated: [['华夏中路', '滴水湖']], screen: 'half',
    stations: ['龙阳路','华夏中路','罗山路','周浦东','鹤沙航城','康桥','野生动物园','惠南','惠南东','书院','临港大道','滴水湖'],
    _note: '原南汇线，站间距最大、几乎全程高架，是展示城市郊野天际线的最佳线路' },

  l17: { id: 'l17', name: '17号线', full: '上海轨道交通17号线', color: '#E498C3', stock: 'A6S', perf: 'A6S',
    maxKmh: 100, base: 1600, spread: 1100, opened: '2017-12-30', hub: '虹桥枢纽↔西岑',
    // 除 虹桥火车站~徐盈路（地下，配合国家会展中心）外全程高架
    elevated: [['徐盈路', '东方绿舟']], screen: 'full',
    crossings: [['赵巷', '汇金路', 'creek']],
    stations: ['虹桥火车站','诸光路','国家会展中心','蟠龙路','徐盈路','徐泾北城','嘉松中路','赵巷','汇金路','青浦新城','漕盈路','淀山湖大道','朱家角','东方绿舟','西岑'],
    _note: '全国首条开通即实现最高等级全自动驾驶的线路（现实里同为 UTO）；2024 年西延到 西岑。本游戏按用户口径未给它 UTO 模式' },

  l18: { id: 'l18', name: '18号线', full: '上海轨道交通18号线', color: '#D9A036', stock: 'A6', perf: 'A6',
    maxKmh: 80, base: 1100, spread: 460, opened: '2020-12-26', hub: '康文路↔航头',
    elevated: [], screen: 'full', uto: true,
    stations: ['康文路','爱辉路','呼兰路','长江西路','通南路','长江南路','殷高路','上海财经大学','复旦大学','国权路','抚顺路','江浦路','平凉路','丹阳路','昌邑路','民生路','杨高中路','龙阳路','迎春路','芳芯路','北中路','莲溪路','御桥','康桥','周浦','繁荣路','沈梅路','鹤涛路','下沙','航头'],
    _note: '二期北段已通到 康文路，与 1 号线在 呼兰路 换乘' },

  ph: { id: 'ph', name: '浦江线', full: '上海轨道交通浦江线', color: '#D60333', stock: 'RUB', perf: 'RUB',
    maxKmh: 60, base: 780, spread: 300, opened: '2018-03-31', hub: 'APM',
    elevated: [['沈杜公路', '汇臻路']], screen: 'half', aPM: true, uto: true,
    stations: ['沈杜公路','三鲁公路','闵瑞路','浦航路','东城一路','汇臻路'] },

  ml: { id: 'ml', name: '磁浮', full: '上海磁浮示范运营线', color: '#009BD8', stock: 'MAG', perf: 'MAG',
    /* maxKmh 是**构造速度**、runKmh 是**运营速度**，两者不是一回事：本文件
       下面的 _note 自己写着「最高 431 km/h（运营 300）」。以前两个都填 300，
       于是物理侧"构造速度最后 10% 收功率"的渐近带正好压在巡航区，
       磁浮贴不住 300（实测最高 291），ATO 每秒换一次级位追速度。 */
    maxKmh: 431, runKmh: 300,
    /* 只有两个站 → 只有一个站间距 → 这个数就是线路长度。所以它**不能**走
       "base + 哈希"的通用启发式：以前 base 5200 / spread 2000 生成 6126 m，
       而本文件下面自己的 _note 写着「450 s 跑完 29.088 km」——一条被自己的
       文案打脸的线。车迷最在意的恰恰就是这段：全程 8 分钟、中间不停站、
       要长时间贴着 300 km/h 跑。spread 取 1 让哈希项恒为 0，里程精确落到 29088。
       （29.088 km 的出处就是 _note 那句话，不是凭印象另编一个数。） */
    base: 29088, spread: 1,
    opened: '2002-12-31', hub: '浦东机场',
    elevated: [['龙阳路', '浦东1号2号航站楼']], screen: 'none', maglev: true,
    stations: ['龙阳路','浦东1号2号航站楼'],
    _note: '世界首条商用高速磁浮，450 s 跑完 29.088 km，最高 431 km/h（运营 300）' },
};

/* elevated 的站名区间 → 序号。写错站名必须当场炸，不能让一段高架悄悄变成隧道。
 * 之前这里全是裸序号：站表一增删，高架区间就整体错位（1 号线曾经把 2/9 号线的
 * 站拼在尾部，于是"高架"落到了地下段上），而没有任何一条判据会发现。 */
/* ---- 运营里程标定（README 第 77 条）----------------------------------------
 * 口径：维基百科各线条目 infobox「路線長度」，其定义为**首末站中心线之间的距离**，
 * 与这里的"收入段" `stationS[last] − stationS[0]` 同义（不含两端站外的引入段与基地）。
 * `SH.lineGaps` 把合成出来的站间距图案整体按比例缩放到这个总长：市区密、郊区疏的
 * **相对**图案由站名哈希给，标定只改绝对尺度。逐站里程没有公开表，所以能标到的是
 * "总长"这一层，`test-core.js` 用 0.5% 门槛钉住几何 ↔ 本表 ↔ `_note` 文案三者。
 *
 * **不标定的线，以及为什么**：
 *   l5 / l10 / l11 —— 官方值把支线算在一起（5 号线 37.376 含 东川路—闵行开发区 支线、
 *     10 号线 46.311 含 航中路 支线、11 号线 82.386 含 花桥 支线），而本游戏的主线
 *     交路只有其中一段，按总长缩放会让主线虚长一倍量级。
 *   ml（磁浮）—— 已经用 `base: 29088, spread: 1` 精确落位，图案就是那一个跨距。
 * 检索日期 2026-10-02。4 号线取"含 3 号线共线段"口径（本站表 26 站就是共线口径）；
 * 自有段口径是 22.032 km / 17 站。 */
const KM = {
  l1: 38.18, l2: 62.2, l3: 40.34, l4: 33.598, l6: 33.09, l7: 44.366, l8: 37.5, l9: 64.4,
  l12: 40.417, l13: 38.83, l14: 38.514, l15: 42.3, l16: 58.962, l17: 41.636, l18: 44.815,
  ph: 6.646,
};

/* ---------------------------------------------------------------- 一站一特色
 * 逐站景色的**唯一数据源**（game.js 的 VIEWSPOTS 由它派生，test-facade 钉住）。
 * 每条 = 一座车站的真实场景特色 → 地标 kind / 观景侧 / 距离。字段：
 *   at    特色落点的站名或 [站A, 站B] 区间（地标摆在两站之间的区间上时成对给）
 *   kind  landmark.js BUILDERS 的键
 *   via   本站在地下、特色经由**另一条线**的视角呈现（值 = 那条线的 id；
 *         必须与那条线上同 kind 的落点对得上，test-facade 查对账）
 *   exit  本站在地下、出站即景（豫园这类"站在站外才看得到"的特色）——
 *         如实记录，不落几何：地下段冒出天际线是穿帮（test-facade 的老规矩）
 * 检索口径：各站实景以公开照片/地图为准（2026-10）；站名逐字对照本文件站表。
 * -------------------------------------------------------------------------*/
const STATION_FEATURES = [
  /* —— 用户点名的重点站 —— */
  { line: 'ml',  at: '龙阳路', kind: 'lujiazui', side: -1, dist: 620, name: '陆家嘴', note: '东方明珠+三件套天际线；本站地下，磁浮龙阳路~浦东机场段是全网最正的陆家嘴视角' },
  { line: 'l2',  at: '南京东路', kind: 'bund', via: 'l4', name: '外滩', note: '外滩万国建筑群沿江一字排开；本站与 10 号线同名站都在地下，陆上看外滩没有天上视角，经由 4 号线宝山路区间的高架眺望点呈现' },
  { line: 'l10', at: '豫园', exit: true, name: '豫园', note: '豫园园林+城隍庙飞檐屋顶群；本站与 14 号线同名站都在地下，出站即景' },
  { line: 'l3',  at: '虹口足球场', kind: 'stadium', side: 1, dist: 520, name: '虹口足球场', note: '专业足球场碗形看台，3 号线高架从场边掠过' },
  { line: 'l11', at: '上海赛车场', kind: 'circuit', side: 1, dist: 380, name: '上海赛车场', note: 'F1 "上"字形赛道 + 主看台，11 号线高架沿赛道外沿走' },
  { line: 'l11', at: '迪士尼', kind: 'disney', side: 1, dist: 160, name: '迪士尼', note: '城堡 + 奇想花园，11 号线终点站出站即乐园大门' },
  { line: 'l16', at: '滴水湖', kind: 'lake', side: 1, dist: 700, name: '滴水湖', note: '临港圆形人工湖，16 号线终点站湖景正对线路' },
  /* —— 支线端点与支线沿途 —— */
  { line: 'l11#branch', at: '花桥', kind: 'skyline', side: -1, dist: 1500, name: '花桥', note: '跨省线端点：昆山花桥天际线在线路尽端的另一侧' },
  { line: 'l11#branch', at: '安亭', kind: 'skyline', side: -1, dist: 1400, name: '安亭', note: '上海国际汽车城，高架段尽收厂区与试车场' },
  { line: 'l5#branch', at: '闵行开发区', kind: 'skyline', side: 1, dist: 1500, name: '闵行开发区', note: '支线端点：闵行老工业带沿江天际线' },
  { line: 'l5#branch', at: '文井路', kind: 'skyline', side: -1, dist: 1400, name: '文井路', note: '支线沿途：紫竹高新区与沿江厂区' },
  { line: 'l10', at: '航中路', exit: true, name: '航中路', note: '10 号线支线端点；支线全程地下，出站即虹桥住宅区' },
  { line: 'l8', at: '中华艺术宫', exit: true, name: '中华艺术宫', note: '世博会中国馆斗冠（现中华艺术宫）；8 号线该站在地下，出站即景' },
  /* —— 全网重点观景站（已有视角收编入表） —— */
  { line: 'ml',  at: ['龙阳路', '浦东1号2号航站楼'], kind: 'airport', side: 1, dist: 480, name: '浦东机场' },
  { line: 'ml',  at: '浦东1号2号航站楼', kind: 'skyline', side: 1, dist: 1500, name: '浦东1号2号航站楼' },
  { line: 'l2',  at: '徐泾东', kind: 'skyline', side: 1, dist: 1400, name: '徐泾东' },
  { line: 'l2',  at: '虹桥火车站', kind: 'airport', side: -1, dist: 490, name: '虹桥火车站' },
  { line: 'l2',  at: '海天三路', kind: 'airport', side: 1, dist: 480, name: '海天三路' },
  { line: 'l2',  at: '浦东1号2号航站楼', kind: 'skyline', side: -1, dist: 1500, name: '浦东1号2号航站楼' },
  { line: 'l1',  at: '莘庄', kind: 'skyline', side: 1, dist: 1500, name: '莘庄' },
  { line: 'l3',  at: ['长江南路', '淞发路'], kind: 'creek', side: 1, dist: 0, name: '蕰藻浜' },
  { line: 'l3',  at: '张华浜', kind: 'river', side: 1, dist: 560, name: '张华浜' },
  { line: 'l3',  at: '友谊路', kind: 'skyline', side: -1, dist: 1500, name: '友谊路' },
  { line: 'l4',  at: '宝山路', kind: 'bund', side: -1, dist: 300, name: '外滩眺望点' },
  { line: 'l4',  at: '曹杨路', kind: 'skyline', side: 1, dist: 1500, name: '曹杨路' },
  { line: 'l5',  at: ['西渡', '萧塘'], kind: 'crossing', side: 1, dist: 0, name: '西渡越江' },
  { line: 'l5',  at: '望园路', kind: 'skyline', side: -1, dist: 1400, name: '望园路' },
  { line: 'l6',  at: ['港城路', '外高桥保税区北'], kind: 'port', side: -1, dist: 240, name: '外高桥港区' },
  { line: 'l6',  at: ['巨峰路', '五莲路'], kind: 'creek', side: 1, dist: 0, name: '浦东运河' },
  { line: 'l6',  at: '外高桥保税区北', kind: 'skyline', side: 1, dist: 1500, name: '外高桥保税区北' },
  { line: 'l8',  at: '嫩江路', kind: 'skyline', side: 1, dist: 1600, name: '嫩江路' },
  { line: 'l8',  at: ['杨思', '东方体育中心'], kind: 'skyline', side: -1, dist: 1500, name: '东方体育中心' },
  { line: 'l9',  at: '上海松江站', kind: 'skyline', side: 1, dist: 1500, name: '上海松江站' },
  { line: 'l9',  at: '醉白池', kind: 'skyline', side: -1, dist: 1600, name: '醉白池' },
  { line: 'l9',  at: '佘山', kind: 'sheshan', side: -1, dist: 700, name: '佘山', note: '上海唯一的陆地山丘（百米高差）+ 山顶天文台圆顶；佘山~泗泾实际为高架段' },
  { line: 'l10', at: ['双江路', '高桥西'], kind: 'creek', side: 1, dist: 0, name: '蕰藻浜口' },
  { line: 'l10', at: '港城路', kind: 'port', side: -1, dist: 240, name: '港城路' },
  { line: 'l11', at: '南翔', kind: 'skyline', side: -1, dist: 1500, name: '南翔' },
  { line: 'l11', at: ['康新公路', '迪士尼'], kind: 'disney', side: -1, dist: 158, name: '迪士尼眺望点' },
  { line: 'l11', at: '嘉定北', kind: 'skyline', side: -1, dist: 1500, name: '嘉定北' },
  { line: 'l13', at: '张江路', kind: 'skyline', side: 1, dist: 1500, name: '张江路' },
  { line: 'l16', at: '周浦东', kind: 'skyline', side: -1, dist: 1600, name: '周浦东' },
  { line: 'l16', at: '野生动物园', kind: 'zoo', side: 1, dist: 520, name: '野生动物园' },
  { line: 'l16', at: '书院', kind: 'skyline', side: -1, dist: 1500, name: '书院' },
  { line: 'l17', at: ['赵巷', '汇金路'], kind: 'creek', side: 1, dist: 0, name: '漕港河' },
  { line: 'l17', at: ['淀山湖大道', '朱家角'], kind: 'lake', side: -1, dist: 900, name: '淀山湖' },
  { line: 'l17', at: '嘉松中路', kind: 'skyline', side: 1, dist: 1500, name: '嘉松中路' },
  { line: 'ph',  at: '浦航路', kind: 'skyline', side: -1, dist: 1400, name: '浦航路' },
];

for (const k of Object.keys(KM)) {
  /* 表里的 id 写错 = 那条线的标定静默失效，所以直接炸而不是跳过 */
  if (!LINES[k]) throw new Error('里程标定表里有条线不存在：' + k);
  LINES[k].km = KM[k];
}

(function resolveElevated() {
  for (const k of Object.keys(LINES)) {
    const L = LINES[k];
    /* 换算成序号的同时**保留站名**：序号是相对主线站表的，换到支线交路就整体错位，
       LineRuntime 要按自己的站表重新解析。 */
    L.elevatedNames = (L.elevated || []).map(r => r.slice());
    L.elevated = (L.elevated || []).map(r => {
      const q = r.map(x => {
        if (typeof x === 'number') return x;
        const i = L.stations.indexOf(x);
        if (i < 0) throw new Error(L.name + ' elevated：没有车站「' + x + '」');
        return i;
      });
      // 站表方向一改，[终点, 起点] 就写反了，反掉的区间永远匹配不上里程，
      // 于是那段高架悄悄变回隧道、挂在它上面的地标全部变成死配置。这里统一排序。
      return q[0] <= q[1] ? q : [q[1], q[0]];
    });
  }
})();

/* --------------------------------------------------- 自动推导：换乘与站色 */
(function buildInterchanges() {
  const map = Object.create(null);
  for (const k of Object.keys(LINES)) {
    const L = LINES[k];
    L.stations.forEach((n, i) => {
      const base = n.replace(/\d+$/, '');
      (map[base] = map[base] || []).push({ line: L.name, id: k, i });
    });
  }
  const inter = {};
  for (const n in map) if (map[n].length > 1) {
    const seen = [], lines = [];
    for (const e of map[n]) if (seen.indexOf(e.id) < 0) { seen.push(e.id); lines.push({ id: e.id, name: e.line, color: LINES[e.id].color }); }
    if (lines.length > 1) inter[n] = lines;
  }
  SH.INTER = inter;
})();

/* --------------------------------------------- 换乘类型与走行时间（INTER_META）
 *
 * 真实换乘**不是**"同名即换乘"一种，而这里以前只有一种。三类：
 *   · `in`     站内换乘（付费区内通道）—— 绝大多数
 *   · `out`    出站换乘：出闸 → 地面 → 再进闸。官方图上画的是**两个圈**，
 *              典型是 2/14 号线的 浦东南路（还有 9/12 的金海路，本数据集里
 *              9 号线站表没有这一站，所以只有前者成立）。
 *   · `shared` 共线同站台：3/4 号线 虹桥路~宝山路 这 8 站是**同一条站台**，
 *              它根本不是"换乘"——按换乘处理会给这 8 站凭空加上换乘客流。
 *
 * 走行时间按通道长度量级估：站内换乘 2 线 ≈ 70 s，每多一条线 +45 s（封顶 210）；
 * 出站换乘要出闸、上地面、再进闸，再 +180 s；共线同站台 = 0。
 * 口径写在这里、由 `test-transfer.js` 钉住，不许以后有人拿它冒充官方走行时间。
 */
(function buildInterMeta() {
  const inter = SH.INTER || {};
  /* 3/4 共线段：在两线站表里都出现、且落在 宝山路~虹桥路 之间的那些站 */
  const shared = new Set();
  const l3 = LINES.l3.stations, l4 = LINES.l4.stations;
  const a = l3.indexOf('宝山路'), b = l3.indexOf('虹桥路');
  if (a >= 0 && b >= 0) {
    for (let i = Math.min(a, b); i <= Math.max(a, b); i++) {
      if (l4.indexOf(l3[i]) >= 0) shared.add(l3[i]);
    }
  }
  const OUT = { 浦东南路: 1, 金海路: 1 };
  const meta = {};
  for (const n in inter) {
    const ls = inter[n];
    /* **只有"恰好是 3 号线 + 4 号线"的那几站才算共线同站台**。
       共线段上的 中山公园(l2/l3/l4)、金沙江路(l3/l4/l13)、镇坪路(l3/l4/l7)、
       曹杨路(l3/l4/l11)、上海火车站(l1/l3/l4) 都还接着别的线 —— 它们是
       货真价实的换乘站，只是恰好 3/4 共用一个站台。把它们一律判成"共线"
       会把 l2/l13/l7/l11/l1 的换乘客流整批抹掉，那是比原缺陷更糟的错。 */
    const type = (shared.has(n) && ls.length === 2) ? 'shared' : (OUT[n] ? 'out' : 'in');
    const walkSec = type === 'shared' ? 0
      : Math.min(210, 70 + 45 * Math.max(0, ls.length - 2)) + (type === 'out' ? 180 : 0);
    meta[n] = { type, walkSec, lines: ls, name: n };
  }
  SH.INTER_META = meta;
  SH.INTER_SHARED = shared;
})();

/** 站名 → 拼音英文名（游戏内双语标识用） */
const EN = {
  莘庄: 'Xinzhuang', 上海南站: 'South Ry. Station', 徐家汇: 'Xujiahui', 人民广场: "People's Square",
  陆家嘴: 'Lujiazui', 静安寺: 'Jing\'an Temple', 南京西路: 'W. Nanjing Rd.', 世纪大道: 'Century Ave.',
  龙阳路: 'Longyang Rd.', 虹桥火车站: 'Hongqiao Railway Station', 浦东1号2号航站楼: 'Pudong Airport',
  迪士尼: 'Disney Resort', 滴水湖: 'Dishui Lake', 东方绿舟: 'Oriental Land',
  国家会展中心: 'NECC', 豫园: 'Yuyuan Garden', 南京东路: 'E. Nanjing Rd.', 四川北路: 'N. Sichuan Rd.',
  外滩: 'The Bund', 大世界: 'Grand Theatre', 打浦桥: 'Dapuqiao', 田林: 'Tianlin',
  富锦路: 'Fujin Rd.', 上海马戏城: 'Shanghai Circus World', 中山北路: 'Zhongshan Rd.(N)',
  蟠祥路·国家会计学院: 'Panxiang Rd.', 一大会址·黄陂南路: 'Huangpi Rd.(S)',
  一大会址·新天地: 'Xintiandi', 沈杜公路: 'Shendu Hwy.', 汇臻路: 'Huizhen Rd.', 航头: 'Hangtou',
  紫竹高新区: 'Zizhu Hi-tech Park', 奉贤新城: 'Fengxian Xincheng', 曹路: 'Caolu',
  桂桥路: 'Guiqiao Rd.', 金海路: 'Jinhai Rd.', 花木路: 'Huamu Rd.', 江杨北路: 'Jiangyang Rd.(N)',
  西岑: 'Xicen', 基隆路: 'Jilong Rd.', 美兰湖: 'Meilan Lake', 上海松江站: 'Songjiang Ry. Station',
};
SH.EN = EN;

SH.STOCK = STOCK; SH.PERF = PERF; SH.LINES = LINES; SH.STATION_FEATURES = STATION_FEATURES;
SH.lineStations = id => LINES[id].stations;

/* --------------------------------------------- 支线交路（套跑）元数据单点定义
 *
 * 针对有 branch 的线路（5/10/11），提供分岔站、主支线终点、共线发车配比。
 * 10 号线主支线 2:1 混跑，5 号线与 11 号线 1:1 混跑。
 */
/* ---- 小交路（中途折返的第三交路）：折返点与占比 ----
   目标里那句"支线和主线的调度规则也要拉满"缺的就是这一条：在此之前全 20 条线
   只有"全程"与"Y 型支线贯通"两种行程，"大小交路"这个词里只有"大"。

   **数据口径（与第 129 条同一条纪律）**："上海地铁哪条线的小交路折返到哪一站"
   是逐线事实，本会话取不到可引用的出处（外网不通已实测），所以这里给的是
   **类规则**：站数 ≥ 20 且单程 ≥ 25 km 的线才投小交路（短线投小交路等于把端头
   那一半的班次直接砍掉，是倒效果），折返点取线路中点站，占比 1/3。
   逐线例外走 `SH.SHORT_TURN` 表 —— **填进去的每一条都得带出处**，
   与"默认档可以讲道理，逐站名单不行"是同一条账。 */
SH.SHORT_TURN = {};                    // 逐线例外：{ l1: { at: '站名', ratio: 0.33 } }
SH.shortTurn = function (line) {
  if (!line || !line.stations || line.svc === 'branch') return null;
  const st = line.stations, n = st.length;
  const total = line.al ? line.al.total : (line.km ? line.km * 1000 : 0);
  if (n < 20 || total < 25000) return null;
  const ex = SH.SHORT_TURN[line.baseId || line.id];
  if (ex) {
    const i = st.indexOf(ex.at);
    if (i > 0 && i < n - 1) return { idx: i, at: st[i], ratio: ex.ratio || 1 / 4, named: true };
  }
  const i = Math.round(n / 2) - 1;
  if (i <= 0 || i >= n - 1) return null;
  /* 占比 1/4 而不是 1/3：这条线没有"为小交路追加的车底"可配（配车只切不增，
     见 traffic.js `nShort`），实测 1/3 时共线段密度上升后，注入一次 2 分钟
     晚点的 40 分钟场景里正点率掉到个位数。1/4 是"加密干线但端头不至于没人跑"
     的那个折中，且它是**量出来的**，不是抄来的数。 */
  return { idx: i, at: st[i], ratio: 1 / 4, named: false };
};
/* ---- 支线贯通率（Y 型线的第四种行程，第 134 条）----
   第 121 条让支线交路真的贯通，但它是"全贯通"：支线车队每一列都从共线段一路开进
   尾巴。真实 Y 型运营还有第三种车 —— **在分岔站就折返**的支线区间车，它把共线段
   加密，而尾巴那几站少几班。这一条与"配车只切不增"同族：不追加车底。
   返回"每几列支线车放一列在分岔站折返"（0 = 全贯通）。
   **高峰给 0**：与第 121/129 条的既有标定逐字节一致（默认 hour=8 的一切判据不动）；
   平峰/深夜给 3 —— 类陈述（支线尾巴客流低于共线段，平峰把区间车抽出来加密共线段），
   逐线例外走 `SH.THROUGH_TURN`，**有出处才填**。 */
SH.THROUGH_TURN = {};
SH.branchTurnbackEvery = function (line, hour) {
  if (!line || line.svc !== 'branch') return 0;
  const h = hour == null ? 8 : hour;
  const peak = (h >= 7 && h < 9) || (h >= 17 && h < 19);
  const ex = SH.THROUGH_TURN[line.baseId || line.id];
  if (ex) return peak ? (ex.peak || 0) : (ex.off || 0);
  return peak ? 0 : 3;
};
SH.interlineMeta = function (line, hour) {
  if (!line) return null;
  const def = line.def || (line.branch ? line : null);
  if (!def || !def.branch) return null;
  const br = def.branch;
  const forkName = br.at;
  const stations = line.stations || def.stations;
  const forkIdx = stations ? stations.indexOf(forkName) : -1;
  const mainTerminus = def.stations[def.stations.length - 1];
  const branchTerminus = br.stations[br.stations.length - 1];
  /* 交路比例按钟点给（第 129 条）。**高峰档与既有标定逐字节一致**（不传 hour
     也走高峰档，所以默认 hour=8 时全线判据基线不动）；平峰与深夜把主线那一份
     加上 —— 等价于支线分到的车队变少。理由与 `SH.headwayFactor` 的交路系数同源：
     支线尾巴的客流低于共线段/主线，真实调度"抽车先抽支线"。
     这是"类"陈述（地铁支线客流低于干线是通行事实），不是某条线的真实运营时刻表。 */
  const r0 = def.id === 'l10' ? [2, 1] : [1, 1];
  const hh = hour == null ? 8 : ((hour % 24) + 24) % 24;
  const boost = ((hh >= 7 && hh <= 9) || (hh >= 17 && hh <= 19)) ? 0
    : (hh >= 22 || hh < 5) ? 2 : 1;
  const ratio = [r0[0] + boost, r0[1]];
  const pattern = [];
  for (let i = 0; i < ratio[0]; i++) pattern.push('main');
  for (let i = 0; i < ratio[1]; i++) pattern.push('branch');
  return {
    fork: forkName,
    forkIdx,
    mainTerminus,
    branchTerminus,
    ratio,
    pattern,
    isTrunk: function (stIdx) { return forkIdx >= 0 && stIdx <= forkIdx; },
  };
};

})(typeof window !== 'undefined' ? window : globalThis);
