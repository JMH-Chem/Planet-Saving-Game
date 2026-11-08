// 그래픽 품질 단계 (high / medium / low) 와 실제 프레임 시간으로 단계를 고르는 관리자.
// DOM 을 모르는 순수 모듈이라 테스트에서 시간을 흘려 가며 그대로 검사한다.
//
// 단계를 자주 오가면(깜빡임) 오히려 거슬리므로 낮출 때는 빠르게(2초), 올릴 때는 느리게(8초~) 판단하고,
// 올렸다가 곧 다시 낮추게 되면 다음 올리기를 두 배씩 더 오래 참는다.
// 프레임 간격만으로는 느린 까닭이 우리 그리기인지 모른다 (30Hz 로 묶인 화면 · 절전 모드 · 대화창 합성 · 다른 탭).
// 그래서 단계를 바꾸는 것은 '시험'이다: 바꾸기 전 평균 간격을 기억해 두고 3초 뒤 다시 재서,
// 내렸는데 빨라지지 않았거나 올렸더니 느려졌으면 되돌린다.


export type QualityLevel = 'low' | 'medium' | 'high';

export const QUALITY_LEVELS: readonly QualityLevel[] = ['low', 'medium', 'high'];

export interface QualitySettings {
  /** 발광(bloom) 버퍼 해상도 (CSS px 대비). 0 = 끔 */
  bloomScale: number;
  /** 발광 흐림 단계 수 (반씩 줄여 가며 흐린다. 단계마다 캔버스 사이 복사가 두 번 늘어난다) */
  bloomLevels: number;
  /**
   * 영토: true = 흐린 장을 부드럽게 늘려 땅을 옅게 칠하고 전선을 긋는다.
   * false = 흐리지 않은 장으로 전선만 긋는다 (땅 칠하기는 맵 대부분을 덮는 반투명 그림 한 장이라 약한 GPU 에서 비싸다.
   * 땅은 미니맵에 그대로 칠해진다)
   */
  territoryFill: boolean;
  /** 입자 수 배율 */
  particles: number;
  /** 행성 부가 연출: 도시 불빛 · 따로 흐르는 구름 · 대기 산란 · 피해 연기 */
  planetExtras: boolean;
  /** 대량 격추 충격파 */
  heavyDeaths: boolean;
  /** 행성이 자전으로 이만큼(화면 px) 밀릴 때마다 캐시를 다시 그린다. 크면 덜 매끄럽게 돌고 덜 자주 그린다 */
  planetSpinStep: number;
}

export const QUALITY: Record<QualityLevel, QualitySettings> = {
  high: { bloomScale: 1 / 4, bloomLevels: 2, territoryFill: true, particles: 1, planetExtras: true, heavyDeaths: true, planetSpinStep: 0.6 },
  // 발광 해상도를 절반으로, 흐림 한 단계 덜
  medium: { bloomScale: 1 / 8, bloomLevels: 1, territoryFill: true, particles: 0.75, planetExtras: true, heavyDeaths: true, planetSpinStep: 0.8 },
  low: { bloomScale: 0, bloomLevels: 0, territoryFill: false, particles: 0.5, planetExtras: false, heavyDeaths: false, planetSpinStep: 1.2 },
};

/** ?quality=low|medium|high 로 단계를 고정한다 (측정 · 문제 재현용). 없거나 모르는 값이면 null = 자동 */
export function parseQualityParam(search: string): QualityLevel | null {
  const v = new URLSearchParams(search).get('quality');
  return v === 'low' || v === 'medium' || v === 'high' ? v : null;
}


