// 소리 레시피: Voice 하나에 오실레이터 · 노이즈 · 필터를 그려 넣는 함수들.
// 언제 · 얼마나 자주 · 어느 버스로 울릴지는 sfx.ts 가 정한다. 모든 함수는 (v, t, ...) 를 받는다 (t = 시작 시각, 오디오 시계).
//
// 원칙: 어택은 2~5ms 선형, 끝은 지수 감쇠(클릭음 방지). 반복되는 소리는 6kHz 아래만 쓴다.

import type { PlanetSize } from '../config';
import { FLOOR, Voice, hold, midi, pluck, sweep } from './voice';

export type UiSound = 'click' | 'select' | 'toggle' | 'deny';
export type OrderSound = 'move' | 'assault' | 'surround' | 'join' | 'line' | 'return';
export type StingerKind = 'victory' | 'defeat';

/** 소리별 최대 길이(초). 동시에 울리는 보이스 수를 셀 때 쓴다 */
export const DUR = {
  ui: 0.2,
  order: 0.55,
  stinger: 4.2,
  shot: 0.14,
  hit: 0.24,
  death: 0.5,
  far: 0.5,
  spawn: 0.1,
  warp: 0.36,
  waveWarning: 2.1,
  waveStart: 3.2,
  alarm: 0.65,
  captureWin: 1.4,
  captureLoss: 1.9,
  captureOther: 0.5,
  triumph: 1.8,
} as const;

/** 진영별 사격음 기준 높이(Hz). 아군은 밝고 높게, 적은 낮게 → 귀로도 피아가 갈린다 */
const SHOT_PITCH = [700, 1180, 860, 980, 760];
const SPAWN_PITCH: Record<PlanetSize, number> = { small: 720, medium: 620, large: 530 };

// ───────────────────────────── UI · 명령 · 결과 ─────────────────────────────

/** UI 확인음. select 는 n(선택 수)이 클수록 높게, toggle 은 n>0 이면 올라가고 0 이면 내려간다 */
export function ui(v: Voice, t: number, kind: UiSound, n: number): void {
  switch (kind) {
    case 'click': {
      // 짧은 '톡': 삼각파가 빠르게 내려간다
      const o = v.osc('triangle', 1250, t, t + 0.07);
      sweep(o.frequency, t, 1250, 800, 0.03);
      o.connect(env(v, t, 0.05, 0.002, 0.055));
      break;
    }
    case 'select': {
      // 두 번 '삑삑': 선택이 많을수록 한 옥타브까지 올라간다 (1기 → 660Hz, 256기 → 1320Hz)
      const f = 660 * 2 ** Math.min(1, Math.log2(Math.max(1, n)) / 8);
      v.osc('sine', f, t, t + 0.08).connect(env(v, t, 0.05, 0.003, 0.065));
      v.osc('sine', f * 1.5, t + 0.05, t + 0.16).connect(env(v, t + 0.05, 0.045, 0.003, 0.095));
      break;
    }
    case 'toggle': {
      const [a, b] = n > 0 ? [523.25, 783.99] : [783.99, 523.25];
      v.osc('triangle', a, t, t + 0.08).connect(env(v, t, 0.05, 0.003, 0.06));
      v.osc('triangle', b, t + 0.06, t + 0.17).connect(env(v, t + 0.06, 0.05, 0.003, 0.1));
      break;
    }
    case 'deny': {
      // 낮은 '붕붕': 사각파를 저역 통과시켜 거칠지 않게
      const lp = v.filter('lowpass', 800, 0.7);
      lp.connect(v.out);
      for (const dt of [0, 0.1]) {
        const g = v.gain();
        hold(g.gain, t + dt, 0.05, 0.004, 0.05, 0.02);
        v.osc('square', 150, t + dt, t + dt + 0.08).connect(g).connect(lp);
      }
      break;
    }
  }
}

