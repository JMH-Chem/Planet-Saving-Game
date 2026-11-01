import type { World } from '../sim/world';
import type { ViewRect } from './effects';
import { makeCanvas, parseHex } from './sprites';
import { TerritoryField, type Rgb } from './territory';

// 영토 장을 화면에 까는 층. 계산(territory.ts)은 초당 4번만 하고, 결과는 칸 하나 = 1px 인 작은 캔버스에 올린다.
// 땅을 칠하는 품질(중 · 상)에서는 그 작은 캔버스를 4배 캔버스로 한 번 더 부드럽게 늘려 두어, 매 프레임 화면으로
// 늘릴 때 칸 모양(마름모 무늬)이 드러나지 않게 한다. 매 프레임 비용은 이미 늘려 둔 그림 한 장을 찍는 것뿐.
//
// 그 한 장도 화면 전체를 덮으면 약한 GPU(소프트웨어 래스터에서는 특히)에서 몇 ms 가 든다. 그래서 장을 4×4 칸 묶음(타일)으로
// 나눠 빈 타일은 건너뛰고, 한 줄에서 이어진 타일끼리만 한 번에 찍는다.
//
// 진영 땅이 맞닿은 전선은 칸 그림이 아니라 가는 선(계산할 때 찾아 둔 선분)으로 그 위에 긋는다: 칸 그림으로는 칸 하나
// (24 단위)보다 가늘게 그릴 수 없어 흐릿한 띠가 되기 때문이다.

/** 다시 계산하는 간격(초) */
const UPDATE_INTERVAL = 0.25;
/** 부드럽게 늘린 중간 캔버스의 배율 */
const SMOOTH_SCALE = 4;
/** 화면에 깔 때의 전체 불투명도 (행성 · 병력이 먼저 읽혀야 하므로 옅게) */
const ALPHA = 0.34;
/** 관전(메뉴 배경)은 더 차분하게 */
const SPECTATOR_ALPHA = 0.22;
/** 전선 밝기 단계 수 (세기별로 묶어 한 번에 긋는다) */
const FRONT_BUCKETS = 3;
const FRONT_COLOR = '#e4efff';
/** 타일 한 변 (칸 수, 96 월드 단위) */
const TILE = 4;
/** 이보다 옅은 칸(전체 불투명도를 곱하면 1.6% 미만: 어두운 바탕에서 보이지 않는다)은 타일을 차지하지 않는다 */
const MIN_TILE_ALPHA = 12;

export class TerritoryLayer {
  private field: TerritoryField | null = null;
  private cells: HTMLCanvasElement | null = null;
  private img: ImageData | null = null;
  private smooth: HTMLCanvasElement | null = null;
  private smoothed = false;
  private since = Infinity;
  private colors: Rgb[] = [];
  private ready = false;
  /** 타일마다 그릴 것이 있는지 (이웃 칸 하나만큼 넓혀서: 늘릴 때 반 칸씩 번지는 빛이 잘리지 않게) */
  private tiles = new Uint8Array(0);
  private tileCols = 0;
  private tileRows = 0;
  /** 전선 선분 (세기 단계별) */
  private fronts: Path2D[] = [];

  /** 미니맵이 바탕에 깔 그림 (칸 = 1px) 과 그 그림이 덮는 월드 크기. 아직 없으면 null */
  get image(): { canvas: HTMLCanvasElement; width: number; height: number } | null {
    const f = this.field;
    if (!this.ready || !this.cells || !f) return null;
    return { canvas: this.cells, width: f.cols * f.cell, height: f.rows * f.cell };
  }