/** 이보다 긴 프레임 간격은 탭 전환 · 일시 멈춤 · 디버거 같은 일회성이라 평균에 넣지 않는다 (ms) */
const OUTLIER_MS = 250;
/** 시작 직후(행성 텍스처 굽기 등) 이 시간 동안은 판단하지 않는다 (ms) */
const WARMUP_MS = 2000;
/** 일시정지 · 대화창에서 돌아온 직후 이 시간 동안도 재지 않는다 (ms): 대화창이 닫히는 순간의 레이아웃 · 합성이 평균에 섞이지 않게 */
const RESUME_MS = 500;
/** 평균의 시간 상수 (ms): 1초쯤의 흐름을 본다 */
const AVG_TAU_MS = 1000;
/** 평균 프레임 간격이 이보다 길면(약 45fps 미만) 내릴 후보 */
const DOWN_FRAME_MS = 22;
/** 내릴 후보 상태가 이만큼 이어지면 한 단계 내려 본다 (ms) */
const DOWN_HOLD_MS = 2000;
/** 평균 프레임 간격이 이보다 짧고(약 55fps 이상) */
const UP_FRAME_MS = 18;
/** 그리기 자체도 이보다 싸야(여유가 있어야) 올릴 후보. 프레임이 vsync 에 묶여 있으면 간격만으로는 여유를 모른다 */
const UP_RENDER_MS = 6;
/**
 * 간격이 UP_FRAME_MS 밑으로 못 내려가도(30Hz 로 묶인 화면) 그리기가 프레임의 이 몫보다 작으면 올릴 후보.
 * 올려 보고 느려지면 되돌리므로, 앞서 '하'로 떨어진 기기도 여유만 있으면 다시 올라온다
 */
const UP_RENDER_SHARE = 0.25;
/** 올릴 후보 상태가 이만큼 이어져야 한 단계 올려 본다 (ms). 올린 단계를 버티지 못할 때마다 두 배, 최대 UP_HOLD_MAX_MS */
const UP_HOLD_MS = 8000;
const UP_HOLD_MAX_MS = 240000;
/** 올린 뒤 이 시간 안에 다시 내려서 빨라지면 '깜빡임'으로 본다 (ms) */
const FLAP_WINDOW_MS = 20000;
/** 단계를 바꿔 본 뒤: 처음 이만큼은 버리고(버퍼를 새로 잡는 프레임 등) 다음 이만큼의 평균 간격을 바꾸기 전과 견준다 (ms) */
const PROBE_SETTLE_MS = 1000;
const PROBE_MEASURE_MS = 2000;
/** 내려 본 단계는 프레임 간격이 이만큼(10%) 넘게 짧아져야 남긴다 */
const PROBE_GAIN = 0.9;
/** 올려 본 단계는 프레임 간격이 이만큼(10%) 넘게 길어지면 되돌린다 (UP_FRAME_MS 안이면 그대로 둔다: 120Hz 화면) */
const PROBE_LOSS = 1.1;
/** 내려도 빨라지지 않았으면 이만큼은 다시 내려 보지 않는다 (ms). 또 헛되면 두 배씩, 최대 DOWN_RETRY_MAX_MS */
const DOWN_RETRY_MS = 60000;
const DOWN_RETRY_MAX_MS = 480000;
/** 그동안이라도 프레임 간격이 그때보다 이만큼 길어지면(전투가 커짐 등) 다시 내려 본다 */
const DOWN_WORSE = 1.25;

/** 바꿔 보는 중인 단계: 어디서 왔고, 바꾸기 전 평균 간격이 얼마였나 */
interface Probe {
  from: QualityLevel;
  /** -1 = 내려 봄, 1 = 올려 봄 */
  dir: -1 | 1;
  before: number;
  /** 올린 지 얼마 안 돼 내려 본 것인가 (내린 보람이 있으면 다음 올리기를 더 오래 참는다) */
  flap: boolean;
  /** 바꾼 뒤 흐른 시간과, 그중 재는 구간의 시간 · 프레임 수 (ms) */
  t: number;
  time: number;
  frames: number;
}