/** 명령 확인음. 같은 '지점 지정'이라도 결과(돌파/포위/합류…)가 귀로 구분되게 */
export function order(v: Voice, t: number, kind: OrderSound): void {
  switch (kind) {
    case 'move':
      // 담백한 '알겠음': D5 → A5 두 음
      v.osc('sine', 587.33, t, t + 0.1).connect(env(v, t, 0.055, 0.003, 0.09));
      v.osc('sine', 880, t + 0.06, t + 0.22).connect(env(v, t + 0.06, 0.05, 0.003, 0.15));
      break;
    case 'assault': {
      // 공격적: 톱니파가 한 옥타브 치솟고 와우 필터가 열렸다 닫힌다 + 노이즈 타격 + 서브 킥
      const lp = v.filter('lowpass', 500, 4);
      lp.frequency.setValueAtTime(500, t);
      lp.frequency.exponentialRampToValueAtTime(2600, t + 0.06);
      lp.frequency.exponentialRampToValueAtTime(900, t + 0.3);
      lp.connect(env(v, t, 0.08, 0.004, 0.3));
      sweepOsc(v, 'sawtooth', t, 98, 196, 0.12, 0.34).connect(lp);
      sweepOsc(v, 'square', t, 196, 392, 0.12, 0.34).connect(v.gain(0.7)).connect(lp);
      v.noise(t, t + 0.1).connect(v.filter('bandpass', 1400, 0.8)).connect(env(v, t, 0.07, 0.002, 0.08));
      sweepOsc(v, 'sine', t, 82, 41, 0.15, 0.22).connect(env(v, t, 0.09, 0.003, 0.2));
      break;
    }
    case 'surround': {
      // 넓게: 근음은 왼쪽, 5도는 오른쪽에서 어긋나게 울리고, 바람 소리가 좌→우로 휘감는다
      const left = v.panner(-0.8);
      const right = v.panner(0.8);
      left?.connect(v.out);
      right?.connect(v.out);
      v.osc('triangle', 392, t, t + 0.45).connect(env(v, t, 0.06, 0.03, 0.4, left ?? v.out));
      v.osc('triangle', 587.33, t + 0.05, t + 0.5).connect(env(v, t + 0.05, 0.06, 0.03, 0.4, right ?? v.out));
      const swirl = movingPan(v, t, -0.8, 0.8, 0.35);
      v.noise(t, t + 0.4).connect(v.filter('bandpass', 900, 2)).connect(env(v, t, 0.03, 0.05, 0.32, swirl));
      break;
    }
    case 'join':
      // 부드럽게 미끄러져 올라가는 사인 하나
      sweepOsc(v, 'sine', t, 440, 660, 0.12, 0.26).connect(env(v, t, 0.05, 0.012, 0.22));
      break;
    case 'line': {
      // 선 긋기: 노이즈가 왼쪽에서 오른쪽으로 '쓱' + 위로 올라가는 음
      const bp = v.filter('bandpass', 600, 1.5);
      sweep(bp.frequency, t, 600, 2000, 0.25);
      v.noise(t, t + 0.3).connect(bp).connect(env(v, t, 0.05, 0.02, 0.25, movingPan(v, t, -0.7, 0.7, 0.25)));
      sweepOsc(v, 'triangle', t, 523.25, 698.46, 0.2, 0.28).connect(env(v, t, 0.045, 0.01, 0.24));
      break;
    }
    case 'return':
      // 내려가는 두 음: '돌아와'
      v.osc('triangle', 659.26, t, t + 0.1).connect(env(v, t, 0.05, 0.003, 0.09));
      v.osc('triangle', 493.88, t + 0.07, t + 0.24).connect(env(v, t + 0.07, 0.05, 0.003, 0.16));
      break;
  }
}

