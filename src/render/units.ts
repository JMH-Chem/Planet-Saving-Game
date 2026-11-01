import { CONFIG } from '../config';
import { PLAYER } from '../sim/types';
import type { World } from '../sim/world';
import type { Bloom } from './bloom';
import { inView, type Effects, type ViewRect } from './effects';
import { drawSprite, mixHex, softSprite, SpriteSheet } from './sprites';

// 병력: 확대하면 진행 방향을 향한 화살촉 모양 함선, 축소하면 점.
// 함선은 진영 색마다 64 방향으로 미리 돌려 구운 스프라이트에서 찍는다.
// 다각형 1500개를 매 프레임 채우는 것보다 싸고, 그림(그라디언트 · 조종석 · 테두리)도 더 공들일 수 있다.
//
// 체력이 깎인 병력은 어둡게, 한 발 남은 병력은 꺼질 듯 깜빡인다 (전투에서 어느 쪽이 버티는지 눈으로 읽히게).
// 밝기 단계마다 한 번에 몰아 그려서 globalAlpha 를 병력마다 바꾸지 않는다.

/** 이 배율 이상이면 함선 모양으로 그린다 (화면에서 대략 5px 이상) */
const SHIP_ZOOM = 0.85;
/** 함선 반 길이 (월드 단위). 밀집 대형 간격(5.5)과 겹치지 않을 크기 */
const SHIP = 2.9;
/** 회전 속도 (초당 비율). 궤도를 도는 병력이 덜덜 떨리지 않게 부드럽게 돈다 */
const TURN_RATE = 14;
const ISOLATED_TINT = '#ff3b3b';

const ANGLES = 64;
/** 시트 한 칸 (1px 여백 포함). 최대 확대 × 레티나에서도 크게 뭉개지지 않는 크기 */
const CELL = 46;
const COLS = 32;
/** 칸 안에서 함선 반 길이 (px) */
const CELL_SHIP = 15;

/** 체력 단계별 밝기: 멀쩡 · 한 번 맞음 · 두 번 맞음 (마지막 단계는 깜빡임) */
const HP_ALPHA = [1, 0.84, 0.64];
/** 체력 비율 → 단계 0(멀쩡) ~ 3(한 발 남음) */
function hpLevel(hp: number): number {
  const f = hp / CONFIG.unit.hp;
  return f > 0.99 ? 0 : f > 0.6 ? 1 : f > 0.35 ? 2 : 3;
}

/** 함선 외곽 (반 길이 1 기준): 앞코 → 오른 날개 → 꽁무니 홈 → 왼 날개 */
const HULL: [number, number][] = [
  [1.15, 0],
  [-0.85, 0.8],
  [-0.35, 0],
  [-0.85, -0.8],
];

function traceHull(g: CanvasRenderingContext2D, s: number): void {
  g.beginPath();
  HULL.forEach(([x, y], i) => (i === 0 ? g.moveTo(x * s, y * s) : g.lineTo(x * s, y * s)));
  g.closePath();
}

/** body = 본체, selected = 본체 + 선택 테두리(흰색)를 한 장에 (선택된 병력도 한 번만 찍는다) */
type ShipKind = 'body' | 'selected';

/**
 * 함선 스프라이트: 진영 색 · 고립 색 · 선택 테두리마다 64 방향 회전 프레임을 한 시트에 모은다.
 * 모든 함선이 같은 텍스처에서 나오므로 GPU 에서는 진영이 섞여 있어도 한 번에 그려진다.
 */
class ShipSprites {
  private sheets: SpriteSheet[] = [];
  private frames = new Map<string, { sheet: SpriteSheet; first: number }>();