export class QualityManager {
  private current: QualityLevel;
  private readonly forced: QualityLevel | null;
  /** 판단에 넣은 시간의 합 (ms). 일시정지 · 대화창 동안은 흐르지 않는다 */
  private elapsed = 0;
  /** 아직 재지 않고 넘길 시간 (ms): 시작 직후와 다시 재기 시작한 직후 */
  private warmup = WARMUP_MS;
  private frameAvg = 16.7;
  private renderAvg = 0;
  private primed = false;
  /** 내릴(올릴) 후보 상태가 이어진 시간과 그동안의 프레임 수. 나누면 그 구간의 평균 간격 */
  private downFor = 0;
  private downFrames = 0;
  private upFor = 0;
  private upFrames = 0;
  private upHold = UP_HOLD_MS;
  /** 마지막으로 단계를 올린 시각 (elapsed 기준) */
  private raisedAt = -Infinity;
  private probe: Probe | null = null;
  /** 지금 단계에서 내려 봐야 빨라지지 않는다고 본 때의 프레임 간격과, 그 판단을 믿는 기한 (elapsed 기준) */
  private noDownFrame = Infinity;
  private noDownUntil = -Infinity;
  private downRetry = DOWN_RETRY_MS;
  /** 직전 frame() 의 시각 (ms). null = 직전 프레임은 재지 않았다 */
  private lastAt: number | null = null;

  constructor(opts: { forced?: QualityLevel | null; initial?: QualityLevel } = {}) {
    this.forced = opts.forced ?? null;
    this.current = this.forced ?? opts.initial ?? 'high';
  }

  get level(): QualityLevel {
    return this.current;
  }

  /** 바꿔 보는 중이면 바꾸기 전 단계, 아니면 지금 단계. 다음 판(렌더러)에 물려줄 값 */
  get settled(): QualityLevel {
    return this.probe?.from ?? this.current;
  }

  get settings(): QualitySettings {
    return QUALITY[this.current];
  }

  /** 고정(?quality=)되어 있으면 자동으로 바꾸지 않는다 */
  get isForced(): boolean {
    return this.forced !== null;
  }

  /** 지금의 평균 프레임 간격 · 그리기 시간 (ms, 확인용) */
  get averages(): { frame: number; render: number } {
    return { frame: this.frameAvg, render: this.renderAvg };
  }

  /**
   * 렌더러가 매 프레임 부른다. now = 이번 프레임 시작 시각, renderMs = 직전 그리기에 든 시간 (ms),
   * live = 지금 실제로 진행 중인 판인가 (일시정지 · 도움말 · 나가기 확인 · 결과 화면이면 false).
   * live 가 아닌 프레임은 대화창 합성처럼 판 밖의 비용이 섞이므로 재지 않고, 다시 live 가 되면 평균을 새로 시작한다.
   * 단계가 바뀌었으면 true.
   */
  frame(now: number, renderMs: number, live: boolean): boolean {
    const last = this.lastAt;
    this.lastAt = live ? now : null;
    if (!live) return false;
    if (last === null) {
      this.resume();
      return false;
    }
    return this.sample(now - last, renderMs);
  }

  /**
   * 재지 않던 동안(일시정지 · 대화창) 뒤에 다시 잴 때: 그 전 평균 대신 새 표본부터 다시 재고,
   * 바꿔 보던 단계가 있으면 그 재기도 처음부터 다시 한다 (frame() 이 알아서 부른다)
   */
  resume(): void {
    this.warmup = Math.max(this.warmup, RESUME_MS);
    this.primed = false;
    this.downFor = this.downFrames = this.upFor = this.upFrames = 0;
    if (this.probe) this.probe.t = this.probe.time = this.probe.frames = 0;
  }