/** 결과 음악. 마지막 섬멸/점령 효과음이 먼저 끝나도록 살짝 늦게 시작한다 */
export function stinger(v: Voice, t0: number, kind: StingerKind): void {
  if (kind === 'victory') {
    // C 장조 아르페지오 → 열리는 톱니파 화음 + 위에서 반짝이는 종소리
    const t = t0 + 0.45;
    [72, 76, 79, 84].forEach((m, i) => {
      const ts = t + i * 0.1;
      const g = env(v, ts, 0.075, 0.005, 0.5);
      v.osc('triangle', midi(m), ts, ts + 0.56).connect(g);
      v.osc('sine', midi(m + 12), ts, ts + 0.56).connect(v.gain(0.3)).connect(g);
    });
    const tc = t + 0.42;
    const lp = v.filter('lowpass', 600, 0.8);
    lp.frequency.setValueAtTime(600, tc);
    lp.frequency.exponentialRampToValueAtTime(2200, tc + 0.6);
    lp.frequency.exponentialRampToValueAtTime(1100, tc + 2.8);
    const pad = v.gain();
    hold(pad.gain, tc, 0.04, 0.15, 1, 1.6);
    lp.connect(pad).connect(v.out);
    chordInto(v, lp, tc, 2.8, [48, 60, 64, 67, 72, 76]);
    [88, 91, 96].forEach((m, i) => {
      const ts = tc + i * 0.07;
      v.osc('sine', midi(m), ts, ts + 1.1).connect(env(v, ts, 0.028, 0.003, 1));
    });
  } else {
    // 내려앉는 A–F–D, 이어서 아래로 처지는 D 단조 패드 + 낮은 바람
    const t = t0 + 0.3;
    [69, 65, 62].forEach((m, i) => {
      const ts = t + i * 0.34;
      v.osc('triangle', midi(m), ts, ts + 0.8).connect(env(v, ts, 0.085, 0.01, 0.7));
    });
    const tp = t + 0.9;
    const lp = v.filter('lowpass', 600, 0.7);
    sweep(lp.frequency, tp, 600, 180, 2.4);
    const pad = v.gain();
    hold(pad.gain, tp, 0.05, 0.3, 0.8, 1.6);
    lp.connect(pad).connect(v.out);
    for (const o of chordInto(v, lp, tp, 2.8, [38, 50, 53, 57])) {
      o.detune.setValueAtTime(o.detune.value, tp);
      o.detune.linearRampToValueAtTime(o.detune.value - 60, tp + 2.6);
    }
    v.noise(tp, tp + 2.8, 0.5).connect(v.filter('lowpass', 160, 0.6)).connect(swell(v, tp, 0.06, 0.8, 2.7));
  }
}

// ───────────────────────────── 전투음 ─────────────────────────────

/** 사격 '퓻': 사인파가 1.5배 → 0.5배로 빠르게 떨어진다. 빽빽하면 디튠 삼각파 + 노이즈 '치직'을 겹친다 */
export function shot(v: Voice, t: number, faction: number, density: number, close: number): void {
  const dur = 0.1 + 0.04 * density;
  const f = SHOT_PITCH[faction % SHOT_PITCH.length] * (1 + (Math.random() * 2 - 1) * 0.06);
  const level = 0.02 * (1 + 0.4 * density) * close;
  const g = env(v, t, level, 0.002, dur - 0.004);
  sweepOsc(v, 'sine', t, f * 1.5, f * 0.5, 0.08, dur).connect(g);
  if (density > 0.3) {
    sweepOsc(v, 'triangle', t, f * 1.47, f * 0.47, 0.09, dur).connect(v.filter('lowpass', 3200, 0.7)).connect(v.gain(0.45)).connect(g);
    v.noise(t, t + 0.035).connect(v.filter('bandpass', 1800, 1.2)).connect(env(v, t, level * 0.35 * density, 0.001, 0.03));
  }
}

