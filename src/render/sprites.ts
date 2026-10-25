// 색 계산과 미리 구워 두는 발광 스프라이트.
// 매 프레임 그라디언트를 새로 만들면 수백 개 효과에서 비용이 커지므로, 색마다 한 번만 오프스크린에 그려 두고
// drawImage 로 찍는다 (globalCompositeOperation = 'lighter' 와 함께 쓰면 겹칠수록 밝아지는 네온 느낌).

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

export function parseHex(hex: string): Rgb {
  const n = parseInt(hex.slice(1), 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

export function toHex({ r, g, b }: Rgb): string {
  const c = (v: number) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0');
  return `#${c(r)}${c(g)}${c(b)}`;
}

const mixCache = new Map<string, string>();

/** a → b 로 t 만큼 섞은 색 (#rrggbb). 같은 조합을 매 프레임 다시 계산하지 않도록 기억해 둔다 */
export function mixHex(a: string, b: string, t: number): string {
  const key = a + b + t;
  let s = mixCache.get(key);
  if (!s) {
    const x = parseHex(a), y = parseHex(b);
    s = toHex({ r: x.r + (y.r - x.r) * t, g: x.g + (y.g - x.g) * t, b: x.b + (y.b - x.b) * t });
    if (mixCache.size > 2000) mixCache.clear();
    mixCache.set(key, s);
  }
  return s;
}

const alphaCache = new Map<string, string>();

/** '#rrggbb' + 투명도 → 'rgba(...)'. 프레임마다 같은 문자열을 반복해서 만들지 않도록 캐시한다 */
export function withAlpha(hex: string, a: number): string {
  const q = Math.round(Math.max(0, Math.min(1, a)) * 100);
  const key = hex + q;
  let s = alphaCache.get(key);
  if (!s) {
    const { r, g, b } = parseHex(hex);
    s = `rgba(${r},${g},${b},${q / 100})`;
    if (alphaCache.size > 4000) alphaCache.clear();
    alphaCache.set(key, s);
  }
  return s;
}

export function makeCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.ceil(w));
  c.height = Math.max(1, Math.ceil(h));
  return c;
}

/** 큰 캔버스 한 장을 같은 크기 칸으로 나눈 스프라이트 묶음 위의 한 칸 */
export interface Sprite {
  img: HTMLCanvasElement;
  sx: number;
  sy: number;
  /** 칸 안에서 실제로 쓰는 정사각형 한 변 (px) */
  size: number;
}

/**
 * 스프라이트 시트: 여러 스프라이트를 한 텍스처에 모아 두면 GPU 가 같은 텍스처의 drawImage 를
 * 한 번의 그리기로 묶을 수 있다 (색마다 캔버스를 따로 두면 색이 바뀔 때마다 묶음이 끊긴다).
 * 칸 사이에 1px 여백을 두어 확대 보간 시 옆 칸이 번지지 않게 한다.
 */
export class SpriteSheet {
  readonly canvas: HTMLCanvasElement;
  private g: CanvasRenderingContext2D;
  private map = new Map<string, Sprite>();
  private next = 0;

  constructor(
    readonly cell: number,
    readonly cols: number,
    readonly rows: number,
  ) {
    this.canvas = makeCanvas(cell * cols, cell * rows);
    this.g = this.canvas.getContext('2d')!;
  }

  /** 연속된 칸 count 개를 한 번에 잡는다 (회전 프레임 묶음 등). 자리가 없으면 -1 */
  reserve(count: number): number {
    if (this.next + count > this.cols * this.rows) return -1;
    const first = this.next;
    this.next += count;
    return first;
  }

  /** 칸 번호 → 스프라이트 위치 */
  at(index: number): Sprite {
    const col = index % this.cols, row = Math.floor(index / this.cols);
    return { img: this.canvas, sx: col * this.cell + 1, sy: row * this.cell + 1, size: this.cell - 2 };
  }

  /** key 로 한 번만 그려 두고 재사용. 시트가 가득 차면 따로 캔버스를 만든다 */
  get(key: string, paint: (g: CanvasRenderingContext2D, size: number) => void): Sprite {
    let sp = this.map.get(key);
    if (sp) return sp;
    const index = this.reserve(1);
    const size = this.cell - 2;
    if (index < 0) {
      const c = makeCanvas(size, size);
      paint(c.getContext('2d')!, size);
      sp = { img: c, sx: 0, sy: 0, size };
    } else {
      sp = this.at(index);
      const g = this.g;
      g.save();
      g.beginPath();
      g.rect(sp.sx, sp.sy, size, size);
      g.clip();
      g.translate(sp.sx, sp.sy);
      paint(g, size);
      g.restore();
    }
    this.map.set(key, sp);
    return sp;
  }

  /** 시트의 g 에 직접 그릴 때 (회전 프레임 묶음) */
  paintAt(index: number, paint: (g: CanvasRenderingContext2D, size: number) => void): void {
    const sp = this.at(index);
    const g = this.g;
    g.save();
    g.beginPath();
    g.rect(sp.sx, sp.sy, sp.size, sp.size);
    g.clip();
    g.translate(sp.sx, sp.sy);
    paint(g, sp.size);
    g.restore();
  }
}

/** 중심 (x, y), 반경 r 로 스프라이트를 찍는다 */
export function drawSprite(ctx: CanvasRenderingContext2D, sp: Sprite, x: number, y: number, r: number): void {
  ctx.drawImage(sp.img, sp.sx, sp.sy, sp.size, sp.size, x - r, y - r, r * 2, r * 2);
}

/** 발광 스프라이트를 모아 두는 공용 시트 (64px 칸 × 128) */
let glowSheet: SpriteSheet | null = null;
const sheet = () => (glowSheet ??= new SpriteSheet(64, 16, 8));

/**
 * 중심이 하얗게 달아오른 발광 점 (총구 섬광, 폭발, 착탄). 'lighter' 합성용.
 * 빛은 반경 r 에서 완전히 사라진다 — drawSprite(…, r).
 */
export function glowSprite(color: string): Sprite {
  return sheet().get('g' + color, (g, size) => {
    const h = size / 2;
    const grad = g.createRadialGradient(h, h, 0, h, h, h);
    const hot = mixHex(color, '#ffffff', 0.75);
    grad.addColorStop(0, withAlpha(hot, 1));
    grad.addColorStop(0.1, withAlpha(hot, 0.9));
    grad.addColorStop(0.26, withAlpha(color, 0.6));
    grad.addColorStop(0.5, withAlpha(color, 0.22));
    grad.addColorStop(0.75, withAlpha(color, 0.06));
    grad.addColorStop(1, withAlpha(color, 0));
    g.fillStyle = grad;
    g.fillRect(0, 0, size, size);
  });
}

/** 흰 심 없이 색만 있는 부드러운 빛 덩어리 (선택 표시, 대기 광륜, 연기) */
export function softSprite(color: string): Sprite {
  return sheet().get('s' + color, (g, size) => {
    const h = size / 2;
    const grad = g.createRadialGradient(h, h, 0, h, h, h);
    grad.addColorStop(0, withAlpha(color, 0.9));
    grad.addColorStop(0.35, withAlpha(color, 0.45));
    grad.addColorStop(0.7, withAlpha(color, 0.1));
    grad.addColorStop(1, withAlpha(color, 0));
    g.fillStyle = grad;
    g.fillRect(0, 0, size, size);
  });
}

/** 0~1 결정론적 해시 난수 (행성 텍스처처럼 매번 같은 모양이어야 하는 곳에 쓴다) */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