  get(color: string, kind: ShipKind) {
    const key = kind + color;
    let f = this.frames.get(key);
    if (f) return f;
    let sheet = this.sheets[this.sheets.length - 1];
    let first = sheet ? sheet.reserve(ANGLES) : -1;
    if (first < 0) {
      // 12 가지(진영 + 고립 색 + 선택)면 충분하지만, 넘치면 시트를 하나 더 만든다
      sheet = new SpriteSheet(CELL, COLS, 24);
      this.sheets.push(sheet);
      first = sheet.reserve(ANGLES);
    }
    for (let i = 0; i < ANGLES; i++) sheet.paintAt(first + i, (g, size) => paintShip(g, size, (i / ANGLES) * Math.PI * 2, color, kind));
    f = { sheet, first };
    this.frames.set(key, f);
    return f;
  }
}

/** 앞코가 밝고 꽁무니가 어두운 그라디언트 + 밝은 조종석 + 어두운 테두리로 작아도 또렷하게 */
function paintShip(g: CanvasRenderingContext2D, size: number, angle: number, color: string, kind: ShipKind): void {
  const s = CELL_SHIP;
  g.translate(size / 2, size / 2);
  g.rotate(angle);
  traceHull(g, s);
  g.lineJoin = 'round';
  const grad = g.createLinearGradient(-s, 0, s * 1.15, 0);
  grad.addColorStop(0, mixHex(color, '#000000', 0.25));
  grad.addColorStop(0.55, color);
  grad.addColorStop(1, mixHex(color, '#ffffff', 0.3));
  g.fillStyle = grad;
  g.fill();
  g.lineWidth = 1.4;
  g.strokeStyle = mixHex(color, '#0a0d18', 0.55);
  g.stroke();
  // 조종석
  g.beginPath();
  g.moveTo(s * 0.72, 0);
  g.lineTo(-s * 0.05, s * 0.22);
  g.lineTo(-s * 0.05, -s * 0.22);
  g.closePath();
  g.fillStyle = mixHex(color, '#ffffff', 0.55);
  g.fill();
  if (kind === 'selected') {
    traceHull(g, s);
    g.lineWidth = 3.2;
    g.strokeStyle = 'rgba(240,252,255,0.95)';
    g.stroke();
  }
}

const shipSprites = new ShipSprites();

const F_SELECTED = 1;
const F_ISOLATED = 2;
/** 비트 2~3: 깜빡임 무리 (id % 3), 비트 4~5: 체력 단계 */
const groupOf = (fl: number) => (fl >> 2) & 3;
const hpOf = (fl: number) => (fl >> 4) & 3;

export interface UnitDrawOptions {
  /** 발광 버퍼 (선택 빛). 꺼져 있으면 null */
  bloom: Bloom | null;
  reduced: boolean;
}

export class UnitLayer {
  /** 유닛 id → 바라보는 방향. 멈춰 선 병력이 0 도로 돌아가지 않도록 기억한다 */
  private heading = new Map<number, number>();
  private frames = 0;
  // 화면 안 병력의 그리기 정보 (프레임마다 다시 채우는 재사용 배열)
  private cap = 0;
  private vx = new Float32Array(0);
  private vy = new Float32Array(0);
  private va = new Uint8Array(0);
  private vf = new Uint8Array(0);
  private vflags = new Uint8Array(0);

  private ensure(n: number): void {
    if (n <= this.cap) return;
    this.cap = Math.max(n, this.cap * 2, 256);
    this.vx = new Float32Array(this.cap);
    this.vy = new Float32Array(this.cap);
    this.va = new Uint8Array(this.cap);
    this.vf = new Uint8Array(this.cap);
    this.vflags = new Uint8Array(this.cap);
  }