/** 강하 공격이 행성 표면에 맞는 '쿵': 낮은 사인 하강 + 저역 노이즈 */
export function planetHit(v: Voice, t: number, intensity: number, close: number): void {
  const level = 0.07 * (1 + 0.5 * intensity) * close;
  sweepOsc(v, 'sine', t, 150, 50, 0.14, 0.24).connect(env(v, t, level, 0.003, 0.2));
  v.noise(t, t + 0.08, 0.7).connect(v.filter('lowpass', 480, 0.8)).connect(env(v, t, level * 0.7, 0.002, 0.07));
}

/**
 * 작은 폭발: 노이즈가 밝게 터졌다가 저역 통과 필터가 닫히며 '퍽' 하고 사그라든다 + 서브 저음.
 * 적이 터지면 조금 더 밝게(기분 좋게), 아군이 터지면 둔하게. 빽빽하면 늦게 따라오는 파편음을 겹친다.
 */
export function death(v: Voice, t: number, enemy: boolean, density: number, close: number): void {
  const dur = 0.36 + 0.14 * density;
  const level = 0.055 * (1 + 0.2 * density) * close;
  const lp = v.filter('lowpass', 2000, 0.9);
  sweep(lp.frequency, t, (enemy ? 2600 : 1500) * (0.85 + Math.random() * 0.3), 150, dur * 0.8);
  v.noise(t, t + dur, 0.75 + Math.random() * 0.4).connect(lp).connect(env(v, t, level, 0.003, dur - 0.012));
  sweepOsc(v, 'sine', t, 95, 38, 0.18, 0.24).connect(env(v, t, level * (0.7 + 0.4 * density), 0.004, 0.2));
  if (density > 0.35) {
    const td = t + 0.025 + Math.random() * 0.04;
    v.noise(td, td + 0.2, 1.1).connect(v.filter('bandpass', 900, 0.9)).connect(env(v, td, level * 0.5 * density, 0.002, 0.18));
  }
}

/** 화면 밖 전투: 멀리서 들리는 먹먹한 '쿵' (방향만 알려준다) */
export function farDeath(v: Voice, t: number): void {
  v.noise(t, t + 0.5, 0.6).connect(v.filter('lowpass', 380, 0.7)).connect(env(v, t, 0.05, 0.006, 0.45));
  sweepOsc(v, 'sine', t, 70, 35, 0.25, 0.35).connect(env(v, t, 0.04, 0.006, 0.3));
}

/** 아군 생산: 아주 작은 '뽁' (큰 행성일수록 낮게) */
export function spawn(v: Voice, t: number, size: PlanetSize): void {
  const f = SPAWN_PITCH[size];
  sweepOsc(v, 'sine', t, f, f * 1.5, 0.04, 0.1).connect(env(v, t, 0.02, 0.003, 0.085));
}

/** 워프 게이트에서 하나 튀어나옴: 대역 노이즈가 '휘익' 올라가다 사인 '뽕' */
export function warp(v: Voice, t: number, level: number): void {
  const bp = v.filter('bandpass', 250, 3);
  sweep(bp.frequency, t, 250, 2400, 0.22);
  v.noise(t, t + 0.3).connect(bp).connect(env(v, t, 0.1 * level, 0.06, 0.24));
  const tp = t + 0.16;
  sweepOsc(v, 'sine', tp, 240, 760, 0.09, 0.2).connect(env(v, tp, 0.075 * level, 0.003, 0.17));
}

// ───────────────────────────── 알림 ─────────────────────────────

/** 웨이브 예고: 높은 음 → 낮은 음 경적을 두 번. 톱니+사각파를 저역 통과시켜 금관처럼 */
export function waveWarning(v: Voice, t: number): void {
  const lp = v.filter('lowpass', 1300, 1.2);
  lp.connect(v.out);
  [311.13, 233.08, 311.13, 233.08].forEach((f, i) => {
    const ts = t + i * 0.5;
    const g = v.gain();
    hold(g.gain, ts, i < 2 ? 0.1 : 0.075, 0.04, 0.3, 0.1);
    g.connect(lp);
    // 금관처럼 살짝 아래에서 밀어 올리며 시작
    sweepOsc(v, 'sawtooth', ts, f * 0.94, f, 0.06, 0.48).connect(g);
    const b = v.osc('square', f, ts, ts + 0.48);
    b.detune.value = 7;
    b.connect(v.gain(0.5)).connect(g);
  });
}

