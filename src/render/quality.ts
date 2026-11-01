// 그래픽 품질 단계 (high / medium / low) 와 실제 프레임 시간으로 단계를 고르는 관리자.
// DOM 을 모르는 순수 모듈이라 테스트에서 시간을 흘려 가며 그대로 검사한다.
//
// 단계를 자주 오가면(깜빡임) 오히려 거슬리므로 낮출 때는 빠르게(2초), 올릴 때는 느리게(8초~) 판단하고,
// 올렸다가 곧 다시 낮추게 되면 다음 올리기를 두 배씩 더 오래 참는다.

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
/** 평균의 시간 상수 (ms): 1초쯤의 흐름을 본다 */
const AVG_TAU_MS = 1000;
/** 평균 프레임 간격이 이보다 길면(약 45fps 미만) 내릴 후보 */
const DOWN_FRAME_MS = 22;
/** 내릴 후보 상태가 이만큼 이어지면 한 단계 내린다 (ms) */
const DOWN_HOLD_MS = 2000;
/** 평균 프레임 간격이 이보다 짧고(약 55fps 이상) */
const UP_FRAME_MS = 18;
/** 그리기 자체도 이보다 싸야(여유가 있어야) 올릴 후보. 프레임이 vsync 에 묶여 있으면 간격만으로는 여유를 모른다 */
const UP_RENDER_MS = 6;
/** 올릴 후보 상태가 이만큼 이어져야 한 단계 올린다 (ms). 깜빡일 때마다 두 배, 최대 UP_HOLD_MAX_MS */
const UP_HOLD_MS = 8000;
const UP_HOLD_MAX_MS = 64000;
/** 올린 뒤 이 시간 안에 다시 내리면 '깜빡임'으로 본다 (ms) */
const FLAP_WINDOW_MS = 20000;

export class QualityManager {
  private current: QualityLevel;
  private readonly forced: QualityLevel | null;
  private elapsed = 0;
  private frameAvg = 16.7;
  private renderAvg = 0;
  private primed = false;
  private downFor = 0;
  private upFor = 0;
  private upHold = UP_HOLD_MS;
  /** 마지막으로 단계를 올린 시각 (elapsed 기준) */
  private raisedAt = -Infinity;

  constructor(opts: { forced?: QualityLevel | null; initial?: QualityLevel } = {}) {
    this.forced = opts.forced ?? null;
    this.current = this.forced ?? opts.initial ?? 'high';
  }

  get level(): QualityLevel {
    return this.current;
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
   * 한 프레임을 알린다. frameMs = 직전 프레임과의 실제 간격, renderMs = 이번 그리기에 든 시간.
   * 단계가 바뀌었으면 true.
   */
  sample(frameMs: number, renderMs: number): boolean {
    if (!(frameMs > 0) || frameMs > OUTLIER_MS) return false;
    this.elapsed += frameMs;
    if (this.forced || this.elapsed < WARMUP_MS) return false;
    if (!this.primed) {
      this.primed = true;
      this.frameAvg = frameMs;
      this.renderAvg = renderMs;
    } else {
      const k = 1 - Math.exp(-frameMs / AVG_TAU_MS);
      this.frameAvg += (frameMs - this.frameAvg) * k;
      this.renderAvg += (renderMs - this.renderAvg) * k;
    }

    if (this.frameAvg > DOWN_FRAME_MS) {
      this.downFor += frameMs;
      this.upFor = 0;
    } else if (this.frameAvg < UP_FRAME_MS && this.renderAvg < UP_RENDER_MS) {
      this.upFor += frameMs;
      this.downFor = 0;
    } else {
      this.downFor = 0;
      this.upFor = 0;
    }

    const i = QUALITY_LEVELS.indexOf(this.current);
    if (this.downFor >= DOWN_HOLD_MS && i > 0) {
      // 올린 지 얼마 안 돼 다시 내린다 = 그 단계는 버티지 못한다: 다음 올리기는 더 오래 참는다
      if (this.elapsed - this.raisedAt < FLAP_WINDOW_MS) this.upHold = Math.min(UP_HOLD_MAX_MS, this.upHold * 2);
      this.change(QUALITY_LEVELS[i - 1]);
      return true;
    }
    if (this.upFor >= this.upHold && i < QUALITY_LEVELS.length - 1) {
      this.raisedAt = this.elapsed;
      this.change(QUALITY_LEVELS[i + 1]);
      return true;
    }
    return false;
  }

  private change(to: QualityLevel): void {
    this.current = to;
    this.downFor = 0;
    this.upFor = 0;
    // 새 단계의 비용으로 다시 재야 하므로 평균을 다음 표본에서 새로 시작한다
    this.primed = false;
  }
}
