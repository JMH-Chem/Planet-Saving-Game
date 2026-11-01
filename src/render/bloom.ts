import { makeCanvas } from './sprites';

// 발광(bloom): 레이저 · 폭발 · 총구 섬광 · 게이트 · 엔진 꼬리 · 선택 빛처럼 스스로 빛나는 것만 작은 버퍼에 한 번 더 그리고,
// 반씩 줄이며(2×2 평균) 흐린 뒤 다시 키우며 더해 넓게 번지는 빛을 만든다. 마지막에 화면에 가산 합성.
// ctx.filter(blur) 는 Safari 가 지원하지 않으므로 drawImage 축소/확대만 쓴다.
//
// 비용은 거의 전부 '화면에 합성하는 넓이'다 (작은 버퍼끼리의 축소 · 확대는 싸다). 그래서 빛을 그릴 때마다
// 그 자리를 줄(row) 단위로 표시해 두고, 빛이 있는 줄 묶음(띠)에만 합성한다. 전투가 없는 화면에서는 거의 공짜.
//
// 단계 버퍼들은 캔버스 두 장(A: 0 · 2 단계, B: 1 · 3 단계)에 나눠 담아 늘 서로 다른 캔버스끼리 그린다
// (같은 캔버스 안에서 복사하면 브라우저가 통째로 사본을 뜬다). 두 장 다 너무 작지 않게 잡는다:
// 작은 캔버스는 GPU 가 아니라 CPU 에 두는 브라우저가 있어, GPU ↔ CPU 를 오가면 매 프레임 되읽기가 생긴다.

/** 화면 사각형 (CSS px) */
export interface Band {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 빛 표시 줄 높이 (CSS px) */
export const BLOOM_ROW = 16;
/** 단계 캔버스의 최소 변 (px) */
const MIN_ATLAS = 160;
/** 단계 사이 여백 (px): 확대 보간이 옆 단계를 끌어오지 않게 */
const GAP = 2;
/** 확대하며 더할 때 단계별 비중 ([k] = k+1 단계를 k 단계에 더할 때): 넓게 번진 빛일수록 옅게 */
const LEVEL_WEIGHT = [0.8, 0.6, 0.45];

/**
 * 줄마다 빛이 있는 가로 범위(rowMin..rowMax, 없으면 min > max)를 받아, 번지는 폭(pad)만큼 넓힌 뒤
 * 세로로 겹치거나 맞닿는 것끼리 합친 띠 목록. 띠끼리는 겹치지 않는다 (겹치면 그 자리가 두 번 더해져 밝아진다).
 */
export function bloomBands(rowMin: ArrayLike<number>, rowMax: ArrayLike<number>, rowH: number, pad: number, width: number, height: number): Band[] {
  const bands: Band[] = [];
  let cur: { x0: number; y0: number; x1: number; y1: number } | null = null;
  const flush = () => {
    if (!cur) return;
    const x0 = Math.max(0, Math.floor(cur.x0)), y0 = Math.max(0, Math.floor(cur.y0));
    const x1 = Math.min(width, Math.ceil(cur.x1)), y1 = Math.min(height, Math.ceil(cur.y1));
    if (x1 > x0 && y1 > y0) bands.push({ x: x0, y: y0, w: x1 - x0, h: y1 - y0 });
    cur = null;
  };
  for (let r = 0; r < rowMin.length; r++) {
    if (!(rowMin[r] <= rowMax[r])) continue;
    const x0 = rowMin[r] - pad, x1 = rowMax[r] + pad;
    const y0 = r * rowH - pad, y1 = (r + 1) * rowH + pad;
    if (cur && y0 <= cur.y1) {
      cur.x0 = Math.min(cur.x0, x0);
      cur.x1 = Math.max(cur.x1, x1);
      cur.y1 = Math.max(cur.y1, y1);
    } else {
      flush();
      cur = { x0, y0, x1, y1 };
    }
  }
  flush();
  return bands;
}

interface Level {
  g: CanvasRenderingContext2D;
  canvas: HTMLCanvasElement;
  /** 단계 버퍼가 캔버스 안에서 시작하는 y */
  y: number;
  w: number;
  h: number;
}

export class Bloom {
  private a: HTMLCanvasElement | null = null;
  private b: HTMLCanvasElement | null = null;
  private levels: Level[] = [];
  /** 0 단계 버퍼 해상도 (CSS px 대비) */
  private scale = 0;
  private width = 0;
  private height = 0;
  private rowMin = new Float32Array(0);
  private rowMax = new Float32Array(0);
  private any = false;
  // 월드 → 화면(CSS px) 변환: 빛 자리 표시용
  private camX = 0;
  private camY = 0;
  private zoom = 1;
  private ox = 0;
  private oy = 0;
  /** 지난 프레임에 합성한 넓이 비율 (0~1, 확인용) */
  coverage = 0;