  draw(
    ctx: CanvasRenderingContext2D,
    world: World,
    selection: ReadonlySet<number>,
    alpha: number,
    zoom: number,
    view: ViewRect,
    clock: number,
    dt: number,
    fx: Effects,
    opts: UnitDrawOptions,
  ): void {
    const { bloom, reduced } = opts;
    const ships = zoom >= SHIP_ZOOM;
    const px = 1 / zoom;
    const S = ships ? Math.max(SHIP, 2.5 * px) : Math.max(1.9 * px, 2.8);
    const turn = Math.min(1, dt * TURN_RATE);
    const twoPi = Math.PI * 2;
    const smokeChance = reduced ? 0 : dt * 0.5;
    this.ensure(world.units.length);

    const trails: (Path2D | undefined)[] = [];
    let n = 0;
    let selN = 0;
    let anyIsolated = false;
    let anyHurt = false;

    for (const u of world.units) {
      const x = u.px + (u.x - u.px) * alpha;
      const y = u.py + (u.y - u.py) * alpha;
      const dx = u.x - u.px, dy = u.y - u.py;
      const sp2 = dx * dx + dy * dy;

      let h = this.heading.get(u.id);
      if (sp2 > 1e-4) {
        const target = Math.atan2(dy, dx);
        if (h === undefined) h = target;
        else {
          let d = target - h;
          d -= Math.round(d / twoPi) * twoPi;
          h += d * turn;
        }
        this.heading.set(u.id, h);
      } else if (h === undefined) {
        // 막 생산된 병력: 궤도 진행 방향(접선)을 본다
        const p = u.planet >= 0 ? world.planets[u.planet] : null;
        h = p ? Math.atan2(u.y - p.y, u.x - p.x) + Math.PI / 2 : 0;
        this.heading.set(u.id, h);
      }

      if (!inView(view, x, y, 10)) continue;
      // 깜빡임 무리는 id 로 고정 (화면 안 순서로 나누면 매 프레임 무리가 바뀌어 지저분해진다)
      let flags = (u.id % 3) << 2;
      if (selection.has(u.id)) {
        flags |= F_SELECTED;
        selN++;
      }
      if (u.isolated) {
        flags |= F_ISOLATED;
        anyIsolated = true;
        if (Math.random() < smokeChance) fx.smoke(x, y, 3.2);
      } else {
        const lv = hpLevel(u.hp);
        flags |= lv << 4;
        if (lv > 0) anyHurt = true;
      }
      this.vx[n] = x;
      this.vy[n] = y;
      this.va[n] = ((Math.round((h / twoPi) * ANGLES) % ANGLES) + ANGLES) % ANGLES;
      this.vf[n] = u.faction;
      this.vflags[n] = flags;
      n++;

      // 엔진 꼬리: 이동 중인 병력만 (궤도를 천천히 도는 병력까지 그리면 비용만 크고 화면이 지저분하다)
      if (sp2 > 0.8 && zoom >= 0.55) {
        const c = Math.cos(h), s = Math.sin(h);
        const back = ships ? S * 0.35 : S;
        const len = Math.min(9, Math.sqrt(sp2) * (ships ? 4.2 : 3.5));
        const t = trails[u.faction] ?? (trails[u.faction] = new Path2D());
        t.moveTo(x - c * back, y - s * back);
        t.lineTo(x - c * (back + len), y - s * (back + len));
      }
    }

    // 엔진 꼬리 (가산 합성: 겹치면 더 밝다)
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineCap = 'butt';
    const bg = bloom?.g ?? null;
    trails.forEach((t, f) => {
      if (!t) return;
      const color = world.factions[f].color;
      ctx.globalAlpha = 0.5;
      ctx.strokeStyle = mixHex(color, '#ffffff', 0.6);
      ctx.lineWidth = ships ? S * 0.45 : Math.max(1.1 * px, 0.7);
      ctx.stroke(t);
    });

    // 선택 빛 (너무 많으면 생략: 전체 선택 시 화면이 하얗게 뜨는 것 방지)
    if (selN > 0 && selN < 600) {
      const color = world.factions[PLAYER].color;
      if (bg && bloom) {
        // 발광이 켜져 있으면 발광 버퍼에 점 하나씩 (흐리면 부대 전체가 은은하게 빛난다). 스프라이트 수백 장보다 싸다
        const r = S * 1.1;
        const path = new Path2D();
        for (let i = 0; i < n; i++) {
          if (!(this.vflags[i] & F_SELECTED)) continue;
          path.rect(this.vx[i] - r, this.vy[i] - r, r * 2, r * 2);
          bloom.mark(this.vx[i], this.vy[i], r);
        }
        bg.globalAlpha = selN > 250 ? 0.12 : 0.22;
        bg.fillStyle = color;
        bg.fill(path);
      } else {
        const glow = softSprite(color);
        const r = S * (ships ? 2.6 : 2.4);
        ctx.globalAlpha = selN > 250 ? 0.18 : 0.3;
        for (let i = 0; i < n; i++) {
          if (this.vflags[i] & F_SELECTED) drawSprite(ctx, glow, this.vx[i], this.vy[i], r);
        }
      }
    }
    if (bg) bg.globalAlpha = 1;
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';

    if (ships) this.drawShips(ctx, world, n, clock, reduced, S, anyHurt, anyIsolated);
    else this.drawDots(ctx, world, n, clock, reduced, S, px, selN);

    // 죽은 병력의 방향 기록 정리 (가끔 한 번)
    if (++this.frames % 90 === 0 && this.heading.size > world.units.length) {
      const next = new Map<number, number>();
      for (const u of world.units) {
        const h = this.heading.get(u.id);
        if (h !== undefined) next.set(u.id, h);
      }
      this.heading = next;
    }
  }

