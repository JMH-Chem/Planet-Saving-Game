import type { Camera } from './camera';
import { drawSprite, glowSprite, makeCanvas, mulberry32, withAlpha } from './sprites';

// 배경: 그라디언트 + 성운 + 비네트(화면 크기가 바뀔 때만 한 장으로 구움) + 시차가 다른 별 3겹 + 반짝이는 큰 별.
// 게임 화면이 먼저 읽혀야 하므로 전체적으로 어둡고 차분하게 유지한다.

interface StarLayer {
  /** 카메라 이동 대비 움직이는 비율 (작을수록 멀다) */
  parallax: number;
  /** x, y 쌍 (타일 좌표) */
  pos: Float32Array;
  /** 밝기 단계별로 묶어서 한 번에 채운다 */
  bucket: Uint8Array;
  size: number;
}

interface Twinkle {
  x: number;
  y: number;
  phase: number;
  speed: number;
  size: number;
  color: string;
}

/** 별 타일 한 변 (CSS px). 화면보다 작으면 반복이 눈에 띄므로 넉넉하게 */
const TILE = 1024;
/** 성운 캔버스를 화면보다 이만큼 크게 구워 두고 아주 느리게 미끄러뜨린다 */
const NEBULA_MARGIN = 60;
const STAR_SHADES = ['rgba(150,170,220,0.28)', 'rgba(190,205,240,0.45)', 'rgba(225,235,255,0.7)', 'rgba(255,255,255,0.95)'];

export class Background {
  /** 그라디언트 + 성운 + 비네트를 한 장에 구운 바탕 (매 프레임 화면 전체를 한 번만 덮는다) */
  private nebula: HTMLCanvasElement | null = null;
  private layers: StarLayer[];
  private twinkles: Twinkle[];
  private width = 1;
  private height = 1;
  private readonly seed = (Math.random() * 1e9) | 0;

  constructor() {
    const rnd = mulberry32(this.seed);
    const make = (count: number, parallax: number, size: number, bright: number): StarLayer => {
      const pos = new Float32Array(count * 2);
      const bucket = new Uint8Array(count);
      for (let i = 0; i < count; i++) {
        pos[i * 2] = rnd() * TILE;
        pos[i * 2 + 1] = rnd() * TILE;
        // 대부분 어둡고 가끔 밝은 별
        const b = Math.pow(rnd(), 2.2) * bright;
        bucket[i] = Math.min(STAR_SHADES.length - 1, Math.floor(b * STAR_SHADES.length));
      }
      return { parallax, pos, bucket, size };
    };
    this.layers = [make(260, 0.03, 1, 0.55), make(150, 0.08, 1.2, 0.85), make(60, 0.16, 1.6, 1)];
    const tints = ['#cfe3ff', '#ffe7c2', '#d9ccff', '#ffffff'];
    this.twinkles = Array.from({ length: 14 }, () => ({
      x: rnd() * TILE,
      y: rnd() * TILE,
      phase: rnd() * Math.PI * 2,
      speed: 0.6 + rnd() * 1.6,
      size: 1.6 + rnd() * 2.2,
      color: tints[Math.floor(rnd() * tints.length)],
    }));
  }

  resize(width: number, height: number): void {
    if (this.nebula && width === this.width && height === this.height) return;
    this.width = width;
    this.height = height;
    this.nebula = this.bakeNebula(width, height);
  }