  /** 화면 크기 · 품질이 바뀌면 버퍼를 다시 잡는다. scale = 0 이면 끈다 */
  configure(width: number, height: number, scale: number, levels: number): void {
    if (scale <= 0 || levels <= 0) {
      this.levels = [];
      this.scale = 0;
      return;
    }
    if (this.scale === scale && this.width === width && this.height === height && this.levels.length === levels + 1) return;
    this.scale = scale;
    this.width = width;
    this.height = height;
    const sizes: { w: number; h: number }[] = [];
    for (let k = 0; k <= levels; k++) sizes.push({ w: Math.max(2, Math.ceil((width * scale) / 2 ** k)), h: Math.max(2, Math.ceil((height * scale) / 2 ** k)) });
    // 짝수 단계는 A, 홀수 단계는 B 에 세로로 쌓는다
    const stack = (parity: number) => {
      let w = 0, h = 0;
      for (let k = parity; k < sizes.length; k += 2) {
        w = Math.max(w, sizes[k].w);
        h += sizes[k].h + GAP;
      }
      return { w: Math.max(MIN_ATLAS, w), h: Math.max(MIN_ATLAS, h) };
    };
    const sa = stack(0), sb = stack(1);
    this.a = resizeCanvas(this.a, sa.w, sa.h);
    this.b = resizeCanvas(this.b, sb.w, sb.h);
    const ga = this.a.getContext('2d')!, gb = this.b.getContext('2d')!;
    const used = [0, 0];
    this.levels = sizes.map((s, k) => {
      const odd = k % 2;
      const y = used[odd];
      used[odd] += s.h + GAP;
      return { g: odd ? gb : ga, canvas: odd ? this.b! : this.a!, y, w: s.w, h: s.h };
    });
    const rows = Math.ceil(height / BLOOM_ROW) + 1;
    this.rowMin = new Float32Array(rows);
    this.rowMax = new Float32Array(rows);
  }

  get enabled(): boolean {
    return this.levels.length > 1;
  }

  /** 빛을 그릴 0 단계 버퍼 (begin() 이 월드 좌표계 · 가산 합성으로 맞춰 둔다). 켜져 있을 때만 쓴다 */
  get g(): CanvasRenderingContext2D {
    return this.levels[0].g;
  }

  /** 발광 버퍼 1px 의 월드 길이 (선 굵기를 버퍼 픽셀로 맞출 때) */
  get unit(): number {
    return 1 / (this.zoom * this.scale);
  }

  /**
   * 한 프레임의 빛 그리기를 시작한다. 반환하는 컨텍스트는 월드 좌표계(흔들림 포함)로 맞춰져 있다.
   * 꺼져 있으면 null
   */
  begin(camX: number, camY: number, zoom: number, shakeX: number, shakeY: number): CanvasRenderingContext2D | null {
    if (!this.enabled) return null;
    const l0 = this.levels[0];
    const g = l0.g;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalAlpha = 1;
    g.globalCompositeOperation = 'source-over';
    g.clearRect(0, l0.y, l0.w, l0.h);
    this.camX = camX;
    this.camY = camY;
    this.zoom = zoom;
    this.ox = this.width / 2 + shakeX;
    this.oy = this.height / 2 + shakeY;
    const k = zoom * this.scale;
    g.setTransform(k, 0, 0, k, (this.ox - camX * zoom) * this.scale, (this.oy - camY * zoom) * this.scale + l0.y);
    // 빛은 겹칠수록 밝아진다
    g.globalCompositeOperation = 'lighter';
    this.rowMin.fill(Infinity);
    this.rowMax.fill(-Infinity);
    this.any = false;
    return g;
  }