  /** 함선: 체력 단계마다 한 번에 몰아 찍는다 (선택된 병력은 테두리까지 구운 스프라이트 한 장) */
  private drawShips(ctx: CanvasRenderingContext2D, world: World, n: number, clock: number, reduced: boolean, S: number, anyHurt: boolean, anyIsolated: boolean): void {
    // 시트 한 칸이 월드에서 차지하는 크기
    const d = ((CELL - 2) * S) / CELL_SHIP;
    const half = d / 2;
    const factions = world.factions;
    const body = factions.map((f) => shipSprites.get(f.color, 'body'));
    const sel = shipSprites.get(factions[PLAYER].color, 'selected');
    const stamp = (i: number) => {
      const fr = this.vflags[i] & F_SELECTED && this.vf[i] === PLAYER ? sel : body[this.vf[i]];
      const k = fr.first + this.va[i];
      ctx.drawImage(fr.sheet.canvas, (k % COLS) * CELL + 1, ((k / COLS) | 0) * CELL + 1, CELL - 2, CELL - 2, this.vx[i] - half, this.vy[i] - half, d, d);
    };
    // 단계(pass): 0~2 = 체력 단계 (고정 밝기), 3~5 = 한 발 남은 병력의 깜빡임 무리 0~2
    const passes = anyHurt ? 6 : 1;
    for (let pass = 0; pass < passes; pass++) {
      const lv = Math.min(3, pass);
      const group = pass - 3;
      ctx.globalAlpha = lv < 3 ? HP_ALPHA[lv] : criticalAlpha(clock, group, reduced);
      for (let i = 0; i < n; i++) {
        const fl = this.vflags[i];
        if (fl & F_ISOLATED || hpOf(fl) !== lv || (lv === 3 && groupOf(fl) !== group)) continue;
        stamp(i);
      }
    }
    ctx.globalAlpha = 1;
    if (anyIsolated) this.drawIsolated(ctx, world, n, clock, reduced, d);
  }