  /**
   * dt = 실제 경과 초. smooth = 땅을 칠할 부드럽게 늘린 그림도 만든다 (땅을 칠하는 품질).
   * 장 자체는 늘 흐린다: 초당 4번의 작은 CPU 계산이고, 흐리지 않으면 병력이 섞인 곳의 전선이 칸 모양으로 들쭉날쭉해진다
   */
  update(world: World, dt: number, smooth: boolean): void {
    this.since += dt;
    if (this.since < UPDATE_INTERVAL && this.smoothed === smooth) return;
    const elapsed = Number.isFinite(this.since) ? this.since : 0;
    this.since = 0;
    if (!this.field) {
      this.field = new TerritoryField(world.width, world.height, world.factions.length);
      this.cells = makeCanvas(this.field.cols, this.field.rows);
      this.img = new ImageData(this.field.cols, this.field.rows);
      this.colors = world.factions.map((f) => parseHex(f.color));
    }
    const f = this.field;
    f.update(world, elapsed, true);
    f.paint(this.img!.data, this.colors);
    this.markTiles(this.img!.data);
    this.buildFronts(f);
    this.cells!.getContext('2d')!.putImageData(this.img!, 0, 0);
    this.smoothed = smooth;
    if (smooth) {
      this.smooth ??= makeCanvas(f.cols * SMOOTH_SCALE, f.rows * SMOOTH_SCALE);
      const g = this.smooth.getContext('2d')!;
      g.clearRect(0, 0, this.smooth.width, this.smooth.height);
      g.imageSmoothingEnabled = true;
      g.imageSmoothingQuality = 'high';
      g.drawImage(this.cells!, 0, 0, this.smooth.width, this.smooth.height);
    }
    this.ready = true;
  }

  private markTiles(px: Uint8ClampedArray): void {
    const f = this.field!;
    const tc = (this.tileCols = Math.ceil(f.cols / TILE));
    const tr = (this.tileRows = Math.ceil(f.rows / TILE));
    if (this.tiles.length !== tc * tr) this.tiles = new Uint8Array(tc * tr);
    this.tiles.fill(0);
    for (let r = 0; r < f.rows; r++) {
      for (let c = 0; c < f.cols; c++) {
        if (px[(r * f.cols + c) * 4 + 3] < MIN_TILE_ALPHA) continue;
        // 이 칸이 걸치는(이웃 한 칸 포함) 타일 모두
        const t0 = Math.floor(Math.max(0, c - 1) / TILE), t1 = Math.floor(Math.min(f.cols - 1, c + 1) / TILE);
        const u0 = Math.floor(Math.max(0, r - 1) / TILE), u1 = Math.floor(Math.min(f.rows - 1, r + 1) / TILE);
        for (let u = u0; u <= u1; u++) for (let t = t0; t <= t1; t++) this.tiles[u * tc + t] = 1;
      }
    }
  }

  /**
   * 선분을 끝점끼리 이어 긴 선(폴리라인)으로 묶는다. 선분마다 따로 그으면 수백 개의 짧은 선 하나하나에 끝 처리가 붙어
   * 약한 GPU 에서 몇 ms 가 든다. 세기 단계가 바뀌는 곳에서는 끊는다
   */
  private buildFronts(f: TerritoryField): void {
    const paths = Array.from({ length: FRONT_BUCKETS }, () => new Path2D());
    const s = f.front;
    const n = f.segments;
    const bucket = (k: number) => Math.min(FRONT_BUCKETS - 1, Math.floor(s[k * 5 + 4] * FRONT_BUCKETS));
    // 끝점 → 그 점에 닿는 선분들 (보간 결과가 같은 변에서 같은 값이라 정확히 일치한다)
    const key = (x: number, y: number) => `${Math.round(x * 64)},${Math.round(y * 64)}`;
    const at = new Map<string, number[]>();
    for (let k = 0; k < n; k++) {
      if (s[k * 5 + 4] < 0.05) continue;
      for (const e of [0, 2]) {
        const kk = key(s[k * 5 + e], s[k * 5 + e + 1]);
        const list = at.get(kk);
        if (list) list.push(k);
        else at.set(kk, [k]);
      }
    }
    const used = new Uint8Array(n);
    for (let k = 0; k < n; k++) {
      if (used[k] || s[k * 5 + 4] < 0.05) continue;
      used[k] = 1;
      const b = bucket(k);
      // 한쪽 끝(x2, y2)으로 따라가며 잇고, 처음 선분의 다른 끝(x1, y1)에서 시작하도록 반대쪽도 이어 붙인다
      const walk = (x: number, y: number): number[] => {
        const pts: number[] = [];
        for (;;) {
          const next = at.get(key(x, y))?.find((j) => !used[j] && bucket(j) === b);
          if (next === undefined) return pts;
          used[next] = 1;
          const o = next * 5;
          const forward = key(s[o], s[o + 1]) === key(x, y);
          x = forward ? s[o + 2] : s[o];
          y = forward ? s[o + 3] : s[o + 1];
          pts.push(x, y);
        }
      };
      const o = k * 5;
      const head = walk(s[o], s[o + 1]);
      const tail = walk(s[o + 2], s[o + 3]);
      const p = paths[b];
      const sx = head.length ? head[head.length - 2] : s[o], sy = head.length ? head[head.length - 1] : s[o + 1];
      p.moveTo(sx, sy);
      for (let i = head.length - 4; i >= 0; i -= 2) p.lineTo(head[i], head[i + 1]);
      if (head.length) p.lineTo(s[o], s[o + 1]);
      p.lineTo(s[o + 2], s[o + 3]);
      for (let i = 0; i < tail.length; i += 2) p.lineTo(tail[i], tail[i + 1]);
    }
    this.fronts = paths;
  }