/** 웨이브 시작: 땅이 울리듯 부풀어 오르는 저음 럼블 + 반음 충돌하는 낮은 화음 */
export function waveStart(v: Voice, t: number): void {
  v.noise(t, t + 3.2, 0.6)
    .connect(v.filter('lowpass', 150, 0.6))
    .connect(v.filter('lowpass', 150, 0.6))
    .connect(swell(v, t, 0.5, 1.1, 3.1));
  sweepOsc(v, 'sine', t, 36, 62, 1.4, 3.1).connect(swell(v, t, 0.22, 1.1, 3));
  const lp = v.filter('lowpass', 200, 1);
  sweep(lp.frequency, t, 200, 900, 1.2);
  lp.connect(swell(v, t, 0.08, 1.2, 3.1));
  chordInto(v, lp, t, 3.2, [38, 39]);
}

/** 아군 행성 피격 경보: 높낮이가 번갈아 '삐뽀삐'. 모성이면 4번 · 더 높게 · 한 옥타브 아래 톱니로 무게를 더한다 */
export function alarm(v: Voice, t: number, home: boolean, level: number): void {
  const beeps = home ? 4 : 3;
  const lp = v.filter('lowpass', 2200, 0.8);
  lp.connect(v.out);
  const peak = (home ? 0.065 : 0.048) * level;
  for (let i = 0; i < beeps; i++) {
    const ts = t + i * 0.15;
    const f = i % 2 === 0 ? (home ? 987.77 : 880) : home ? 739.99 : 659.26;
    const g = v.gain();
    hold(g.gain, ts, peak, 0.004, 0.075, 0.03);
    g.connect(lp);
    v.osc('square', f, ts, ts + 0.12).connect(g);
    if (home) v.osc('sawtooth', f / 2, ts, ts + 0.12).connect(v.gain(0.6)).connect(g);
  }
}

/** 아군 점령: 밝게 올라가는 장조 아르페지오 + 옥타브 반짝임. 적에게서 빼앗았으면 '쿵' 을 더한다 */
export function captureWin(v: Voice, t: number, fromEnemy: boolean, home: boolean): void {
  const notes = home ? [72, 76, 79, 84, 88] : [76, 80, 83, 88];
  notes.forEach((m, i) => {
    const ts = t + i * 0.065;
    const last = i === notes.length - 1;
    const g = env(v, ts, last ? 0.085 : 0.07, 0.004, last ? 0.9 : 0.35);
    v.osc('triangle', midi(m), ts, ts + (last ? 1 : 0.42)).connect(g);
    v.osc('sine', midi(m + 12), ts, ts + (last ? 1 : 0.42)).connect(v.gain(0.3)).connect(g);
  });
  // 반짝임: 한 번뿐인 소리라 4kHz 대역까지 쓴다
  v.noise(t, t + 0.4).connect(v.filter('bandpass', 4200, 1.5)).connect(env(v, t + 0.1, 0.02, 0.01, 0.3));
  if (fromEnemy) sweepOsc(v, 'sine', t, 120, 55, 0.25, 0.34).connect(env(v, t, 0.16, 0.004, 0.3));
}

/** 아군 행성 상실: 단2도로 어긋난 두 톱니파가 한 옥타브 미끄러져 내려가며 어두워진다 + 둔한 '쿵' */
export function captureLoss(v: Voice, t: number, home: boolean): void {
  const dur = home ? 1.9 : 1.3;
  const base = home ? 165 : 220;
  const lp = v.filter('lowpass', 1200, 1);
  sweep(lp.frequency, t, 1200, 220, dur * 0.8);
  lp.connect(env(v, t, home ? 0.12 : 0.105, 0.05, dur - 0.08));
  for (const r of [1, 1.0595]) sweepOsc(v, 'sawtooth', t, base * r, (base * r) / 2, dur * 0.85, dur).connect(lp);
  sweepOsc(v, 'sine', t, 75, 32, 0.35, 0.55).connect(env(v, t, 0.2, 0.005, 0.5));
}