  /**
   * 축소 화면: 몇 px 짜리 점은 축에 맞춘 사각형 두 개(팔각형에 가까운 모양)로 진영 · 밝기 단계마다 한 번에 칠한다.
   * 화면에서는 원과 구별되지 않고, 점 하나하나를 그리는 것보다 훨씬 싸다.
   */
  private drawDots(
    ctx: CanvasRenderingContext2D,
    world: World,
    n: number,
    clock: number,
    reduced: boolean,
    S: number,
    px: number,
    selN: number,
  ): void {
    const factions = world.factions;
    const a = S, b = S * 0.55;
    // 칠하기 묶음: 0~2 체력 단계, 3~5 한 발 남은 병력의 깜빡임 무리, 6~8 고립 병력의 깜빡임 무리
    const KINDS = 9;
    const paths: (Path2D | undefined)[] = [];
    for (let i = 0; i < n; i++) {
      const fl = this.vflags[i];
      const lv = hpOf(fl);
      const kind = fl & F_ISOLATED ? 6 + groupOf(fl) : lv < 3 ? lv : 3 + groupOf(fl);
      const key = this.vf[i] * KINDS + kind;
      const p = paths[key] ?? (paths[key] = new Path2D());
      const x = this.vx[i], y = this.vy[i];
      p.rect(x - a, y - b, a * 2, b * 2);
      p.rect(x - b, y - a, b * 2, a * 2);
    }
    paths.forEach((p, key) => {
      if (!p) return;
      const f = Math.floor(key / KINDS), kind = key % KINDS;
      if (kind < 3) ctx.globalAlpha = HP_ALPHA[kind];
      else if (kind < 6) ctx.globalAlpha = criticalAlpha(clock, kind - 3, reduced);
      else ctx.globalAlpha = isolatedAlpha(clock, kind - 6, reduced);
      ctx.fillStyle = kind < 6 ? factions[f].color : tint(factions[f].color);
      ctx.fill(p);
    });
    ctx.globalAlpha = 1;
    if (selN > 0) {
      ctx.beginPath();
      const sr = S + Math.max(1.2 * px, 1.2);
      for (let i = 0; i < n; i++) {
        if (!(this.vflags[i] & F_SELECTED)) continue;
        ctx.moveTo(this.vx[i] + sr, this.vy[i]);
        ctx.arc(this.vx[i], this.vy[i], sr, 0, Math.PI * 2);
      }
      ctx.lineWidth = Math.max(1 * px, 0.8);
      ctx.strokeStyle = 'rgba(235,250,255,0.9)';
      ctx.stroke();
    }
  }

  /** 고립 병력: 붉게 물들고 세 무리가 서로 다른 박자로 깜빡인다 */
  private drawIsolated(ctx: CanvasRenderingContext2D, world: World, n: number, clock: number, reduced: boolean, d: number): void {
    const half = d / 2;
    for (let i = 0; i < n; i++) {
      const fl = this.vflags[i];
      if (!(fl & F_ISOLATED)) continue;
      const fr = shipSprites.get(tint(world.factions[this.vf[i]].color), fl & F_SELECTED ? 'selected' : 'body');
      const k = fr.first + this.va[i];
      ctx.globalAlpha = isolatedAlpha(clock, groupOf(fl), reduced);
      ctx.drawImage(fr.sheet.canvas, (k % COLS) * CELL + 1, ((k / COLS) | 0) * CELL + 1, CELL - 2, CELL - 2, this.vx[i] - half, this.vy[i] - half, d, d);
    }
    ctx.globalAlpha = 1;
  }
}

function isolatedAlpha(clock: number, group: number, reduced: boolean): number {
  if (reduced) return 0.6;
  const wave = Math.sin(clock * 13 + group * 2.1);
  return wave > 0.2 ? 0.95 : 0.3 + 0.2 * (wave + 1);
}

/** 한 발 남은 병력: 고장 난 전등처럼 불규칙하게 꺼졌다 켜진다 (움직임 줄이기면 어둡게 고정) */
function criticalAlpha(clock: number, group: number, reduced: boolean): number {
  if (reduced) return 0.45;
  const w = Math.sin(clock * 17 + group * 2.4) + Math.sin(clock * 6.3 + group * 1.3);
  return w > 0.6 ? 0.75 : 0.32;
}

/** 고립 병력 색: 진영 색을 붉게 물들인다 */
const tint = (color: string) => mixHex(color, ISOLATED_TINT, 0.5);