  /** 화면 좌표계(CSS px)에서 호출. reduced = 움직임 줄이기(반짝임 정지) */
  draw(ctx: CanvasRenderingContext2D, cam: Camera, worldW: number, worldH: number, clock: number, reduced: boolean): void {
    const W = this.width, H = this.height;
    // 성운: 월드 안에서의 카메라 위치 비율로만 움직여서 어디로 가도 가장자리가 드러나지 않는다
    const nx = Math.max(-1, Math.min(1, cam.x / worldW - 0.5)) * NEBULA_MARGIN;
    const ny = Math.max(-1, Math.min(1, cam.y / worldH - 0.5)) * NEBULA_MARGIN;
    // 정수 픽셀에 맞춰 찍어야 보간 없이 그대로 복사된다 (가장 싼 전체 화면 그리기)
    if (this.nebula) ctx.drawImage(this.nebula, Math.round(-NEBULA_MARGIN - nx), Math.round(-NEBULA_MARGIN - ny), W + NEBULA_MARGIN * 2, H + NEBULA_MARGIN * 2);

    const sx = cam.x * cam.zoom, sy = cam.y * cam.zoom;
    for (const layer of this.layers) {
      const ox = mod(sx * layer.parallax, TILE);
      const oy = mod(sy * layer.parallax, TILE);
      const s = layer.size;
      for (let b = 0; b < STAR_SHADES.length; b++) {
        ctx.beginPath();
        let any = false;
        for (let i = 0; i < layer.bucket.length; i++) {
          if (layer.bucket[i] !== b) continue;
          const x0 = mod(layer.pos[i * 2] - ox, TILE);
          const y0 = mod(layer.pos[i * 2 + 1] - oy, TILE);
          for (let x = x0; x < W; x += TILE) {
            for (let y = y0; y < H; y += TILE) ctx.rect(x, y, s, s);
          }
          any = true;
        }
        if (any) {
          ctx.fillStyle = STAR_SHADES[b];
          ctx.fill();
        }
      }
    }

    // 반짝이는 큰 별: 중간 깊이의 시차
    ctx.globalCompositeOperation = 'lighter';
    const ox = mod(sx * 0.06, TILE), oy = mod(sy * 0.06, TILE);
    for (const t of this.twinkles) {
      const a = reduced ? 0.55 : 0.35 + 0.65 * Math.pow(0.5 + 0.5 * Math.sin(clock * t.speed + t.phase), 3);
      const x0 = mod(t.x - ox, TILE), y0 = mod(t.y - oy, TILE);
      for (let x = x0; x < W + t.size; x += TILE) {
        for (let y = y0; y < H + t.size; y += TILE) {
          ctx.globalAlpha = a;
          const r = t.size * 2.2;
          drawSprite(ctx, glowSprite(t.color), x, y, r);
          // 십자 빛줄기
          ctx.globalAlpha = a * 0.3;
          ctx.fillStyle = t.color;
          ctx.fillRect(x - t.size * 2.4, y - 0.4, t.size * 4.8, 0.8);
          ctx.fillRect(x - 0.4, y - t.size * 2.4, 0.8, t.size * 4.8);
        }
      }
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }

  // ───────────────────────────── 굽기 ─────────────────────────────

  private bakeNebula(width: number, height: number): HTMLCanvasElement {
    const W = width + NEBULA_MARGIN * 2;
    const H = height + NEBULA_MARGIN * 2;
    const c = makeCanvas(W, H);
    const g = c.getContext('2d')!;
    const rnd = mulberry32(this.seed ^ 0x51f15e);

    const base = g.createRadialGradient(W * 0.32, H * 0.22, 0, W * 0.5, H * 0.5, Math.max(W, H) * 0.95);
    base.addColorStop(0, '#121a35');
    base.addColorStop(0.55, '#0a0d1d');
    base.addColorStop(1, '#04050b');

    // 성운 2~3 덩어리: 굽은 경로를 따라 부드러운 원을 겹쳐 구름 모양을 만든다
    const palettes = [
      ['#3b2a86', '#6a3fb5'],
      ['#123f6b', '#1f7aa0'],
      ['#5a1f56', '#a1336f'],
      ['#183d4f', '#2a8a86'],
    ];
    const count = 2 + (rnd() < 0.5 ? 1 : 0);
    const diag = Math.hypot(W, H);
    for (let n = 0; n < count; n++) {
      const [deep, bright] = palettes[Math.floor(rnd() * palettes.length)];
      let x = W * (0.15 + rnd() * 0.7);
      let y = H * (0.15 + rnd() * 0.7);
      let dir = rnd() * Math.PI * 2;
      const blobs = 26 + Math.floor(rnd() * 14);
      const scale = diag * (0.07 + rnd() * 0.05);
      g.globalCompositeOperation = 'lighter';
      for (let i = 0; i < blobs; i++) {
        dir += (rnd() - 0.5) * 0.9;
        x += Math.cos(dir) * scale * 0.35;
        y += Math.sin(dir) * scale * 0.35;
        const r = scale * (0.4 + rnd() * 0.9);
        const col = rnd() < 0.3 ? bright : deep;
        const a = 0.05 + rnd() * 0.07;
        const grad = g.createRadialGradient(x, y, 0, x, y, r);
        grad.addColorStop(0, withAlpha(col, a));
        grad.addColorStop(0.5, withAlpha(col, a * 0.5));
        grad.addColorStop(1, withAlpha(col, 0));
        g.fillStyle = grad;
        g.fillRect(x - r, y - r, r * 2, r * 2);
      }
      // 먼지 띠: 성운 안쪽을 군데군데 파내서 결이 생기게 한다
      g.globalCompositeOperation = 'destination-out';
      for (let i = 0; i < 18; i++) {
        const r = scale * (0.15 + rnd() * 0.35);
        const px = x + (rnd() - 0.5) * scale * 4;
        const py = y + (rnd() - 0.5) * scale * 4;
        const grad = g.createRadialGradient(px, py, 0, px, py, r);
        grad.addColorStop(0, 'rgba(0,0,0,0.25)');
        grad.addColorStop(1, 'rgba(0,0,0,0)');
        g.fillStyle = grad;
        g.fillRect(px - r, py - r, r * 2, r * 2);
      }
    }
    // 성운은 투명한 캔버스에 그렸으니 밑바탕 그라디언트를 뒤에 깐다 (파낸 자리는 바탕색이 보인다)
    g.globalCompositeOperation = 'destination-over';
    g.fillStyle = base;
    g.fillRect(0, 0, W, H);
    g.globalCompositeOperation = 'source-over';

    // 아주 옅은 잔별 먼지 (구워 두는 쪽이 싸다)
    for (let i = 0; i < (W * H) / 1800; i++) {
      g.fillStyle = `rgba(200,215,255,${0.04 + rnd() * 0.08})`;
      g.fillRect(rnd() * W, rnd() * H, 1, 1);
    }

    // 비네트: 화면 가장자리를 살짝 눌러 시선을 가운데로 모은다 (월드 위가 아니라 바탕에 구워서 공짜로)
    const vg = g.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.35, W / 2, H / 2, Math.hypot(W, H) * 0.55);
    vg.addColorStop(0, 'rgba(1,2,6,0)');
    vg.addColorStop(0.6, 'rgba(1,2,6,0.25)');
    vg.addColorStop(1, 'rgba(1,2,6,0.6)');
    g.fillStyle = vg;
    g.fillRect(0, 0, W, H);
    return c;
  }
}

function mod(a: number, m: number): number {
  return ((a % m) + m) % m;
}
