/* ============================================================================
 * audio.js — 程序化行车声 + 车站广播
 *
 * 两块：
 *   1. AudioEngine：全部由 WebAudio 实时合成，不下载任何音频文件。
 *      比南京版多出：按里程触发的钢轨接头、按真实曲率驱动的轮缘尖叫、
 *      进出隧道的气动冲击、制动缓解的长排气（对应 3.8 s 物理延迟）、
 *      受电弓离线电火花。
 *   2. PA：站名播报走 speechSynthesis，再串一条带通+混响+轻微失真的
 *      "车厢广播"链路。好处是任何站名都能播、零字节；代价是音色取决于
 *      系统语音包，所以同时永远显示字幕，且可在设置里关掉。
 * ==========================================================================*/
(function (global) {
'use strict';
const SH = global.SH;
const C = SH.clamp;

class AudioEngine {
  constructor() {
    this.ctx = null; this.ready = false; this.enabled = true; this.vol = 0.7;
    this.family = 'onix'; this.lastJoint = 0; this.lastAir = 0; this.lastRelease = 0;
    this.g = {};
  }
  setFamily(f) { this.family = f || 'onix'; }
  init() {
    if (this.ready) { this.resume(); return true; }
    const AC = global.AudioContext || global.webkitAudioContext;
    if (!AC) { SH.fatal && SH.fatal('音频不可用', '此浏览器没有 WebAudio。游戏仍可进行，只是没有声音。'); return false; }
    let ctx;
    try { ctx = this.ctx = new AC(); } catch (e) { return false; }
    this.master = ctx.createGain(); this.master.gain.value = this.enabled ? this.vol : 0;
    /* 总线压缩，防止多路噪声叠加削顶 */
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -16; comp.knee.value = 20; comp.ratio.value = 4.5; comp.attack.value = 0.004; comp.release.value = 0.26;
    /* 一点总线混响，让隧道有空间感 */
    this.rev = ctx.createConvolver();
    this.rev.buffer = this._impulse(1.6, 2.6);
    this.revGain = ctx.createGain(); this.revGain.gain.value = 0.10;
    this.master.connect(comp); comp.connect(ctx.destination);
    this.rev.connect(this.revGain); this.revGain.connect(comp);
    this.bus = ctx.createGain(); this.bus.gain.value = 1; this.bus.connect(comp);
    this.bus.connect(this.revGain);

    /* 3 秒粉噪，所有噪声源共用 */
    const len = Math.floor(ctx.sampleRate * 3);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate), d = buf.getChannelData(0);
    let b0 = 0, b1 = 0, b2 = 0;
    for (let i = 0; i < len; i++) {
      const w = Math.random() * 2 - 1;
      b0 = 0.99765 * b0 + w * 0.0990460; b1 = 0.96300 * b1 + w * 0.2965164; b2 = 0.57000 * b2 + w * 1.0526913;
      d[i] = (b0 + b1 + b2 + w * 0.1848) * 0.16;
    }
    this.noise = buf;
    const loop = (rate, type, freq, q, g0) => {
      const s = ctx.createBufferSource(); s.buffer = buf; s.loop = true; s.playbackRate.value = rate;
      const f = ctx.createBiquadFilter(); f.type = type; f.frequency.value = freq; f.Q.value = q == null ? 0.7 : q;
      const g = ctx.createGain(); g.gain.value = g0 || 0;
      s.connect(f); f.connect(g); g.connect(this.bus); s.start();
      return { s, f, g };
    };
    this.g.roll   = loop(0.62, 'bandpass', 440, 0.6);
    this.g.rail   = loop(1.35, 'highpass', 780, 0.5);
    this.g.wind   = loop(0.44, 'bandpass', 1150, 0.45);
    this.g.brake  = loop(1.05, 'bandpass', 1900, 1.3);
    this.g.tunnel = loop(0.20, 'lowpass', 155, 0.6);
    this.g.squeal = loop(1.8, 'bandpass', 2400, 9);      // 轮缘尖叫的噪声底座
    this.g.hiss   = loop(1.0, 'highpass', 3200, 0.7);    // 制动排气
    this.g.rainHiss = loop(1.15, 'highpass', 2600, 0.4); // 雨：高频嘶声层（雨点密）
    this.g.rainBody = loop(0.55, 'bandpass', 950, 0.35); // 雨：中频沙沙层（雨声的"体"）
    this.rainLevel = 0;

    /* 牵引逆变器：5 次谐波，基频随速度/牵引力上升 */
    this.invFilter = ctx.createBiquadFilter(); this.invFilter.type = 'lowpass'; this.invFilter.frequency.value = 2100;
    this.invGain = ctx.createGain(); this.invGain.gain.value = 0;
    this.invFilter.connect(this.invGain); this.invGain.connect(this.bus);
    this.inv = [[1, 'sawtooth', 0.44], [2.01, 'triangle', 0.22], [3.02, 'sine', 0.13], [4.03, 'square', 0.028], [5.07, 'sine', 0.05]]
      .map(([m, t, gv]) => { const o = ctx.createOscillator(); o.type = t; o.frequency.value = 100 * m; const g = ctx.createGain(); g.gain.value = gv; o.connect(g); g.connect(this.invFilter); o.start(); return { o, m, g }; });

    this.swTone = ctx.createOscillator(); this.swTone.type = 'square';
    this.swGain = ctx.createGain(); this.swGain.gain.value = 0;
    this.swTone.connect(this.swGain); this.swGain.connect(this.bus); this.swTone.start();

    this.regOsc = ctx.createOscillator(); this.regOsc.type = 'triangle';
    this.regGain = ctx.createGain(); this.regGain.gain.value = 0;
    this.regOsc.connect(this.regGain); this.regGain.connect(this.bus); this.regOsc.start();

    /* 空转哨音（粘着丢失） */
    this.slipOsc = ctx.createOscillator(); this.slipOsc.type = 'sawtooth'; this.slipOsc.frequency.value = 620;
    this.slipGain = ctx.createGain(); this.slipGain.gain.value = 0;
    this.slipOsc.connect(this.slipGain); this.slipGain.connect(this.bus); this.slipOsc.start();

    /* 辅助逆变器 + 空压机底噪 */
    this.aux = ctx.createOscillator(); this.aux.type = 'sine'; this.aux.frequency.value = 100;
    this.auxG = ctx.createGain(); this.auxG.gain.value = 0.006;
    this.aux.connect(this.auxG); this.auxG.connect(this.bus); this.aux.start();
    this.ready = true; this.resume();
    return true;
  }
  _impulse(sec, decay) {
    const ctx = this.ctx, n = Math.floor(ctx.sampleRate * sec), b = ctx.createBuffer(2, n, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) { const d = b.getChannelData(ch); for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / n, decay); }
    return b;
  }
  resume() { if (this.ctx && this.ctx.state === 'suspended') { const p = this.ctx.resume(); if (p && p.catch) p.catch(() => {}); } }
  setEnabled(v) { this.enabled = !!v; if (this.ctx) this.master.gain.setTargetAtTime(v ? this.vol : 0, this.ctx.currentTime, 0.05); }
  setVolume(v) { this.vol = C(v, 0, 1); if (this.ctx && this.enabled) this.master.gain.setTargetAtTime(this.vol, this.ctx.currentTime, 0.06); }
  /** 雨声雨量（0..1）。游戏侧由 App.rain 驱动；init 之前调用也要记住，
   *  否则"设置里开了雨、第一局没声音"（init 在首次点击时才发生）。 */
  setRain(v) { this.rainLevel = C(v, 0, 1); }

  _fam(kmh, tr) {
    if (this.family === 'siemens') return { base: 78 + kmh * 9.2 + tr * 92, filt: 1020 + kmh * 17, sw: 1420 + kmh * 12, ig: 0.92, reg: 218 + kmh * 9.6 };
    if (this.family === 'zzc')     return { base: 66 + kmh * 11.0 + tr * 96, filt: 760 + kmh * 19, sw: 1080 + kmh * 11, ig: 1.02, reg: 168 + kmh * 10.8 };
    return { base: 70 + kmh * 10.5 + tr * 88, filt: 720 + kmh * 18, sw: 1180 + kmh * 10, ig: 1, reg: 175 + kmh * 10.4 };
  }

  /**
   * @param t 列车状态 {kmh, a, trac, regen, air, slip, jerk}
   * @param env {tunnel:0..1, curveK, grade, doors}
   */
  update(t, env, dt) {
    if (!this.ready || !this.enabled || !t) return;
    const ctx = this.ctx, now = ctx.currentTime;
    const kmh = t.kmh || 0, v = SH.speedFeel(kmh);
    const tr = C(t.trac || 0, 0, 1), br = C((t.regen || 0) + (t.air || 0), 0, 1.3);
    const tun = env && env.tunnel != null ? env.tunnel : 0;
    const f = this._fam(kmh, tr);

    this.inv.forEach(x => x.o.frequency.setTargetAtTime(Math.max(26, f.base * x.m), now, 0.05));
    this.invFilter.frequency.setTargetAtTime(f.filt, now, 0.08);
    this.invGain.gain.setTargetAtTime(tr * (0.016 + 0.070 * C(v * 3.4, 0, 1)) * f.ig * (0.55 + 0.45 * tun), now, 0.07);
    this.swTone.frequency.setTargetAtTime(f.sw, now, 0.05);
    /* 轮轨滚动噪声的窗口原来在 34 km/h 就封顶（(kmh-8)/26），
       再生制动层在 45 km/h 封顶 —— 这正是"80 以上感觉不出更快"的听觉部分。
       改成随速持续上升的 speedFeel，让 50→70 km/h 之间仍有可辨的音量与音色差。 */
    this.swGain.gain.setTargetAtTime(tr * 0.005 * (0.35 + 0.65 * v), now, 0.08);
    this.regOsc.frequency.setTargetAtTime(f.reg, now, 0.05);
    this.regGain.gain.setTargetAtTime(C((t.regen || 0) / 1.05, 0, 1.2) * (0.014 + 0.050 * C(kmh / 45, 0, 1)), now, 0.055);
    this.aux.frequency.setTargetAtTime(100 + kmh * 0.12, now, 0.2);

    /* 轮轨：随速度上升；隧道内整体抬亮 */
    this.g.roll.f.frequency.setTargetAtTime(300 + 900 * v, now, 0.10);
    this.g.roll.g.gain.setTargetAtTime((0.005 + 0.098 * Math.pow(v, 0.84)) * (0.8 + 0.5 * tun), now, 0.10);
    this.g.rail.g.gain.setTargetAtTime(0.002 + 0.048 * Math.pow(v, 1.15), now, 0.10);
    this.g.wind.f.frequency.setTargetAtTime(760 + 880 * v, now, 0.13);
    this.g.wind.g.gain.setTargetAtTime((0.002 + 0.036 * Math.pow(v, 1.8)) * (1 - 0.75 * tun), now, 0.14);
    this.g.tunnel.g.gain.setTargetAtTime(0.075 * tun * Math.pow(v, 0.7), now, 0.16);

    /* 闸瓦摩擦：中低速最响 */
    const fw = C((kmh - 0.8) / 4.5, 0, 1) * C((38 - kmh) / 18, 0, 1);
    this.g.brake.f.frequency.setTargetAtTime(1250 + 1750 * C(kmh / 42, 0, 1), now, 0.06);
    this.g.brake.g.gain.setTargetAtTime(t.air * (0.012 + 0.10 * fw), now, 0.05);

    /* 轮缘尖叫：由真实曲率驱动——这是南京版做不到的，因为它没有曲线 */
    const k = env && env.curveK ? Math.abs(env.curveK) : 0;
    const sq = C(k * 260, 0, 1) * C((kmh - 6) / 12, 0, 1) * C((52 - kmh) / 26, 0, 1) * br * 1.4;
    this.g.squeal.f.frequency.setTargetAtTime(1500 + 900 * C(k * 400, 0, 1) + kmh * 6, now, 0.05);
    this.g.squeal.g.gain.setTargetAtTime(sq * 0.075, now, 0.05);

    /* 空转 */
    this.slipGain.gain.setTargetAtTime((t.slip || 0) * 0.030 * C(kmh / 12, 0, 1), now, 0.03);
    this.slipOsc.frequency.setTargetAtTime(520 + (t.slip || 0) * 900 + kmh * 3, now, 0.04);

    /* 钢轨接头：按里程触发，不是按时间 */
    const per = 25;                                   // m，伸缩缝/绝缘接头间距
    const s = t.s || 0;
    if (Math.floor(s / per) !== Math.floor(this.lastJoint / per) && kmh > 6) {
      this.lastJoint = s;
      const kk = C(kmh / 80, 0.2, 1) * (0.7 + 0.5 * (1 - tun));
      this._noiseBurst(0.085, 0.075 * kk, 1500, 380, 1.2);
      this._tone(78, now + 0.005, 0.10, 0.030 * kk, 'sine', 52);
    }
    /* 制动建立/缓解的排气声 */
    const ab = t.airBuild || 0;
    if (ab > 0.14 && now - this.lastAir > 0.62) { this.airApply(C(ab * 0.6, 0.25, 1)); this.lastAir = now; }
    else if (ab < -0.05 && now - this.lastRelease > 0.9) { this.airRelease(C(-ab * 4.5, 0.3, 1)); this.lastRelease = now; }
    /* 雨声（D4）：在隧道里衰减 —— 隔着车体与管片，雨只剩进洞前那一点残余。
       衰减量与增益曲线收进 rainGain() 单点（判据量它）。 */
    const rg = rainGain(this.rainLevel || 0, tun);
    this.g.rainHiss.g.gain.setTargetAtTime(rg.hiss, now, 0.4);
    this.g.rainBody.g.gain.setTargetAtTime(rg.body, now, 0.4);
    this.revGain.gain.setTargetAtTime(0.06 + 0.20 * tun, now, 0.25);
  }

  _tone(freq, start, dur, gain, type, endFreq) {
    if (!this.ready) return;
    const ctx = this.ctx, o = ctx.createOscillator(), g = ctx.createGain();
    o.type = type || 'sine'; o.frequency.setValueAtTime(freq, start);
    if (endFreq) o.frequency.exponentialRampToValueAtTime(Math.max(20, endFreq), start + dur);
    g.gain.setValueAtTime(0.0001, start);
    g.gain.linearRampToValueAtTime(gain, start + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, start + dur);
    o.connect(g); g.connect(this.bus); o.start(start); o.stop(start + dur + 0.04);
  }
  _noiseBurst(dur, gain, f1, f2, q) {
    if (!this.ready) return;
    const ctx = this.ctx, t = ctx.currentTime + 0.004;
    const s = ctx.createBufferSource(); s.buffer = this.noise;
    const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.Q.value = q || 0.8;
    f.frequency.setValueAtTime(f1, t); f.frequency.exponentialRampToValueAtTime(Math.max(60, f2), t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(gain, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    s.connect(f); f.connect(g); g.connect(this.bus); s.start(t); s.stop(t + dur + 0.05);
  }
  airApply(k) { this._noiseBurst(0.40, 0.055 * k, 3800, 1300, 0.7); }
  airRelease(k) { this._noiseBurst(1.5, 0.070 * k, 3400, 420, 0.55); }   // 缓解很慢，对应 3.8 s
  stopSettle(k) { const t = this.ctx ? this.ctx.currentTime + 0.01 : 0; this._tone(90, t, 0.22, 0.038 * k, 'sine', 58); this._noiseBurst(0.34, 0.030 * k, 1050, 340, 0.9); }
  click() { if (this.ready) this._tone(1240, this.ctx.currentTime + 0.004, 0.05, 0.030, 'square', 820); }
  horn() { if (!this.ready) return; const t = this.ctx.currentTime + 0.01; this._tone(311, t, 0.85, 0.085, 'sawtooth', 296); this._tone(415, t, 0.85, 0.070, 'sawtooth', 398); }
  /** 上海地铁标志性的两音提示：先"叮咚"再进播报 */
  chime() { if (!this.ready) return; const t = this.ctx.currentTime + 0.01; this._tone(988, t, 0.20, 0.085, 'sine'); this._tone(1319, t + 0.16, 0.42, 0.075, 'sine'); }
  chimeDepart() { if (!this.ready) return; const t = this.ctx.currentTime + 0.01; [659, 988].forEach((f, i) => this._tone(f, t + i * 0.17, i ? 0.40 : 0.18, 0.08, 'sine')); }
  doorOpen() { if (!this.ready) return; const t = this.ctx.currentTime; this._noiseBurst(0.55, 0.055, 2200, 700, 0.8); this._tone(1500, t + 0.02, 0.5, 0.012, 'sawtooth', 900); }
  /* 关门提示音：7 声"嘀"必须落在 SH.DOOR_BEEP 这条时间轴上 ——
     车门提示灯的闪烁（train.doorLampK）读的是同一个节拍。 */
  doorClose() { if (!this.ready) return; const t = this.ctx.currentTime; for (let i = 0; i < 7; i++) this._tone(1046, t + i * SH.DOOR_BEEP, 0.11, 0.055, 'square'); this._noiseBurst(0.42, 0.045, 1900, 700, 0.8); }
  alarm() { if (!this.ready) return; const t = this.ctx.currentTime; this._tone(880, t, 0.16, 0.075, 'square'); this._tone(880, t + 0.22, 0.16, 0.075, 'square'); }
  /** 受电弓离线电火花 */
  spark() { if (!this.ready) return; this._noiseBurst(0.16, 0.05, 6200, 1800, 3.5); }
  /** 进出隧道的气动冲击（"砰"的一下耳压） */
  portal(entering) { if (!this.ready) return; const t = this.ctx.currentTime; this._tone(entering ? 62 : 74, t, 0.30, 0.055, 'sine', entering ? 40 : 96); this._noiseBurst(0.28, 0.05, 900, 2600, 0.5); }
}

/* ==================================================================== PA */
class PA {
  constructor(audio) {
    this.audio = audio; this.enabled = true; this.onText = null; this.voices = [];
    this.pickVoice();
    if (global.speechSynthesis) {
      this._load = () => this.pickVoice();
      global.speechSynthesis.addEventListener && global.speechSynthesis.addEventListener('voiceschanged', this._load);
    }
  }
  pickVoice() {
    if (!global.speechSynthesis) return;
    const all = global.speechSynthesis.getVoices() || [];
    this.voices = all;
    this.zh = all.find(v => /zh[-_]CN/i.test(v.lang) && /Huihui|Xiaoxiao|Yaoyao|Ting|female|Google/i.test(v.name))
      || all.find(v => /^zh/i.test(v.lang)) || null;
    this.en = all.find(v => /en[-_]/i.test(v.lang) && /Aria|Zira|Google US|David/i.test(v.name))
      || all.find(v => /^en/i.test(v.lang)) || null;
  }
  setEnabled(v) { this.enabled = !!v; if (!v) { this.stop(); this.stopClip(); } }
  stop() { try { global.speechSynthesis && global.speechSynthesis.cancel(); } catch (e) {} }
  /**
   * 播报真实录音（玩家第 111-5 条：1 号线全程真实报站音频）。
   * 1 号线**只用真实录音**（玩家指示：原来的系统语音删掉，失败只沉默、
   * 不回退 speak()，免得真假两条叠着播）。其余线路/站不经过这里，
   * 仍走 speak() 的系统语音。懒加载：第一次用到才拉 mp3。
   */
  speakClip(url, zh, en, opts) {
    opts = opts || {};
    if (this.onText) this.onText({ zh, en, clip: url });
    if (!this.enabled || !url) return false;
    if (this.audio.ctx && global.Audio) {
      try { global.speechSynthesis && global.speechSynthesis.cancel(); } catch (e) {}
      if (opts.chime !== false && this.audio.ready) this.audio.chime();
      const delay = this.audio.ready ? 620 : 60;
      this._clip = new Audio(url);
      this._clip.volume = 0.95;
      /* 1 号线只用真实录音（玩家指示）：play() 失败就这一条沉默，
         不再回退 speak() —— 否则真假两条会叠着播。 */
      setTimeout(() => { const a = this._clip; if (a) a.play().catch(() => {}); }, delay);
      return true;
    }
    return false;
  }
  /** 播放中：停掉当前这条（切线路/退出驾驶时） */
  stopClip() { if (this._clip) { try { this._clip.pause(); this._clip.currentTime = 0; } catch (e) {} this._clip = null; } }
  /**
   * 播报：先响提示音，再用系统语音念中文、英文。
   * 走一条带通+失真的链路是做不到的（speechSynthesis 不给接节点），
   * 所以用 rate/pitch 调成"广播腔"，并在前后加提示音与静默。
   */
  speak(zh, en, opts) {
    opts = opts || {};
    if (this.onText) this.onText({ zh, en });
    if (!this.enabled || !global.speechSynthesis) return;
    const syn = global.speechSynthesis;
    try { syn.cancel(); } catch (e) {}
    const push = (text, voice, rate, pitch) => {
      if (!text) return;
      const u = new SpeechSynthesisUtterance(text);
      if (voice) u.voice = voice;
      u.lang = voice && voice.lang ? voice.lang : (voice === this.zh ? 'zh-CN' : 'en-US');
      u.rate = rate; u.pitch = pitch; u.volume = 0.95;
      syn.speak(u);
    };
    if (opts.chime !== false && this.audio.ready) this.audio.chime();
    const delay = this.audio.ready ? 620 : 60;
    setTimeout(() => {
      push(zh, this.zh, 0.94, 0.96);
      if (en) push(en, this.en || this.zh, 0.92, 1.0);
    }, delay);
  }
}

/** 雨声的两层增益（D4 单点，判据量它）：
 *  · hiss 高频嘶声随雨量走，是"在下雨"的第一听感；
 *  · body 中频沙沙是雨声的"体"，随雨量的平方涨（大雨不是线性变响）。
 *  隧道里两层都按 (1 − 0.88·tunnel) 衰减：管片外的大雨在车里只剩一点闷响。 */
function rainGain(v, tunnel) {
  const x = C(v, 0, 1), tn = C(tunnel || 0, 0, 1), k = 1 - 0.88 * tn;
  return { hiss: 0.052 * x * k, body: 0.040 * x * x * k };
}

SH.audio = { AudioEngine, PA, rainGain };

})(typeof window !== 'undefined' ? window : globalThis);