  /** 월드 (x, y) 반경 r 에 빛을 그렸다고 표시한다 (합성할 띠를 고르는 데 쓴다) */
  mark(x: number, y: number, r: number): void {
    const sx = (x - this.camX) * this.zoom + this.ox;
    const sy = (y - this.camY) * this.zoom + this.oy;
    const sr = r * this.zoom;
    if (sx + sr < 0 || sx - sr > this.width || sy + sr < 0 || sy - sr > this.height) return;
    const last = this.rowMin.length - 1;
    const r0 = Math.max(0, Math.floor((sy - sr) / BLOOM_ROW)), r1 = Math.min(last, Math.floor((sy + sr) / BLOOM_ROW));
    for (let row = r0; row <= r1; row++) {
      if (sx - sr < this.rowMin[row]) this.rowMin[row] = sx - sr;
      if (sx + sr > this.rowMax[row]) this.rowMax[row] = sx + sr;
    }
    this.any = true;
  }

  /** 흐리고 main 에 가산 합성한다. main 은 화면 좌표계(CSS px × dpr) */
  end(main: CanvasRenderingContext2D, dpr: number, intensity: number): void {
    this.coverage = 0;
    if (!this.enabled || !this.any || intensity <= 0) return;
    const L = this.levels;
    // 축소: 정확히 절반이면 이중선형 보간 = 2×2 평균
    for (let k = 1; k < L.length; k++) {
      const s = L[k - 1], d = L[k];
      const g = d.g;
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.globalAlpha = 1;
      g.globalCompositeOperation = 'source-over';
      g.clearRect(0, d.y, d.w, d.h);
      g.drawImage(s.canvas, 0, s.y, s.w, s.h, 0, d.y, s.w / 2, s.h / 2);
    }
    // 확대하며 더하기: 가장 흐린 단계부터 한 단계씩 위로 올려 합성할 단계(target)에 모은다.
    // 흐림이 두 단계 이상이면 1 단계(0 단계의 2×2 평균)에, 한 단계뿐이면 0 단계에 모은다.
    // 캔버스 사이 복사마다 그 캔버스의 쌓인 그리기를 내보내야 하므로(가장 비싼 부분) 단계는 적게 둔다
    const target = L.length > 2 ? 1 : 0;
    for (let k = L.length - 1; k > target; k--) {
      const s = L[k], d = L[k - 1];
      const g = d.g;
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.globalCompositeOperation = 'lighter';
      g.globalAlpha = LEVEL_WEIGHT[k - 1] ?? 0.4;
      g.drawImage(s.canvas, 0, s.y, s.w, s.h, 0, d.y, s.w * 2, s.h * 2);
      g.globalAlpha = 1;
      g.globalCompositeOperation = 'source-over';
    }

    // 가장 넓게 번진 단계의 한 칸만큼 띠를 넓힌다
    const spread = 2 ** (L.length - 1) / this.scale;
    const bands = bloomBands(this.rowMin, this.rowMax, BLOOM_ROW, spread * 1.25, this.width, this.height);
    const src = L[target];
    const s = this.scale / 2 ** target;
    main.setTransform(dpr, 0, 0, dpr, 0, 0);
    main.globalCompositeOperation = 'lighter';
    main.globalAlpha = intensity;
    let area = 0;
    for (const b of bands) {
      main.drawImage(src.canvas, b.x * s, src.y + b.y * s, b.w * s, b.h * s, b.x, b.y, b.w, b.h);
      area += b.w * b.h;
    }
    main.globalAlpha = 1;
    main.globalCompositeOperation = 'source-over';
    this.coverage = area / (this.width * this.height);
  }
}

function resizeCanvas(c: HTMLCanvasElement | null, w: number, h: number): HTMLCanvasElement {
  if (!c) return makeCanvas(w, h);
  if (c.width !== w || c.height !== h) {
    c.width = w;
    c.height = h;
  }
  return c;
}