  /** 월드 좌표계에서 행성 밑에 깐다 (보이는 영역의, 그릴 것이 있는 타일만) + 전선. fill = false 면 전선만 */
  draw(ctx: CanvasRenderingContext2D, view: ViewRect, zoom: number, spectator: boolean, fill: boolean): void {
    const f = this.field;
    if (!this.ready || !f) return;
    if (fill) this.drawFill(ctx, f, view, spectator);

    // 전선: 가는 밝은 선 한 줄 (넓은 빛까지 겹쳐 그으면 선 넓이만큼 비용이 몇 배가 된다)
    const k0 = spectator ? 0.6 : 1;
    ctx.globalCompositeOperation = 'lighter';
    ctx.strokeStyle = FRONT_COLOR;
    ctx.lineWidth = 1.6 / zoom;
    this.fronts.forEach((p, b) => {
      ctx.globalAlpha = 0.45 * ((b + 1) / FRONT_BUCKETS) * k0;
      ctx.stroke(p);
    });
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
  }

  /** 땅 칠하기: 보이는 영역의, 그릴 것이 있는 타일만 (한 줄에서 이어진 타일은 한 번에) */
  private drawFill(ctx: CanvasRenderingContext2D, f: TerritoryField, view: ViewRect, spectator: boolean): void {
    const src = this.smoothed && this.smooth ? this.smooth : this.cells!;
    const k = src.width / f.cols;
    const span = TILE * f.cell;
    const tc = this.tileCols;
    const c0 = Math.max(0, Math.floor(view.x0 / span)), c1 = Math.min(tc - 1, Math.floor(view.x1 / span));
    const r0 = Math.max(0, Math.floor(view.y0 / span)), r1 = Math.min(this.tileRows - 1, Math.floor(view.y1 / span));
    ctx.globalAlpha = spectator ? SPECTATOR_ALPHA : ALPHA;
    ctx.imageSmoothingEnabled = true;
    for (let r = r0; r <= r1; r++) {
      let c = c0;
      while (c <= c1) {
        if (!this.tiles[r * tc + c]) {
          c++;
          continue;
        }
        const start = c;
        while (c <= c1 && this.tiles[r * tc + c]) c++;
        // 칸 단위 원본 영역 (맵 끝 타일은 잘려 있다)
        const cx = start * TILE, cy = r * TILE;
        const cw = Math.min(f.cols, c * TILE) - cx, ch = Math.min(f.rows, (r + 1) * TILE) - cy;
        ctx.drawImage(src, cx * k, cy * k, cw * k, ch * k, cx * f.cell, cy * f.cell, cw * f.cell, ch * f.cell);
      }
    }
    ctx.globalAlpha = 1;
  }
}
