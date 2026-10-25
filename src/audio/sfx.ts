/**
 * 효과음 · 배경음. 오디오 파일 없이 WebAudio 로 전부 합성한다.
 *
 * 사용법 (src/main.ts):
 *   sfx.unlock()                         사용자 제스처 안에서 호출 (첫 입력, 게임 시작/재시작 버튼)
 *   sfx.handleEvents(events, world, view) 매 프레임 시뮬레이션 이벤트 → 전투음 (view = 화면에 보이는 월드 사각형)
 *   sfx.ui(kind, n?) / sfx.order(kind)    버튼 · 선택 · 명령 확인음
 *   sfx.startAmbient() / stopAmbient()    한 판 동안의 배경음
 *   sfx.stinger('victory' | 'defeat')     결과 음악
 *   sfx.muted / setMuted / toggleMuted    음소거 (localStorage 에 저장)
 *
 * AudioContext 가 없거나 아직 잠겨 있으면 모든 메서드는 조용히 아무것도 하지 않는다.
 *
 * 소리 크기 원칙: 반복되는 전투음은 '들릴락 말락', 놓치면 안 되는 알림(점령 · 경보 · 섬멸)은 또렷하게.
 * 전투가 빽빽해지면 소리 개수를 늘리는 대신 줄이고 두껍게 만들어 귀가 피곤하지 않게 한다.
 */
import { PLAYER, type GameEvent } from '../sim/types';
import type { World } from '../sim/world';
import { Ambient } from './ambient';
import * as R from './recipes';
import type { OrderSound, StingerKind, UiSound } from './recipes';
import { Voice, makeNoise } from './voice';

export type { OrderSound, StingerKind, UiSound };

/** 화면에 보이는 월드 영역 (카메라 좌상단 · 우하단의 월드 좌표) */
export interface ViewRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** 0 = 반복 전투음(가장 먼저 버림) · 1 = 일반 · 2 = 놓치면 안 되는 알림 */
type Priority = 0 | 1 | 2;

const MASTER = 0.6;
/** 효과음 버스 이득. 큰 소리는 리미터가 눌러 주므로 작은 전투음이 묻히지 않을 만큼 올려 둔다 (배경음은 제외) */
const BUS_GAIN = 1.5;
/** 동시에 울리는 소리 상한. 반복 전투음은 더 낮은 상한에서 잘라 중요한 소리 자리를 남긴다 */
const MAX_VOICES = 24;
const LOW_VOICES = 16;
const HARD_VOICES = 32;
/** 예약 여유: 현재 시각에 바로 걸면 어택 앞부분이 잘릴 수 있다 */
const LOOKAHEAD = 0.01;

/** 사격음 간격: 드문드문할 땐 초당 14번까지, 빽빽하면 초당 6번으로 줄이는 대신 두껍게 */
const SHOT_GAP_SPARSE = 1 / 14;
const SHOT_GAP_DENSE = 1 / 6;
const HIT_GAP = 0.22;
const DEATH_GAP_SPARSE = 1 / 8;
const DEATH_GAP_DENSE = 0.2;
const FAR_DEATH_GAP = 0.6;
const SPAWN_GAP = 0.4;
const WARP_GAP = 0.2;
const FAR_WARP_GAP = 1;
const OTHER_CAPTURE_GAP = 0.5;
const ALARM_GAP = 6;
/** 모성 경보는 일반 경보 직후라도 이만큼 지나면 울린다 */
const HOME_ALARM_GAP = 1.5;
/** 점령 직후에는 잔당의 반격으로 바로 경보가 울리지 않게 (점령 효과음과 겹침 방지) */
const CAPTURE_GRACE = 4;
const ALARM_MIN_ATTACKERS = 4;

const STORAGE_KEY = 'planet-saving.muted';

export interface SfxStats {
  /** 시작된 소리 수 (종류별 포함) */
  started: number;
  /** 보이스 상한 때문에 버려진 소리 수 */
  dropped: number;
  /** 동시에 울린 최대 보이스 수 */
  maxActive: number;
  byKind: Record<string, number>;
}

