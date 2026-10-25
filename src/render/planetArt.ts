import type { Planet } from '../sim/types';
import { makeCanvas, mixHex, mulberry32, parseHex, toHex, type Rgb } from './sprites';

// 행성 표면을 행성마다 한 번만 절차적으로 구워 둔다 (행성 id 가 시드라 같은 맵의 같은 행성은 늘 같은 모습).
// 표면 텍스처는 가로로 이어지게(지름의 2배 폭) 만들고, 원 안에서 패턴을 천천히 밀어 자전하는 것처럼 보이게 한다.
// 조명(왼쪽 위 광원의 명암 경계, 가장자리 어둡게)은 돌지 않는 별도 캔버스로 덮는다.

export type PlanetStyle = 'rocky' | 'gas' | 'ocean' | 'ice' | 'desert';

export interface PlanetArt {
  style: PlanetStyle;
  /** 가로로 이어지는 표면 (폭 = 지름 × 2) */
  surface: HTMLCanvasElement;
  /** 텍스처 픽셀 / 월드 단위 */
  scale: number;
  /** 자전 속도 (월드 단위/초) */
  spin: number;
  /** 고정 조명 레이어 (지름 × 지름) */
  shade: HTMLCanvasElement;
}

/** 월드 1 단위당 텍스처 픽셀. 최대 확대(×3.2)에서도 크게 뭉개지지 않는 선 */
const TEX_SCALE = 3;

// ───────────────────────────── 노이즈 ─────────────────────────────