/** 화면 안에서 AI 끼리 행성을 주고받음: 작은 4도 차임 */
export function captureOther(v: Voice, t: number, close: number): void {
  [72, 77].forEach((m, i) => {
    const ts = t + i * 0.08;
    v.osc('sine', midi(m), ts, ts + 0.4).connect(env(v, ts, 0.04 * close, 0.004, 0.35));
  });
}

/** 적 진영 섬멸: 필터가 활짝 열리는 C 장조 금관 화음 + 팀파니 */
export function triumph(v: Voice, t: number): void {
  const lp = v.filter('lowpass', 700, 0.9);
  lp.frequency.setValueAtTime(700, t);
  lp.frequency.exponentialRampToValueAtTime(2600, t + 0.12);
  lp.frequency.exponentialRampToValueAtTime(1100, t + 1.3);
  const g = v.gain();
  hold(g.gain, t, 0.05, 0.02, 0.35, 1.3);
  lp.connect(g).connect(v.out);
  chordInto(v, lp, t, 1.75, [48, 60, 64, 67, 72]);
  sweepOsc(v, 'sine', t, 98, 62, 0.4, 0.7).connect(env(v, t, 0.22, 0.004, 0.6));
  v.noise(t, t + 0.15).connect(v.filter('lowpass', 300, 0.7)).connect(env(v, t, 0.08, 0.003, 0.12));
}

// ───────────────────────────── 부품 ─────────────────────────────

/** 타악기형 엔벨로프를 건 게인 노드를 만들어 dest(기본: voice 출력)에 연결해 돌려준다 */
function env(v: Voice, t: number, peak: number, attack: number, decay: number, dest: AudioNode = v.out): GainNode {
  const g = v.gain();
  pluck(g.gain, t, peak, attack, decay);
  g.connect(dest);
  return g;
}

/** 천천히 부풀었다(rise) 사그라드는(end) 게인. 럼블처럼 '다가오는' 소리에 */
function swell(v: Voice, t: number, peak: number, rise: number, end: number): GainNode {
  const g = v.gain();
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(peak, t + rise);
  g.gain.exponentialRampToValueAtTime(FLOOR, t + end);
  g.connect(v.out);
  return g;
}

/** 주파수가 from → to 로 미끄러지는 오실레이터 */
function sweepOsc(v: Voice, type: OscillatorType, t: number, from: number, to: number, glide: number, dur: number): OscillatorNode {
  const o = v.osc(type, from, t, t + dur);
  sweep(o.frequency, t, from, to, glide);
  return o;
}

/** 좌우로 움직이는 패너 (voice 출력에 연결됨). 패너가 없는 환경이면 voice 출력 그대로 */
function movingPan(v: Voice, t: number, from: number, to: number, dur: number): AudioNode {
  const p = v.panner(from);
  if (!p) return v.out;
  p.pan.setValueAtTime(from, t);
  p.pan.linearRampToValueAtTime(to, t + dur);
  p.connect(v.out);
  return p;
}

/** 화음: 음마다 ±7센트로 어긋난 톱니파 두 개를 dest 에 연결 (합창처럼 두꺼워진다) */
function chordInto(v: Voice, dest: AudioNode, t: number, dur: number, notes: number[]): OscillatorNode[] {
  const out: OscillatorNode[] = [];
  for (const m of notes) {
    for (const d of [-7, 7]) {
      const o = v.osc('sawtooth', midi(m), t, t + dur);
      o.detune.value = d;
      o.connect(dest);
      out.push(o);
    }
  }
  return out;
}