export class Sfx {
  readonly stats: SfxStats = { started: 0, dropped: 0, maxActive: 0, byKind: {} };

  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  /** 반복 전투음 버스 (중요한 알림이 울릴 때 잠깐 낮춘다) */
  private fx: GainNode | null = null;
  /** UI · 명령 · 알림 버스 */
  private key: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private ambient: Ambient | null = null;
  private wantAmbient = false;
  private paused = false;
  private _muted = readMuted();

  /** 진행 중인 보이스의 예정 종료 시각. onended 에 기대지 않아 컨텍스트가 멈춰도 개수가 새지 않는다 */
  private ends: number[] = [];

  // 스로틀 · 밀도 추적 (오디오 시계 기준)
  private lastCall = 0;
  private shotRate = 0;
  private deathRate = 0;
  private lastShot = -1;
  private lastHit = -1;
  private lastDeath = -1;
  private lastFarDeath = -1;
  private lastSpawn = -1;
  private lastWarp = -1;
  private lastFarWarp = -1;
  private lastOtherCapture = -1;
  private lastAlarm = -Infinity;
  private lastAlarmHome = false;

  // 배경음 긴장도 (실시간 기준, 이벤트가 없는 프레임에도 식어야 하므로 타이머로 갱신)
  private combatShots = 0;
  private combat = 0;
  private tickAt = 0;
  private tickTimer = 0;

  /** 점령 시각(월드 시간) — 점령 직후 경보 억제용. 판이 바뀌면 초기화 */
  private world: World | null = null;
  private capturedAt: number[] = [];

  get muted(): boolean {
    return this._muted;
  }

  /** 소리를 낼 수 있는 상태(컨텍스트가 만들어져 실제로 돌고 있음)인지 */
  get running(): boolean {
    return this.ctx?.state === 'running';
  }

  // ───────────────────────────── 수명 ─────────────────────────────

