/* ============================================================================
 * physics.js — 列车动力学与自动驾驶
 *
 * 以 01A07 的型式试验值为标定基准：
 *   0~36 km/h 平均加速度 ≥1.00 m/s²
 *   0~80 km/h 平均加速度 ≥0.835 m/s²
 *   常用制动 1.00 m/s²，紧急制动 ≥1.20 m/s²
 *   **制动缓解延迟约 3.8 s**（列车管空气传播，编组越长越慢）
 *   ATO 停车精度设计值 ±0.3 m
 *
 * 相对南京版多了四件真实的事：
 *   1. 载荷相关：AW0 空车到 AW3 超员，加速度与制动距离都变
 *   2. 粘着限制：黏着系数随速度衰减（Weber），低速大牵引会空转
 *   3. 曲线阻力（Davis w=650/R）与曲线限速：前者是轮轨横向挤磨，后者是未被
 *      平衡离心加速度的去处——两者不能混成一项，见 update() 里的 curveRes
 *   4. 空气制动的"建立/缓解"不对称：缓解要 3 秒以上，这是停车冲过头的主因
 *   5. 磁浮另走一套：无轮轨 → 无粘着上限、无轮缘曲线阻力，恒功拐点按设计速度
 * ==========================================================================*/
(function (global) {
'use strict';
const SH = global.SH;
const C = SH.clamp;

/* 手柄级位：牵引 4 档 + 惰行 + 常用 7 档 + 快速制动 + 紧急制动 */
const NOTCHES = [];
for (let i = 4; i >= 1; i--) NOTCHES.push({ v: i, label: 'P' + i, kind: 'power' });
NOTCHES.push({ v: 0, label: 'N', kind: 'coast' });
for (let i = 1; i <= 7; i++) NOTCHES.push({ v: -i, label: 'B' + i, kind: 'brake' });
NOTCHES.push({ v: -8, label: 'FR', kind: 'brake' });
NOTCHES.push({ v: -9, label: 'EB', kind: 'emergency' });

/* 各级位目标减速度（占常用全制动的比例），标定到 serv=1.0 m/s² */
const BRK_FRAC = { 1: 0.14, 2: 0.26, 3: 0.40, 4: 0.55, 5: 0.70, 6: 0.85, 7: 1.00, 8: 1.10 };/* 牵引各级位占 0~36 km/h 段的比例 */
const PWR_FRAC = { 1: 0.30, 2: 0.52, 3: 0.76, 4: 1.00 };
/* 纵向冲动（jerk）上限，m/s³。地铁口径：牵引侧 0.55、常用制动侧 0.85、
   紧急制动不额外温柔化（1.7 只是数值稳定的兜底）。
   导出成一份共享常数：物理限幅、平稳评分的"顶到限幅器"判据、离线判据
   三处必须读同一个数，否则又会出现"限幅器天花板比惩罚阈值低，指标永不生效"。 */
const JERK = { up: 0.55, dn: 0.85, eb: 1.70 };
SH.JERK = JERK;
/* 级位↔加速度的两张换算表也导出：需求整形的离线判据必须用**同一张表**核对
   "指令级位的标称加速度是否跟上了连续的需求"，在测试里另抄一份就等于给了判据
   一个和实现无关的第二真值，表一改就各说各话。 */
SH.PWR_FRAC = PWR_FRAC;
SH.BRK_FRAC = BRK_FRAC;

class Train {
  constructor(spec) {
    this.spec = spec;                       // {perf, stock, maxKmh}
    this.reset();
  }
  setSpec(spec) { this.spec = spec; }
  reset() {
    this.v = 0;                              // m/s
    this.a = 0;                              // m/s²
    this.jerk = 0;
    this.s = 0;
    this.notch = -3;
    this.trac = 0;                           // 牵引力建立状态 0..1
    this.brk = 0;                            // 制动力建立状态 0..1
    this.air = 0;                            // 空气制动分量
    this.regen = 0;                          // 再生制动分量
    this.bc = 0;                             // 制动缸压力 kPa
    this.eb = false;
    this.atp = 0;                            // 0 无 / 1 常用 / 2 紧急
    this.slip = 0;
    this.load = 1.0;                         // 1.0 = AW2 定员
    this.doors = false;
    this.dir = 1;
  }
  get kmh() { return this.v * 3.6; }
  get info() { return NOTCHES.find(n => n.v === this.notch) || NOTCHES[5]; }

  setNotch(v) {
    v = C(Math.round(v), -9, 4);
    if (this.eb && v !== -9) return false;
    if (this.doors && v > 0) return false;   // 开门牵引封锁
    this.notch = v;
    if (v === -9) this.eb = true;
    return true;
  }
  releaseEB() { if (this.v < 0.05) { this.eb = false; this.notch = -3; return true; } return false; }

  /** Weber 黏着系数：低速高、高速低；雨天/轨面潮湿由 wet 参数压低 */
  adhesion(kmh, wet) {
    const mu0 = wet ? 0.19 : 0.28;
    return mu0 / (1 + kmh / 55);
  }

  /**
   * @param dt 秒
   * @param env {limitKmh, grade(千分率), curveK(曲率), platform, doorsOpen, wet}
   */
  update(dt, env) {
    dt = C(dt, 0.001, 0.05);
    env = env || {};
    const sp = this.spec, pf = sp.perf, st = sp.stock;
    const vK = this.kmh;
    const grade = (env.grade || 0) / 1000;
    const k = env.curveK || 0;

    /* ---- 目标力 ---- */
    let aT = 0, aB = 0;
    if (this.notch > 0) aT = pf.accLo * PWR_FRAC[this.notch];
    if (this.notch < 0) { const n = -this.notch; aB = pf.serv * (BRK_FRAC[n] || 1.0); }
    if (this.eb) { aB = pf.emerg; aT = 0; }
    if (env.doorsOpen) { aT = 0; aB = Math.max(aB, 0.5); }

    /* ---- ATP 超速防护：先常用后紧急 ----
       以前这是**无条件生效**的，等于玩家永远有一个兜底。按需求改成开关，
       并且默认关闭：`env.atpOn` 为假时只记录 `atp` 状态用于显示，不介入牵引/制动，
       所以超速的后果由玩家自己承担（制动距离不够就冲过停车标）。
       真实司机也是这个关系：ATP 是防护，不是自动驾驶的油门。 */
    const lim = env.limitKmh || sp.maxKmh;
    /* 把"当前限速"与"超了多少"暴露出来，给 HUD 与播报用。
       注意语义：ATP 关闭时 `atp` 仍然会被置位，它表达的是"**已经超出限速**"这个
       状态，不是"防护已经动作"。以前 HUD 直接把它翻译成"制动/紧急"，
       于是关着 ATP 也会显示成被系统刹了，是误导。 */
    this.limKmh = lim;
    this.over = vK - lim;
    this.atp = 0;
    if (vK > lim + 3) { this.atp = 1; if (env.atpOn) { aB = Math.max(aB, 0.75); aT = 0; } }
    if (vK > lim + 9) { this.atp = 2; if (env.atpOn) { aB = Math.max(aB, pf.emerg * 0.85); aT = 0; } }

    /* ---- 载荷：AW0 轻、AW3 重，直接影响加速度 ---- */
    const loadK = 1 / C(this.load, 0.72, 1.32);

    /* ---- 恒功率：高速段牵引力按 1/v 衰减 ---- */
    /* 恒功拐点（基速）是**牵引装置的属性**，不是一个通用常数。地铁旋转电机
       42 km/h 进恒功区；长定子直线电机把牵引力沿整条线路铺开，没有"基速以下
       恒扭矩"这一限制，恒功区按构造速度的 75% 起 —— 磁浮构造 431 ⇒ 拐点 323，
       落在运营速度 300 之外，所以运营区内牵引力恒定（这正是它能一路爬到
       430 的原因），功率随速度线性增长。 */
    const knee = st.maglev ? 0.75 * (sp.maxKmh || 80) : 42;   // km/h，恒扭矩段终点
    let pwK = vK <= knee ? 1 : Math.min(1, knee / Math.max(knee, vK));
    /* 构造速度必须是**真正的渐近上限**。
       原来只写 `if (vK > 0.9*maxKmh) pwK *= 0.55` —— 掉一截之后仍有余量，
       实测 ATP 关闭时 1 号线（构造速度 80）能一路爬到 87.9 km/h，
       等于"设计最高时速"只是个装饰数字。现在让功率在最后 10% 区间
       平滑收到 0：v = maxKmh 时牵引为零，越接近越没劲，但不会突然断。
       这里的前提是 `maxKmh` 是**构造速度**、运营上限另有 `runKmh`。
       磁浮以前把两者都写成 300，于是 0.9·vTop = 270 的渐近带正好压在巡航区，
       实测贴不住 300（最高 291）且 ATO 每 0.3 s 换一次级位追速度。
       现在 maxKmh=431（本文件数据侧 _note 里的"最高 431 km/h"）、runKmh=300，
       渐近带退出运行区，仍然是硬上限。 */
    const vTop = sp.maxKmh || 80;
    if (vK > 0.9 * vTop) {
      const x = C((vK - 0.9 * vTop) / (0.1 * vTop), 0, 1);
      pwK *= 1 - x * x;
    }
    /* 低速蠕行时牵引不能瞬间满力，模拟逆变器升流 */
    if (vK < 3 && aT > 0) aT *= 0.72 + 0.28 * (vK / 3);

    /* ---- 粘着限制：可用人牵引力 = μ·g·(动轴重量占比) ----
       磁浮没有轮轨接触面，"粘着"这个概念对它不成立（这正是高速磁浮的意义：
       牵引力不受 μ 限制，雨天也不空转）。以前照抄 Weber 曲线，
       于是 300 km/h 时 μ 已经衰减到 0.44，把指令牵引削掉一截。 */
    const fm = /(\d)M(\d)T/.exec(st.formation || '') || [, '4', '2'];
    const motored = st.cars ? Math.min(1, +fm[1] / (st.cars / 2)) : 0.66;
    const mu = st.maglev ? Infinity
      : this.adhesion(vK, env.wet) * motored * 9.81 * (st.type && st.type.indexOf('C') >= 0 ? 0.92 : 1);
    const wantTrac = aT * pwK * loadK;
    const adhesionLimit = Math.max(0.12, mu);
    this.slip = wantTrac > adhesionLimit ? C((wantTrac - adhesionLimit) / adhesionLimit, 0, 1) : 0;
    const tracCmd = Math.min(wantTrac, adhesionLimit) / (pf.accLo || 1);

    /* ---- 一阶建立（升慢降快），不对称是手感关键 ---- */
    const tUp = 0.62, tDn = 0.30;
    this.trac += (tracCmd - this.trac) * (1 - Math.exp(-dt / (tracCmd > this.trac ? tUp : tDn)));

    /* ---- 再生 + 空气混合制动 ---- */
    const regenAvail = C((vK - pf.regenFloorKmh) / 14, 0, 1);
    const share = this.eb ? 0.20 : 0.72;
    const aBcmd = aB * (this.eb ? 1 : loadK * 0.94 + 0.06);
    /* 制动缸充气：小级位快、大级位慢（列车管容积效应） */
    const bUp = 0.42 + 0.55 * C(aBcmd / 1.2, 0, 1);
    /* 缓解明显更慢：空气要靠排气口放掉，编组越长越慢 —— 01A07 实测 3.8 s */
    const bDn = (pf.release || 3.4) * C(st.cars / 6, 0.7, 1.45) * 0.42;
    const bTarget = aBcmd / (pf.serv || 1);
    this.brk += (bTarget - this.brk) * (1 - Math.exp(-dt / (bTarget > this.brk ? bUp : bDn)));
    const applied = this.brk * (pf.serv || 1);
    this.regen += (applied * share * regenAvail - this.regen) * (1 - Math.exp(-dt / 0.22));
    const airWant = Math.max(0, applied - this.regen);
    /* 低速时再生退出，空气必须补上，否则列车会"刹不住"地溜过去 */
    const airCmd = airWant + (vK < 6 ? (1 - vK / 6) * applied * 0.35 : 0);
    this.air += (airCmd - this.air) * (1 - Math.exp(-dt / (airCmd > this.air ? 0.55 : 0.34)));

    /* ---- 合力 ---- */
    const tractionAccel = this.trac * (pf.accLo || 1) * pwK * (1 - this.slip * 0.55);
    /* 湿轨（D4）：制动同样受黏着限制。干轨 μ·g ≈ 2.4 m/s²，常用制动从来够不着
       这条线；湿轨 0.19/(1+v/55)·9.81 在 60 km/h 只有 ~0.97 —— B7/B8 的需求被
       削到黏着极限，这正是防滑器（WSP）动作时"制动力掉回去"的物理落点，
       也是"雨天制动距离变长"的出处。磁浮无轮轨接触，不受这条限制。 */
    const brakeAccelRaw = this.regen + this.air;
    const brakeAdh = st.maglev ? Infinity : this.adhesion(vK, env.wet) * 9.81;
    const brakeAccel = Math.min(brakeAccelRaw, brakeAdh);
    /* 基本阻力（Davis 式）+ 曲线附加阻力 + 坡道 */
    /* 基本阻力（Davis 式）+ 曲线附加阻力 + 坡道。
       曲线阻力以前写成 `|k|·v²·0.55`，也就是把**未被平衡的离心加速度**当成
       纵向阻力来扣 —— 单位就不对：横向加速度不做功。后果是高速线被自己的
       大半径曲线杀光：磁浮 R=5542 m 在 290 km/h 下要扣 0.69 m/s²，
       和整条气动力阻力量级一样，实测极速被压到 128 km/h（限速明明写着 300）。
       未被平衡离心加速度该去的地方是**曲线限速表与平稳评分**，两处都已经有了。
       这里换成教科书里的曲线附加阻力 w=650/R (N/kN) ⇒ a=6.38·k，
       R=343 m 的地地铁弯道上只有 0.019 m/s²，量级才对得上。 */
    const drag = 0.0085 + 0.0000325 * vK * vK / 3.6 * 0.06 + 0.00009 * this.v * this.v;
    const curveRes = k ? Math.min(0.12, Math.abs(k) * 6.38) : 0;
    const gradeAcc = 9.81 * grade;
    const target = tractionAccel - brakeAccel - drag - curveRes - gradeAcc;

    /* ---- 纵向冲动限幅 ---- */
    /* 数值取真实地铁口径：牵引侧 ATO 限到 0.55 m/s³（换级几乎感觉不到），
       常用制动侧放宽到 0.85（制动本来就该更坚决），紧急制动不假装温柔。
       以前是 0.75 / 1.05，是"手感调出来的"，比舒适标准松一档；
       而平稳评分的惩罚阈值写在 0.85，恰好卡在限幅器天花板之上 ——
       于是那一项永远不罚分，成了自我一致的空指标。见 game.js 的 comfort。 */
    const jUp = SH.JERK.up, jDn = this.eb ? SH.JERK.eb : SH.JERK.dn;
    const da = C(target - this.a, -jDn * dt, jUp * dt);
    this.a += da;
    this.jerk = da / dt;

    /* ---- 积分 ---- */
    let nv = this.v + this.a * dt;
    if (nv < 0) nv = 0;
    if (nv < 0.04 && brakeAccel > 0.06) { nv = 0; if (Math.abs(this.a) < 0.2) this.a = 0; }
    this.v = nv;
    const ds = (this.v + nv) * 0.5 * dt;
    this.s += ds;

    /* ---- 保持制动与制动缸表压 ---- */
    const hold = (nv < 0.08 && this.notch <= -1) ? Math.min(220, 110 + (-this.notch) * 16) : 0;
    this.bc = Math.max(hold, this.air / (pf.emerg || 1.2) * 420);
    return ds;
  }

  /** 按当前制动力预估停车距离（含缓解/建立延迟） */
  predictStop(grade) {
    const v = this.v;
    if (v < 0.02) return 0;
    /* 注意：`regen + air` **已经是载荷折算之后**的减速度（`update()` 里
       `brakeAccel × loadK`，loadK = 1/clamp(load,0.72,1.32)），这里再乘一次
       等于把载荷算两遍 —— 实测超员时反而停短 0.88~1.00 m。
       载荷对停车规划的影响走 ATO 的收力偏置（见 `bias`），不在这里重复折算。 */
    const decel = Math.max(0.06, (this.regen + this.air) - 9.81 * (grade || 0) / 1000);
    const build = this.brk < 0.9 ? v * 0.40 : 0;
    return v * v / (2 * decel) + build;
  }
}

/* ==================================================================== ATO */
/**
 * 目标：把停车误差压进 ±0.3 m（01A07 的设计指标）。
 * 做法：一条按舒适减速度反推的距离-速度包络 + 按坡度/曲线补偿的收尾点。
 */
class ATO {
  constructor(mode) { this.mode = mode || 'manual'; this.handover = false; this.demand = null; this.cur = 0; }
  reset(mode) { this.mode = mode || this.mode; this.handover = false; this.demand = null; this.cur = 0; }
  /**
   * ---- 把"阶跃选档"整形成"连续加速度需求" ----
   * 上面那张决策表是**无记忆**的：速度误差一跨过阈值就换档，而 0.1 km/h 的抖动
   * 就足够在 0 / 1 / −2 之间来回翻。每翻一次就是一步约 0.29 m/s² 的牵引阶跃，
   * 物理侧的 jerk 限幅器全程顶格 —— 实测每站约 5 秒钉在天花板上，
   * 乘客感觉得到，而原来的平稳评分根本看不见这件事。
   * 真实 ATO 输出的是**加速度目标**，牵引控制按 jerk 限幅去追它，级位只是实现手段。
   * 所以这里：级位 → 名义加速度 → 对需求做 jerk 限幅 → 再带 0.09 m/s² 迟滞
   * 反选最接近的级位（当前档能凑合就不换档）。
   */
  _shape(dt, want, ctx) {
    if (want == null || !(dt > 0)) return want;
    const lo = (ctx.perf || {}).accLo || 0.95, sv = (ctx.perf || {}).serv || 1.0;
    /* 级位→加速度的映射必须带载荷：`loadK` 与 `update()` 里是同一个折算。
       不带它，"−5 档 = 0.85 m/s²" 这个假设在超员工况下就是假的 —— 物理只给得出
       0.85 ÷ 1.06 ≈ 0.80，需求曲线与实际能力之间长期差着一个载荷比，
       满载进站就会系统性冲过头（16 号线 106% 满载时人工 0.62 m > 0.60 门槛）。
       这不是"把门槛放宽"，是补一处第二真值：物理知道车有多重，ATO 不知道。 */
    const loadK = 1 / C(ctx.load == null ? 1 : ctx.load, 0.72, 1.32);
    const accOf = n => n > 0 ? lo * (PWR_FRAC[n] || 1) * loadK : n < 0 ? -sv * (BRK_FRAC[-n] || 1) * loadK : 0;
    if (this.demand == null) this.demand = accOf(this.cur);
    const tgtA = accOf(want);
    this.demand += C(tgtA - this.demand, -SH.JERK.dn * dt, SH.JERK.up * dt);
    /* 迟滞 0.09 m/s²。**不做最小保持时间**，也不要把迟滞调大 —— 都是实测否掉的：
       ① 不分方向一律保持 1.2 s：末端制动指令被延迟，误差 0.10 → 0.75 m；
       ② 只允许"加制动"立即放行：末端闭环是**双边**调节（收一点给一点），
          挡住缓解就变成过量制动，误差 0.10 → 1.42 m（停短）；
       ③ 只在巡航段保持：换级次数只从 120/站 降到 93/站，误差仍 0.41~0.72 m；
       ④ 迟滞 0.09 → 0.12：缓解同样被挡住，误差 0.07 → 0.71 m。
       真实 ATO 的牵引级位是粗档位，中间加速度靠"来回跳档"实现，
       所以**换挡频率不是好的舒适度指标**；乘客感到的是 jerk 与顶格时间，
       那两条由 test-drive 钉住（实测 ATO 顶格 1.1%、司机 6.9%）。 */
    let best = this.cur, bd = Math.abs(accOf(this.cur) - this.demand);
    if (bd > 0.09) {
      for (let n = -7; n <= 4; n++) {
        const e = Math.abs(accOf(n) - this.demand);
        if (e < bd - 1e-9) { bd = e; best = n; }
      }
    }
    this.cur = best;
    return best;
  }
  notch(dt, ctx) { return this._shape(dt, this._decide(ctx), ctx); }
  _decide(ctx) {
    if (this.mode === 'manual') return null;
    const d = ctx.distanceToStop, v = ctx.speedKmh, lim = ctx.limitKmh;
    const grade = ctx.grade || 0, curve = ctx.curveLimit || 999;
    if (this.mode === 'semi' && d < 60) { this.handover = true; return null; }

    /* 目标速度包络 */
    let tgt = Math.min(lim - 2, curve - 2);
    const comfort = C(0.50 + 9.81 * grade / 1000 + (ctx.curveK ? Math.abs(ctx.curveK) * 40 : 0), 0.30, 0.72);
    const brakeCurve = Math.sqrt(Math.max(0, 2 * comfort * Math.max(0, d - 0.2))) * 3.6;
    tgt = Math.min(tgt, brakeCurve);
    if (d < 120) tgt = Math.min(tgt, 32);
    if (d < 60) tgt = Math.min(tgt, 21);
    if (d < 30) tgt = Math.min(tgt, 12);
    if (d < 14) tgt = Math.min(tgt, 6.2);
    if (d < 6) tgt = Math.min(tgt, 3.0);
    if (d < 2.0) tgt = Math.min(tgt, 1.0);
    if (d < 0.45) tgt = 0;

    const over = v - tgt;
    /* 收尾点：下坡提前、上坡推迟；编组越长缓解越慢要越早收 */
    const fp = 0.34 + Math.max(0, -grade) * 0.022 - Math.max(0, grade) * 0.014;
    if (d < fp && v > 0.10) return -6;

    /* ---- 进站闭环 ----
       开环的速度包络算不出空气制动的真实建立/缓解滞后，实测会停在 −1.2 m 左右。
       这里改用"当前制动力下的预测停车距离"与剩余距离直接比对，
       等于把模型自身的延迟补偿掉，才能压进 ±0.3 m 的设计指标。 */
    if (d < 90 && typeof ctx.predictStop === 'number') {
      /* 实测标定：直接把 ps 与 d 比对会系统性偏短 —— predictStop 用当前
         制动力外推，而制动仍在继续建立，所以要提前一点收。
         参数扫描（7 条线 × 2 段，`node sweep-bias.js`）：
              bias -0.7 → 平均 -0.33 m / 最差 0.47 m
              bias -1.0 → 平均 -0.08 m / 最差 0.13 m   ← 采用
              bias -1.3 → 平均 +0.11 m / 最差 0.17 m
              bias -1.6 → 平均 +0.29 m / 最差 0.37 m
         旧值 −0.70 是在"级位阶跃"下标出来的；ATO 现在输出连续加速度需求
         （`_shape`），多了约 0.3 m 的响应滞后，所以整条曲线往负方向平移了 0.3。
         重标之后 ATO 停车精度仍优于上海真实运营的设计指标 ±0.3 m。 */
      const bias = (SH.__atoBias == null ? -1.00 : SH.__atoBias) + Math.max(0, -grade) * 0.02;
      const ps = ctx.predictStop;
      const gap = ps - (d - bias);               // >0 表示会冲过头
      if (gap > 1.20) return -6;
      if (gap > 0.55) return -5;
      if (gap > 0.22) return -4;
      if (gap > -0.18) return -3;
      if (gap > -0.70) return -2;
      if (gap > -1.60) return -1;
      if (gap > -2.80) return 0;
      if (v < 4.5) return 1;                     // 差得远，补一点牵引
      return 2;
    }

    if (over > 9) return -7;
    if (over > 6) return -6;
    if (over > 3.6) return -5;
    if (over > 2.0) return -4;
    if (over > 0.9) return -3;
    if (over > 0.28) return -2;
    if (v < tgt - 3.5) return v < tgt - 12 ? 4 : v < tgt - 7 ? 3 : 2;
    if (v < tgt - 1.0 && d > 0.9) return 1;
    return 0;
  }
}

/* --------------------------------------------------------- 评分与停车判定 */
function judge(error) {
  const a = Math.abs(error);
  if (a <= 0.10) return { grade: 'SSS', title: '完美对位', color: '#72ffd1', p: 100 };
  if (a <= 0.25) return { grade: 'SS', title: '精准停车', color: '#76e6ff', p: 96 };
  if (a <= 0.50) return { grade: 'S', title: '达标停车', color: '#9ce8ff', p: 91 };
  if (a <= 1.00) return { grade: 'A', title: '良好停车', color: '#c9e86d', p: 84 };
  if (a <= 2.00) return { grade: 'B', title: '合格停车', color: '#f6da67', p: 74 };
  if (a <= 3.50) return { grade: 'C', title: '轻微错位', color: '#ffad61', p: 60 };
  if (a <= 6.00) return { grade: 'D', title: '明显错位', color: '#ff7e68', p: 44 };
  return { grade: 'E', title: '门位错开', color: '#ff565f', p: 22 };
}

SH.physics = { Train, ATO, NOTCHES, judge, BRK_FRAC, PWR_FRAC };

})(typeof window !== 'undefined' ? window : globalThis);