function hash2(x: number, y: number, seed: number): number {
  let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(seed, 1274126177);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** 가로 방향으로 period 칸마다 이어지는 값 노이즈 (텍스처를 끝없이 굴려도 이음매가 없다) */
function valueNoise(x: number, y: number, period: number, seed: number): number {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const x0 = ((xi % period) + period) % period;
  const x1 = (x0 + 1) % period;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const a = hash2(x0, yi, seed), b = hash2(x1, yi, seed);
  const c = hash2(x0, yi + 1, seed), d = hash2(x1, yi + 1, seed);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

/** u ∈ [0,1) (가로, 이어짐), v = 세로 / 가로폭. freq = 가로 한 바퀴의 격자 수 */
function fbm(u: number, v: number, freq: number, octaves: number, seed: number): number {
  let sum = 0, amp = 0.5, norm = 0;
  for (let o = 0; o < octaves; o++) {
    sum += valueNoise(u * freq, v * freq, freq, seed + o * 101) * amp;
    norm += amp;
    amp *= 0.5;
    freq *= 2;
  }
  return sum / norm;
}

/** 색 목록을 0~1 로 매끄럽게 잇는 램프 */
function ramp(stops: Rgb[], t: number, out: Rgb): Rgb {
  const x = Math.max(0, Math.min(0.9999, t)) * (stops.length - 1);
  const i = Math.floor(x), f = x - i;
  const a = stops[i], b = stops[i + 1];
  out.r = a.r + (b.r - a.r) * f;
  out.g = a.g + (b.g - a.g) * f;
  out.b = a.b + (b.b - a.b) * f;
  return out;
}

const pal = (...hex: string[]) => hex.map(parseHex);

// 적 진영 색(빨강 · 주황 · 보라)과 헷갈리지 않도록 표면은 채도를 낮춘 자연색 위주로
const ROCKY = [
  pal('#2b2b2e', '#46464b', '#66676d', '#8a8b90', '#b0b1b5'),
  pal('#2f2a27', '#4d443d', '#6f6358', '#8d8072', '#a89a8a'),
  pal('#232a35', '#38424f', '#55606f', '#76839a', '#9aa7ba'),
  pal('#26302a', '#3c4a3f', '#5b6a5a', '#7e8c78', '#a3ad98'),
];
const GAS = [
  pal('#7a4e33', '#b9825a', '#e3c9a3', '#c99a6c', '#f2e4c9', '#9c6a48'),
  pal('#1d2f73', '#2f56b8', '#5b8ff0', '#3a66c9', '#8fb8ff', '#28479a'),
  pal('#3d3a52', '#5d5a7a', '#8f8cab', '#6f6c8e', '#c4c2d8', '#4e4b68'),
  pal('#1d4d4a', '#2f7a72', '#62b8a6', '#3f8f84', '#a6e0cf', '#26605b'),
];
const ICE = [pal('#5f86b3', '#8fb2d6', '#bcd7ee', '#e3f0fb', '#f7fbff'), pal('#4f7f8f', '#80b3bd', '#b5dde0', '#e2f5f3', '#fafffe')];
const DESERT = [pal('#5e4630', '#8f7048', '#b39465', '#d2b98c', '#e8d8b6'), pal('#4a4136', '#736553', '#9c8b70', '#c2b294', '#e0d5bd')];
const OCEAN = [
  // 지구형: 깊은 바다 → 얕은 바다 / 저지대 → 고지대
  { sea: pal('#071a3d', '#0d2f63', '#1d5fa6', '#3a8fd0'), land: pal('#2f6b34', '#4f8a3b', '#8c8a4e', '#9b7f5f', '#c9c0b4') },
  // 외계형: 청록 바다 + 보랏빛 대지
  { sea: pal('#06282f', '#0b4a52', '#14808a', '#3cbcc0'), land: pal('#4b2f63', '#6f4a86', '#9a6d9f', '#c39ab8', '#e6d3e3') },
];

// ───────────────────────────── 굽기 ─────────────────────────────

function pickStyle(p: Planet, rnd: () => number): PlanetStyle {
  // 모성은 '지켜야 할 행성'답게 바다와 대륙이 있는 행성으로
  if (p.isHome) return 'ocean';
  const r = rnd();
  if (p.size === 'large') return r < 0.6 ? 'gas' : r < 0.85 ? 'ocean' : 'ice';
  if (p.size === 'medium') return r < 0.25 ? 'rocky' : r < 0.5 ? 'gas' : r < 0.7 ? 'ice' : r < 0.85 ? 'desert' : 'ocean';
  return r < 0.42 ? 'rocky' : r < 0.74 ? 'ice' : 'desert';
}

/** 이웃한 id 의 시드가 비슷한 난수열을 내지 않도록 섞는다 */
function mixSeed(n: number): number {
  let h = Math.imul(n + 0x7f4a7c15, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  return (h ^ (h >>> 13)) >>> 0;
}

const pick = <T>(list: readonly T[], rnd: () => number): T => list[Math.floor(rnd() * list.length)];

/**
 * 행성 하나의 표면을 여러 프레임에 나눠 굽는다 (큰 행성은 수십 ms 가 걸려 시작할 때 화면이 멈추므로).
 * 노이즈는 절반 해상도로 계산해 부드럽게 늘리고, 분화구 · 균열 · 폭풍은 원래 해상도로 얹는다.
 */
export class PlanetBaker {
  /** 다 구워지면 채워진다 */
  art: PlanetArt | null = null;
  private readonly rnd: () => number;
  private readonly style: PlanetStyle;
  private readonly D: number;
  /** 노이즈 계산 해상도 (표면의 절반) */
  private readonly nw: number;
  private readonly nh: number;
  private readonly img: ImageData;
  private row = 0;
  private readonly seed: number;
  private readonly rock: Rgb[];
  private readonly gas: Rgb[];
  private readonly ice: Rgb[];
  private readonly desert: Rgb[];
  private readonly ocean: (typeof OCEAN)[number];
  private readonly bandFreq: number;
  private readonly seaLevel: number;

  constructor(private readonly p: Planet) {
    const rnd = (this.rnd = mulberry32(mixSeed(p.id)));
    this.style = pickStyle(p, rnd);
    this.D = Math.max(16, Math.round(p.radius * 2 * TEX_SCALE));
    this.nw = this.D;
    this.nh = Math.ceil(this.D / 2);
    // 한 칸 더: 마지막 열 = 첫 열이라 늘릴 때 가로 이음매에서도 보간이 이어진다
    this.img = new ImageData(this.nw + 1, this.nh);
    this.seed = (rnd() * 1e6) | 0;
    this.rock = pick(ROCKY, rnd);
    this.gas = pick(GAS, rnd);
    this.ice = pick(ICE, rnd);
    this.desert = pick(DESERT, rnd);
    this.ocean = p.isHome && p.owner === 1 ? OCEAN[0] : pick(OCEAN, rnd);
    this.bandFreq = 7 + rnd() * 7;
    this.seaLevel = 0.47 + rnd() * 0.08;
  }

  /** deadline(performance.now 기준)까지 굽는다. 다 구웠으면 true */
  step(deadline: number): boolean {
    if (this.art) return true;
    const { nw, nh } = this;
    const data = this.img.data;
    const c: Rgb = { r: 0, g: 0, b: 0 };
    while (this.row < nh) {
      const y = this.row++;
      for (let x = 0; x < nw; x++) {
        this.sample(x / nw, y / nw, Math.abs(y / nh - 0.5) * 2, y / nh, c);
        const i = (y * (nw + 1) + x) * 4;
        data[i] = c.r;
        data[i + 1] = c.g;
        data[i + 2] = c.b;
        data[i + 3] = 255;
      }
      const first = y * (nw + 1) * 4, last = first + nw * 4;
      for (let k = 0; k < 4; k++) data[last + k] = data[first + k];
      if (performance.now() > deadline && this.row < nh) return false;
    }
    this.art = this.finish();
    return true;
  }

  /** 한 점의 표면 색. u ∈ [0,1) 가로(이어짐), v = 세로 / 가로폭, lat = 적도 0 ~ 극 1, ty = 위 0 ~ 아래 1 */
  private sample(u: number, v: number, lat: number, ty: number, c: Rgb): void {
    const seed = this.seed;
    switch (this.style) {
      case 'rocky': {
        ramp(this.rock, (fbm(u, v, 6, 5, seed) - 0.25) * 1.8, c);
        return;
      }
      case 'gas': {
        // 위도마다 색이 다른 띠 + 가로로 흐르는 난류가 띠 경계를 휘게 한다
        const turb = fbm(u, v * 2.2, 6, 4, seed) - 0.5;
        const band = valueNoise(ty * this.bandFreq + turb * 1.6, 0.5, 1 << 20, seed + 5);
        ramp(this.gas, band * 1.25 - 0.1, c);
        const fine = (fbm(u, v * 5, 20, 2, seed + 7) - 0.5) * 22;
        c.r += fine;
        c.g += fine;
        c.b += fine;
        return;
      }
      case 'ocean': {
        const sea = this.seaLevel;
        const h = fbm(u, v, 5, 6, seed);
        if (h > sea) ramp(this.ocean.land, ((h - sea) / (1 - sea)) * 2.2, c);
        else ramp(this.ocean.sea, Math.pow(h / sea, 3), c);
        // 극관 (경계를 부드럽게: 딱 자르면 확대했을 때 띠처럼 보인다)
        const cap = Math.max(0, Math.min(1, (lat + (fbm(u, v, 10, 3, seed + 3) - 0.5) * 0.3 - 0.8) / 0.12)) * 0.9;
        if (cap > 0) {
          c.r += (235 - c.r) * cap;
          c.g += (243 - c.g) * cap;
          c.b += (250 - c.b) * cap;
        }
        // 구름
        const ca = Math.max(0, Math.min(0.85, (fbm(u + 0.37, v, 7, 5, seed + 11) - 0.56) * 3.4));
        c.r += (245 - c.r) * ca;
        c.g += (248 - c.g) * ca;
        c.b += (255 - c.b) * ca;
        return;
      }
      case 'ice': {
        ramp(this.ice, 0.25 + (fbm(u, v, 5, 5, seed) - 0.3) * 1.6 + lat * 0.25, c);
        return;
      }
      case 'desert': {
        const n = fbm(u, v, 5, 5, seed);
        const dunes = Math.sin((u * 60 + n * 8 + v * 20) * Math.PI) * 0.06;
        ramp(this.desert, (n - 0.2) * 1.6 + dunes, c);
        return;
      }
    }
  }

  private finish(): PlanetArt {
    const { D, style, rnd } = this;
    const W = D * 2, H = D;
    const half = makeCanvas(this.nw + 1, this.nh);
    half.getContext('2d')!.putImageData(this.img, 0, 0);
    const surface = makeCanvas(W, H);
    const g = surface.getContext('2d')!;
    g.imageSmoothingEnabled = true;
    g.imageSmoothingQuality = 'high';
    g.drawImage(half, 0, 0, W + W / this.nw, H);

    // 벡터로 얹는 디테일 (가로 이음매를 넘는 것은 반대쪽에 한 번 더 그린다)
    const wrapDraw = (x: number, r: number, fn: (x: number) => void) => {
      fn(x);
      if (x - r < 0) fn(x + W);
      if (x + r > W) fn(x - W);
    };
    if (style === 'rocky' || style === 'desert' || (style === 'ice' && rnd() < 0.5)) {
      const n = style === 'rocky' ? 14 + Math.floor(rnd() * 10) : 6 + Math.floor(rnd() * 5);
      for (let i = 0; i < n; i++) {
        const r = D * (0.025 + Math.pow(rnd(), 2) * 0.09);
        const cy = r + rnd() * (H - r * 2);
        wrapDraw(rnd() * W, r, (cx) => drawCrater(g, cx, cy, r));
      }
    }
    if (style === 'ice') {
      g.strokeStyle = 'rgba(70,110,160,0.45)';
      g.lineWidth = Math.max(1, D / 110);
      for (let i = 0; i < 9; i++) {
        const pts: number[] = [rnd() * W, rnd() * H];
        let a = rnd() * Math.PI * 2;
        for (let k = 0; k < 7; k++) {
          a += (rnd() - 0.5) * 1.2;
          pts.push(pts[pts.length - 2] + Math.cos(a) * D * 0.06, pts[pts.length - 1] + Math.sin(a) * D * 0.06);
        }
        // 균열이 이음매를 넘어가도 끊기지 않게 양옆에도 그린다
        for (const off of [-W, 0, W]) {
          g.beginPath();
          for (let k = 0; k < pts.length; k += 2) g.lineTo(pts[k] + off, pts[k + 1]);
          g.stroke();
        }
      }
    }
    if (style === 'gas' && rnd() < 0.8) {
      // 큰 폭풍 (대적점)
      const sx = rnd() * W, sy = H * (0.3 + rnd() * 0.4), rx = D * (0.1 + rnd() * 0.06), ry = rx * 0.55;
      const base = mixHex(toHex(this.gas[1]), '#ffffff', 0.15);
      wrapDraw(sx, rx, (x) => {
        const grad = g.createRadialGradient(x, sy, 0, x, sy, rx);
        grad.addColorStop(0, base);
        grad.addColorStop(0.6, mixHex(base, '#000000', 0.25));
        grad.addColorStop(1, 'rgba(0,0,0,0)');
        g.save();
        g.translate(x, sy);
        g.scale(1, ry / rx);
        g.translate(-x, -sy);
        g.fillStyle = grad;
        g.beginPath();
        g.arc(x, sy, rx, 0, Math.PI * 2);
        g.fill();
        g.restore();
      });
    }
    return {
      style,
      surface,
      scale: D / (this.p.radius * 2),
      spin: (style === 'gas' ? 3.2 : 1.8) * (0.7 + rnd() * 0.6) * (rnd() < 0.5 ? 1 : -1),
      shade: bakeShade(D, style),
    };
  }
}

function drawCrater(g: CanvasRenderingContext2D, x: number, y: number, r: number): void {
  // 광원이 왼쪽 위: 분화구 안쪽의 왼쪽 위 벽은 그늘, 오른쪽 아래 벽은 빛을 받는다
  g.fillStyle = 'rgba(0,0,0,0.22)';
  g.beginPath();
  g.arc(x, y, r, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = 'rgba(0,0,0,0.25)';
  g.beginPath();
  g.arc(x - r * 0.15, y - r * 0.15, r * 0.8, 0, Math.PI * 2);
  g.fill();
  g.strokeStyle = 'rgba(255,240,220,0.28)';
  g.lineWidth = Math.max(0.8, r * 0.18);
  g.beginPath();
  g.arc(x, y, r * 0.92, -0.2, Math.PI * 0.75);
  g.stroke();
}

/** 고정 조명: 왼쪽 위 광원의 명암 경계 + 가장자리 어둡게 + 대기 산란 */
function bakeShade(D: number, style: PlanetStyle): HTMLCanvasElement {
  const c = makeCanvas(D, D);
  const g = c.getContext('2d')!;
  const R = D / 2;
  g.beginPath();
  g.arc(R, R, R, 0, Math.PI * 2);
  g.clip();

  // 대기 산란 (가장자리의 옅은 빛) — 뒤에 덮는 어둠이 밤 쪽은 가려 준다
  const hazeColor = style === 'gas' ? '255,236,210' : style === 'ice' ? '210,240,255' : style === 'desert' ? '255,220,180' : '150,200,255';
  const haze = g.createRadialGradient(R, R, R * 0.78, R, R, R);
  haze.addColorStop(0, `rgba(${hazeColor},0)`);
  haze.addColorStop(1, `rgba(${hazeColor},0.38)`);
  g.fillStyle = haze;
  g.fillRect(0, 0, D, D);

  // 명암 경계
  const lx = R - R * 0.48, ly = R - R * 0.52;
  const term = g.createRadialGradient(lx, ly, 0, lx, ly, R * 2.05);
  term.addColorStop(0, 'rgba(0,0,8,0)');
  term.addColorStop(0.38, 'rgba(0,0,8,0.02)');
  term.addColorStop(0.62, 'rgba(0,0,8,0.5)');
  term.addColorStop(0.8, 'rgba(0,0,8,0.86)');
  term.addColorStop(1, 'rgba(0,0,8,0.95)');
  g.fillStyle = term;
  g.fillRect(0, 0, D, D);

  // 가장자리 어둡게 (구체감)
  const limb = g.createRadialGradient(R, R, R * 0.6, R, R, R);
  limb.addColorStop(0, 'rgba(0,0,0,0)');
  limb.addColorStop(1, 'rgba(0,0,0,0.38)');
  g.fillStyle = limb;
  g.fillRect(0, 0, D, D);

  // 은은한 하이라이트
  const spec = g.createRadialGradient(R - R * 0.42, R - R * 0.45, 0, R - R * 0.42, R - R * 0.45, R * 0.75);
  spec.addColorStop(0, 'rgba(255,255,255,0.16)');
  spec.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = spec;
  g.fillRect(0, 0, D, D);
  return c;
}