  /** 사용자 제스처(클릭/탭/키) 안에서 호출해야 브라우저가 소리를 허락한다. 여러 번 불러도 안전 */
  unlock(): void {
    if (!this.ctx) {
      const w = window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext };
      const Ctor = w.AudioContext ?? w.webkitAudioContext;
      if (!Ctor) return;
      try {
        this.ctx = new Ctor({ latencyHint: 'interactive' });
      } catch {
        return;
      }
      this.build(this.ctx);
    }
    if (this.ctx.state !== 'running' && !document.hidden) this.ctx.resume().catch(() => {});
    this.ensureAmbient();
  }

  /** 탭이 가려지면 컨텍스트를 멈춰 배경에서 소리가 새지 않게 (게임도 이때 일시정지된다) */
  setHidden(hidden: boolean): void {
    const ctx = this.ctx;
    if (!ctx || ctx.state === 'closed') return;
    (hidden ? ctx.suspend() : ctx.resume()).catch(() => {});
  }

  setMuted(muted: boolean): void {
    this._muted = muted;
    try {
      localStorage.setItem(STORAGE_KEY, muted ? '1' : '0');
    } catch {
      // 저장소가 막힌 환경(사생활 보호 모드 등): 이번 세션에만 적용
    }
    if (this.ctx && this.master) this.master.gain.setTargetAtTime(muted ? 0 : MASTER, this.ctx.currentTime, 0.03);
  }

  toggleMuted(): boolean {
    this.setMuted(!this._muted);
    return this._muted;
  }

  // ───────────────────────────── 배경음 ─────────────────────────────

  /** 한 판 시작. 아직 잠겨 있으면 unlock() 때 시작된다 */
  startAmbient(): void {
    this.wantAmbient = true;
    this.paused = false;
    this.ensureAmbient();
  }

  stopAmbient(fade = 1): void {
    this.wantAmbient = false;
    this.ambient?.stop(fade);
    this.ambient = null;
    window.clearInterval(this.tickTimer);
    this.tickTimer = 0;
    this.world = null;
  }

  /** 일시정지 중엔 배경을 낮춘다 */
  setPaused(paused: boolean): void {
    this.paused = paused;
    this.ambient?.setDucked(paused);
  }

  // ───────────────────────────── 전투 이벤트 ─────────────────────────────

  /** 매 프레임 시뮬레이션 이벤트를 소리로. 화면 밖 전투는 대부분 무시한다 */
  handleEvents(events: readonly GameEvent[], world: World, view: ViewRect): void {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running' || this._muted) return;
    if (world !== this.world) {
      this.world = world;
      this.capturedAt = [];
    }
    const now = ctx.currentTime;
    const { x0, y0, x1, y1 } = view;
    // 확대해서 볼수록 가까이서 듣는 것처럼 조금 크게
    const close = Math.max(0.75, Math.min(1.25, Math.sqrt(900 / Math.max(1, x1 - x0))));

    // 한 프레임의 이벤트를 종류별로 세고, 소리로 낼 대표 하나를 저수지 표집(reservoir)으로 고른다
    let shots = 0, shotX = 0, shotF = 0;
    let hits = 0, hitX = 0;
    let deaths = 0, deathX = 0, deathEnemy = false;
    let far = 0, farX = 0;
    let spawns = 0, spawnX = 0, spawnPlanet = 0;
    let warps = 0, warpX = 0, farWarps = 0, farWarpX = 0;
    let eliminated = false;
    // 점령은 한 프레임에 여러 개가 겹칠 수 있다: 얻은 것 · 잃은 것 · 남의 것 각각 가장 중요한 하나만 울린다
    let win = -1, winScore = 0, winFromEnemy = false, loss = -1, other = -1;

    for (const e of events) {
      switch (e.type) {
        case 'shot':
          if (e.x1 < x0 || e.x1 > x1 || e.y1 < y0 || e.y1 > y1) break;
          if (e.planet) {
            if (Math.random() * ++hits < 1) hitX = e.x1;
          } else if (Math.random() * ++shots < 1) {
            shotX = e.x1;
            shotF = e.faction;
          }
          break;
        case 'death':
          if (e.x < x0 || e.x > x1 || e.y < y0 || e.y > y1) {
            if (Math.random() * ++far < 1) farX = e.x;
          } else if (Math.random() * ++deaths < 1) {
            deathX = e.x;
            deathEnemy = e.faction !== PLAYER;
          }
          break;
        case 'spawn':
          if (e.faction !== PLAYER || e.x < x0 || e.x > x1 || e.y < y0 || e.y > y1) break;
          if (Math.random() * ++spawns < 1) {
            spawnX = e.x;
            spawnPlanet = e.planetId;
          }
          break;
        case 'warp':
          if (e.x < x0 || e.x > x1 || e.y < y0 || e.y > y1) {
            if (Math.random() * ++farWarps < 1) farWarpX = e.x;
          } else if (Math.random() * ++warps < 1) {
            warpX = e.x;
          }
          break;
        case 'wave':
          if (e.phase === 'warning') this.waveWarning();
          else this.waveStart();
          break;
        case 'capture': {
          this.capturedAt[e.planetId] = world.time;
          const p = world.planets[e.planetId];
          if (e.to === PLAYER) {
            const score = (p.isHome ? 4 : 1) + (e.from !== 0 ? 2 : 0);
            if (score > winScore) {
              win = p.id;
              winScore = score;
              winFromEnemy = e.from !== 0;
            }
          } else if (e.from === PLAYER) {
            if (loss < 0 || p.isHome) loss = p.id;
          } else if (p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y <= y1) {
            other = p.id;
          }
          break;
        }
        case 'eliminated':
          if (e.faction !== PLAYER) eliminated = true;
          break;
      }
    }

    // 밀도: 화면 안 사격/사망의 초당 개수를 0.5초 시간상수로 부드럽게
    const dt = Math.max(1 / 240, Math.min(0.5, now - this.lastCall));
    this.lastCall = now;
    const k = 1 - Math.exp(-dt / 0.5);
    this.shotRate += (shots / dt - this.shotRate) * k;
    this.deathRate += (deaths / dt - this.deathRate) * k;
    this.combatShots += shots + hits;
    const shotDensity = clamp01((this.shotRate - 20) / 180);
    const deathDensity = clamp01((this.deathRate - 4) / 30);

    // 반복 전투음: 종류마다 최소 간격을 두고, 그 사이에 쌓인 이벤트는 대표 하나(+밀도)로 낸다
    if (shots > 0 && now - this.lastShot >= lerp(SHOT_GAP_SPARSE, SHOT_GAP_DENSE, shotDensity)) {
      this.lastShot = now;
      this.play('shot', 0, R.DUR.shot, panOf(shotX, view), true, (v, t) => R.shot(v, t, shotF, shotDensity, close));
    }
    if (hits > 0 && now - this.lastHit >= HIT_GAP) {
      this.lastHit = now;
      const intensity = clamp01(hits / 6);
      this.play('hit', 0, R.DUR.hit, panOf(hitX, view), true, (v, t) => R.planetHit(v, t, intensity, close));
    }
    if (deaths > 0 && now - this.lastDeath >= lerp(DEATH_GAP_SPARSE, DEATH_GAP_DENSE, deathDensity)) {
      this.lastDeath = now;
      this.play('death', 0, R.DUR.death, panOf(deathX, view), true, (v, t) => R.death(v, t, deathEnemy, deathDensity, close));
    } else if (deaths === 0 && far > 0 && now - this.lastFarDeath >= FAR_DEATH_GAP) {
      this.lastFarDeath = now;
      this.play('far', 0, R.DUR.far, panOf(farX, view), true, R.farDeath);
    }
    if (spawns > 0 && now - this.lastSpawn >= SPAWN_GAP) {
      this.lastSpawn = now;
      const size = world.planets[spawnPlanet].size;
      this.play('spawn', 0, R.DUR.spawn, panOf(spawnX, view), true, (v, t) => R.spawn(v, t, size));
    }
    if (warps > 0 && now - this.lastWarp >= WARP_GAP) {
      this.lastWarp = now;
      this.play('warp', 0, R.DUR.warp, panOf(warpX, view), true, (v, t) => R.warp(v, t, 1));
    } else if (warps === 0 && farWarps > 0 && now - this.lastFarWarp >= FAR_WARP_GAP) {
      this.lastFarWarp = now;
      this.play('warp', 0, R.DUR.warp, panOf(farWarpX, view), true, (v, t) => R.warp(v, t, 0.3));
    }

    if (win >= 0) {
      const p = world.planets[win];
      this.captureWin(panOf(p.x, view), winFromEnemy, p.isHome);
    }
    if (loss >= 0) {
      const p = world.planets[loss];
      this.captureLoss(panOf(p.x, view), p.isHome);
    }
    if (other >= 0 && win < 0 && loss < 0 && now - this.lastOtherCapture >= OTHER_CAPTURE_GAP) {
      this.lastOtherCapture = now;
      this.play('capture-ai', 1, R.DUR.captureOther, panOf(world.planets[other].x, view), false, (v, t) => R.captureOther(v, t, close));
    }
    if (eliminated) this.triumph();
    this.checkAlarm(world, view, now);
  }

  /** 아군 행성이 강하 공격을 받는 중이면 짧은 경보 (전체에서 6초에 한 번) */
  private checkAlarm(world: World, view: ViewRect, now: number): void {
    const since = now - this.lastAlarm;
    if (since < HOME_ALARM_GAP) return;
    let target = -1;
    for (const p of world.planets) {
      if (p.owner !== PLAYER || p.lastAssaultBy === PLAYER || world.time - p.lastAssaultAt >= 0.3) continue;
      if (world.time - (this.capturedAt[p.id] ?? -Infinity) < CAPTURE_GRACE) continue;
      // 고립 잔당 한두 기의 찔러보기에는 울리지 않는다: 강하 병력이 어느 정도 되거나 방어막이 절반 아래일 때만
      if (p.presence[p.lastAssaultBy] < ALARM_MIN_ATTACKERS && p.defense > p.maxDefense * 0.5) continue;
      if (target < 0 || (p.isHome && !world.planets[target].isHome)) target = p.id;
    }
    if (target < 0) return;
    const p = world.planets[target];
    if (since < ALARM_GAP && !(p.isHome && !this.lastAlarmHome)) return;
    this.lastAlarm = now;
    this.lastAlarmHome = p.isHome;
    // 지금 보고 있는 행성이면 눈으로도 보이니 조금 작게, 화면 밖이면 방향(좌우)으로 알려준다
    const visible = p.x >= view.x0 && p.x <= view.x1 && p.y >= view.y0 && p.y <= view.y1;
    this.alarm(p.isHome, visible ? 0.65 : 1, panOf(p.x, view));
  }

  // ───────────────────────────── UI · 명령 · 결과 ─────────────────────────────

  /** UI 확인음. select 는 n(선택 수)이 클수록 높게, toggle 은 n>0 이면 올라가고 0 이면 내려간다 */
  ui(kind: UiSound, n = 1): void {
    this.play(kind, 1, R.DUR.ui, 0, false, (v, t) => R.ui(v, t, kind, n));
  }

  /** 명령 확인음 (move 이동 · assault 돌파 · surround 포위 · join 합류 · line 횡대 · return 귀환) */
  order(kind: OrderSound): void {
    this.play(`order-${kind}`, 1, R.DUR.order, 0, false, (v, t) => R.order(v, t, kind));
  }

  /** 결과 음악 */
  stinger(kind: StingerKind): void {
    if (this.play(kind, 2, R.DUR.stinger, 0, false, (v, t) => R.stinger(v, t, kind))) this.duck(0.3, 3);
  }

  // ───────────────────────────── 알림 ─────────────────────────────

  private waveWarning(): void {
    if (this.play('wave-warning', 2, R.DUR.waveWarning, 0, false, R.waveWarning)) this.duck(0.5, 1.9);
  }

  private waveStart(): void {
    if (this.play('wave-start', 2, R.DUR.waveStart, 0, false, R.waveStart)) this.duck(0.4, 2);
  }

  private alarm(home: boolean, level: number, pan: number): void {
    if (this.play('alarm', 2, R.DUR.alarm, pan, false, (v, t) => R.alarm(v, t, home, level))) this.duck(0.45, 0.6);
  }

  private captureWin(pan: number, fromEnemy: boolean, home: boolean): void {
    if (this.play('capture-win', 2, R.DUR.captureWin, pan * 0.5, false, (v, t) => R.captureWin(v, t, fromEnemy, home))) this.duck(0.5, 0.5);
  }

  private captureLoss(pan: number, home: boolean): void {
    if (this.play('capture-loss', 2, R.DUR.captureLoss, pan * 0.5, false, (v, t) => R.captureLoss(v, t, home))) this.duck(0.5, 0.7);
  }

  private triumph(): void {
    if (this.play('eliminated', 2, R.DUR.triumph, 0, false, R.triumph)) this.duck(0.6, 1);
  }

  // ───────────────────────────── 내부 ─────────────────────────────

  private build(ctx: AudioContext): void {
    // 리미터: 빽빽한 전투에서 소리가 겹쳐도 클리핑(찢어지는 소리)이 나지 않게 마지막에 눌러 준다
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -10;
    limiter.knee.value = 8;
    limiter.ratio.value = 12;
    limiter.attack.value = 0.003;
    limiter.release.value = 0.25;
    this.master = ctx.createGain();
    this.master.gain.value = this._muted ? 0 : MASTER;
    limiter.connect(this.master).connect(ctx.destination);
    this.fx = ctx.createGain();
    this.fx.gain.value = BUS_GAIN;
    this.fx.connect(limiter);
    this.key = ctx.createGain();
    this.key.gain.value = BUS_GAIN;
    this.key.connect(limiter);
    this.noise = makeNoise(ctx);
    // 구형 iOS 는 제스처 안에서 실제로 무언가를 재생해야 잠금이 풀린다
    const s = ctx.createBufferSource();
    s.buffer = ctx.createBuffer(1, 1, ctx.sampleRate);
    s.connect(ctx.destination);
    s.start(0);
  }

  private ensureAmbient(): void {
    const ctx = this.ctx;
    if (!this.wantAmbient || this.ambient || !ctx || !this.master || !this.noise) return;
    // 배경음은 리미터를 거치지 않는다: 전투음 때문에 배경이 '펌핑'되며 출렁이지 않도록
    this.ambient = new Ambient(ctx, this.master, this.noise);
    if (this.paused) this.ambient.setDucked(true);
    this.combat = 0;
    this.combatShots = 0;
    this.tickAt = performance.now();
    window.clearInterval(this.tickTimer);
    this.tickTimer = window.setInterval(() => this.tickAmbient(), 250);
  }

  /** 화면 안 사격량(초당)을 2초 시간상수로 부드럽게 → 긴장 레이어 */
  private tickAmbient(): void {
    const now = performance.now();
    const dt = Math.max(0.05, (now - this.tickAt) / 1000);
    this.tickAt = now;
    const rate = this.combatShots / dt;
    this.combatShots = 0;
    this.combat += (rate - this.combat) * (1 - Math.exp(-dt / 2));
    this.ambient?.setIntensity(1 - Math.exp(-this.combat / 70));
  }

  /**
   * 소리 하나를 시작할 자리가 있으면 Voice 를 만들어 draw 로 그려 넣고 재생한다 (낮은 우선순위부터 버린다).
   * fx = 반복 전투음 버스(덕킹 대상), 아니면 UI · 알림 버스. dur 은 동시 보이스 수를 셀 때 쓰는 최대 길이.
   */
  private play(kind: string, prio: Priority, dur: number, pan: number, fx: boolean, draw: (v: Voice, t: number) => void): boolean {
    const ctx = this.ctx;
    const bus = fx ? this.fx : this.key;
    // 멈춘 컨텍스트에 예약하면 시계가 서 있어 재개되는 순간 한꺼번에 터진다: 돌고 있을 때만
    if (!ctx || !bus || !this.noise || ctx.state !== 'running' || this._muted) return false;
    const now = ctx.currentTime;
    let n = 0;
    for (const end of this.ends) if (end > now) this.ends[n++] = end;
    this.ends.length = n;
    if (n >= (prio === 0 ? LOW_VOICES : prio === 1 ? MAX_VOICES : HARD_VOICES)) {
      this.stats.dropped++;
      return false;
    }
    this.ends.push(now + LOOKAHEAD + dur);
    this.stats.started++;
    this.stats.byKind[kind] = (this.stats.byKind[kind] ?? 0) + 1;
    if (n + 1 > this.stats.maxActive) this.stats.maxActive = n + 1;
    const v = new Voice(ctx, bus, pan, this.noise);
    draw(v, now + LOOKAHEAD);
    v.done();
    return true;
  }

  /** 중요한 소리가 묻히지 않게 반복 전투음 버스를 잠깐 낮춘다 (사이드체인 덕킹) */
  private duck(depth: number, holdFor: number): void {
    const ctx = this.ctx;
    if (!ctx || !this.fx) return;
    const g = this.fx.gain;
    const t = ctx.currentTime;
    g.cancelScheduledValues(t);
    g.setTargetAtTime(BUS_GAIN * (1 - depth), t, 0.02);
    g.setTargetAtTime(BUS_GAIN, t + holdFor, 0.3);
  }
}

/** 화면 안 x 위치 → 스테레오 위치. 끝까지 보내면 어색하므로 ±0.6 까지만 */
function panOf(x: number, view: ViewRect): number {
  const w = view.x1 - view.x0;
  if (w <= 0) return 0;
  return Math.max(-1, Math.min(1, ((x - view.x0) / w) * 2 - 1)) * 0.6;
}

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
const lerp = (a: number, b: number, k: number) => a + (b - a) * k;

function readMuted(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

/** 앱 전체가 공유하는 하나의 사운드 시스템 */
export const sfx = new Sfx();