  /**
   * 한 프레임을 알린다. frameMs = 직전 프레임과의 실제 간격, renderMs = 이번 그리기에 든 시간.
   * 단계가 바뀌었으면 true.
   */
  sample(frameMs: number, renderMs: number): boolean {
    if (this.forced || !(frameMs > 0) || frameMs > OUTLIER_MS) return false;
    if (this.warmup > 0) {
      this.warmup -= frameMs;
      return false;
    }
    this.elapsed += frameMs;
    if (!this.primed) {
      this.primed = true;
      this.frameAvg = frameMs;
      this.renderAvg = renderMs;
    } else {
      const k = 1 - Math.exp(-frameMs / AVG_TAU_MS);
      this.frameAvg += (frameMs - this.frameAvg) * k;
      this.renderAvg += (renderMs - this.renderAvg) * k;
    }
    if (this.probe) return this.checkProbe(frameMs);

    const cheap = this.renderAvg < UP_RENDER_MS;
    // 30Hz 로 묶인 화면은 간격이 UP_FRAME_MS 밑으로 못 내려간다: 그리기가 프레임의 작은 몫이면 그것도 여유로 본다
    const roomy = cheap && (this.frameAvg < UP_FRAME_MS || this.renderAvg < this.frameAvg * UP_RENDER_SHARE);
    if (this.frameAvg > DOWN_FRAME_MS) {
      this.downFor += frameMs;
      this.downFrames++;
    } else {
      this.downFor = this.downFrames = 0;
    }
    if (roomy) {
      this.upFor += frameMs;
      this.upFrames++;
    } else {
      this.upFor = this.upFrames = 0;
    }

    const i = QUALITY_LEVELS.indexOf(this.current);
    if (this.downFor >= DOWN_HOLD_MS && i > 0) {
      const mean = this.downFor / this.downFrames;
      // 지난번에 내려 봐도 소용없던 때보다 뚜렷이 느려지지 않았으면 내려 보지 않고 2초씩 새로 잰다
      if (this.elapsed >= this.noDownUntil || mean > this.noDownFrame * DOWN_WORSE) {
        this.tryLevel(-1, mean);
        return true;
      }
      this.downFor = this.downFrames = 0;
    }
    if (this.upFor >= this.upHold && i < QUALITY_LEVELS.length - 1) {
      this.raisedAt = this.elapsed;
      this.tryLevel(1, this.upFor / this.upFrames);
      return true;
    }
    return false;
  }

  /** 한 단계 바꿔 보고, 바꾸기 전 평균 간격(before)과 나중에 견준다 */
  private tryLevel(dir: -1 | 1, before: number): void {
    const from = this.current;
    const flap = dir < 0 && this.elapsed - this.raisedAt < FLAP_WINDOW_MS;
    this.change(QUALITY_LEVELS[QUALITY_LEVELS.indexOf(from) + dir]);
    this.probe = { from, dir, before, flap, t: 0, time: 0, frames: 0 };
  }

  private checkProbe(frameMs: number): boolean {
    const p = this.probe!;
    p.t += frameMs;
    if (p.t > PROBE_SETTLE_MS) {
      p.time += frameMs;
      p.frames++;
    }
    if (p.t < PROBE_SETTLE_MS + PROBE_MEASURE_MS) return false;
    this.probe = null;
    const after = p.time / p.frames;
    if (p.dir < 0) {
      if (after < p.before * PROBE_GAIN) {
        // 내린 보람이 있다. 올린 지 얼마 안 돼서였으면 그 단계는 버티지 못한다: 다음 올리기는 더 오래 참는다
        if (p.flap) this.upHold = Math.min(UP_HOLD_MAX_MS, this.upHold * 2);
        return false;
      }
      // 내려도 빨라지지 않았다 = 30Hz 로 묶인 화면이거나 병목이 우리 그리기 밖(DOM 합성 등)이다: 되돌리고 한동안 내려 보지 않는다
      this.change(p.from);
      this.noDown(Math.max(p.before, after));
      this.downRetry = Math.min(DOWN_RETRY_MAX_MS, this.downRetry * 2);
      return true;
    }
    if (after > Math.max(p.before * PROBE_LOSS, UP_FRAME_MS)) {
      // 올리니 느려졌다: 되돌리고 다음 올리기는 더 오래 참는다
      this.upHold = Math.min(UP_HOLD_MAX_MS, this.upHold * 2);
      this.change(p.from);
      return true;
    }
    // 올려도 그대로다 = 여기서 다시 내려 봐야 빨라지지 않는다
    this.noDown(Math.max(p.before, after));
    return false;
  }

  private noDown(frame: number): void {
    this.noDownFrame = frame;
    this.noDownUntil = this.elapsed + this.downRetry;
  }

  private change(to: QualityLevel): void {
    this.current = to;
    this.downFor = this.downFrames = this.upFor = this.upFrames = 0;
    // 새 단계의 비용으로 다시 재야 하므로 평균을 다음 표본에서 새로 시작한다
    this.primed = false;
    // '내려 봐야 소용없다'는 판단은 그때 단계에 대한 것이다
    this.noDownUntil = -Infinity;
  }
}
