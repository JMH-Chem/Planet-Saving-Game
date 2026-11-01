import { describe, expect, it } from 'vitest';
import { planetReach, TERRITORY_CELL, TerritoryField, type TerritoryPlanet, type TerritoryUnit } from '../src/render/territory';

// 영토 장: 칸마다 가장 센 진영이 가진다 · 중립은 아무것도 아니다 · 두 진영 땅이 맞닿은 곳은 전선(선분) · 점령 뒤에는 서서히 바뀐다

const W = 960, H = 480;
const planet = (x: number, y: number, owner: number, garrison = 20): TerritoryPlanet => ({
  x, y, radius: 26, owner, capacity: 50, orbitCount: [garrison, garrison, garrison, garrison],
});
const cellAt = (f: TerritoryField, x: number, y: number) => Math.floor(y / f.cell) * f.cols + Math.floor(x / f.cell);
const colors = [{ r: 0, g: 0, b: 0 }, { r: 79, g: 195, b: 247 }, { r: 255, g: 93, b: 93 }, { r: 255, g: 180, b: 60 }];
/** 전선 선분 목록 [x1, y1, x2, y2, 세기] */
const segments = (f: TerritoryField) => Array.from({ length: f.segments }, (_, k) => Array.from(f.front.slice(k * 5, k * 5 + 5)));

describe('영토 장', () => {
  it('맵을 굵은 칸으로 나눈다 (가장자리 칸 포함)', () => {
    const f = new TerritoryField(W + 5, H, 3);
    expect(f.cell).toBe(TERRITORY_CELL);
    expect(f.cols).toBe(Math.ceil((W + 5) / TERRITORY_CELL));
    expect(f.rows).toBe(H / TERRITORY_CELL);
  });

  it('행성 둘레는 그 주인의 땅, 영향 반경 밖과 중립 행성 둘레는 아무 땅도 아니다', () => {
    const f = new TerritoryField(W, H, 3);
    const mine = planet(200, 240, 1);
    f.update({ planets: [mine, planet(760, 240, 0)], units: [] }, 0, true);
    expect(f.owner[cellAt(f, 200, 240)]).toBe(1);
    expect(f.fill[cellAt(f, 200, 240)]).toBeGreaterThan(0.5);
    expect(f.owner[cellAt(f, 760, 240)]).toBe(0);
    const reach = planetReach(mine.radius, 20);
    expect(f.owner[cellAt(f, 200 + reach + 2 * TERRITORY_CELL, 240)]).toBe(0);
    // 가까울수록 진하다
    expect(f.fill[cellAt(f, 200, 240)]).toBeGreaterThan(f.fill[cellAt(f, 200 + reach * 0.6, 240)]);
  });

  it('두 진영 사이에서는 더 가까운(센) 쪽이 갖고, 영향력이 같아지는 곳에 전선이 이어진다', () => {
    const f = new TerritoryField(W, H, 3);
    f.update({ planets: [planet(360, 240, 1), planet(600, 240, 2)], units: [] }, 0, true);
    expect(f.owner[cellAt(f, 400, 240)]).toBe(1);
    expect(f.owner[cellAt(f, 560, 240)]).toBe(2);
    // 같은 두 행성이면 전선은 정확히 가운데 수직선 (경계가 칸과 칸 사이를 지나도 끊기지 않는다)
    const segs = segments(f);
    expect(segs.length).toBeGreaterThan(3);
    for (const [x1, , x2] of segs) {
      expect(Math.abs(x1 - 480)).toBeLessThan(0.5);
      expect(Math.abs(x2 - 480)).toBeLessThan(0.5);
    }
    // 이어진 선: 한 선분의 끝이 다음 선분의 시작
    const ys = segs.flatMap(([, y1, , y2]) => [y1, y2]).sort((a, b) => a - b);
    expect(ys[0]).toBeLessThan(240);
    expect(ys[ys.length - 1]).toBeGreaterThan(240);
    // 가운데(두 땅이 모두 짙은 곳)가 가장 진하다
    const mid = segs.reduce((best, s) => (Math.abs((s[1] + s[3]) / 2 - 240) < Math.abs((best[1] + best[3]) / 2 - 240) ? s : best));
    expect(mid[4]).toBeGreaterThan(0.6);
  });

  it('행성이 하나뿐이거나 상대가 중립이면 전선이 없다', () => {
    const f = new TerritoryField(W, H, 3);
    f.update({ planets: [planet(360, 240, 1), planet(600, 240, 0)], units: [] }, 0, true);
    expect(f.segments).toBe(0);
  });

  it('세 진영이 만나는 곳에서도 전선이 끊기지 않고 한 점으로 모인다', () => {
    const f = new TerritoryField(W, H, 4);
    f.update({ planets: [planet(380, 160, 1), planet(580, 160, 2), planet(480, 330, 3)], units: [] }, 0, true);
    const segs = segments(f);
    // 끝점마다 다른 선분과 맞닿거나 땅 가장자리에서 끝난다: 선분 끝점의 짝 맞추기
    const key = (x: number, y: number) => `${x.toFixed(3)},${y.toFixed(3)}`;
    const count = new Map<string, number>();
    for (const [x1, y1, x2, y2] of segs) for (const k of [key(x1, y1), key(x2, y2)]) count.set(k, (count.get(k) ?? 0) + 1);
    // 세 갈래 이상 모이는 점이 있다 (세 진영의 교점)
    expect([...count.values()].some((n) => n >= 3)).toBe(true);
  });

  it('궤도 병력이 많은 행성이 더 멀리 미친다 (전선이 약한 쪽으로 밀린다)', () => {
    const front = (g1: number, g2: number) => {
      const f = new TerritoryField(W, H, 3);
      f.update({ planets: [planet(300, 240, 1, g1), planet(660, 240, 2, g2)], units: [] }, 0, true);
      // 두 행성 사이 줄에서 1번 진영이 가진 마지막 칸의 x
      let last = 0;
      for (let x = 300; x <= 660; x += f.cell) if (f.owner[cellAt(f, x, 240)] === 1) last = x;
      return last;
    };
    expect(front(50, 5)).toBeGreaterThan(front(5, 50));
  });

  it('병력이 모여 있는 곳은 그 진영 쪽으로 기운다', () => {
    const units: TerritoryUnit[] = [];
    for (let i = 0; i < 40; i++) units.push({ x: 480 + (i % 5), y: 240 + Math.floor(i / 5), faction: 2 });
    const f = new TerritoryField(W, H, 3);
    f.update({ planets: [planet(300, 240, 1), planet(660, 240, 2)], units: [] }, 0, true);
    const before = f.influence(2, cellAt(f, 480, 240));
    f.update({ planets: [planet(300, 240, 1), planet(660, 240, 2)], units }, 10, true);
    expect(f.influence(2, cellAt(f, 480, 240))).toBeGreaterThan(before);
    expect(f.owner[cellAt(f, 480, 240)]).toBe(2);
  });

  it('점령하면 땅이 한 번에 뒤집히지 않고 시간에 따라 넘어간다', () => {
    const f = new TerritoryField(W, H, 3);
    const p = planet(480, 240, 1);
    f.update({ planets: [p], units: [] }, 0, true);
    const c = cellAt(f, 480, 240);
    const v1 = f.influence(1, c);
    p.owner = 2;
    f.update({ planets: [p], units: [] }, 0.25, true);
    // 0.25초 뒤: 아직 이전 주인의 영향이 남아 있고 새 주인은 일부만
    expect(f.influence(1, c)).toBeGreaterThan(0.1 * v1);
    expect(f.influence(2, c)).toBeLessThan(0.9 * v1);
    for (let i = 0; i < 12; i++) f.update({ planets: [p], units: [] }, 0.25, true);
    expect(f.owner[c]).toBe(2);
    expect(f.influence(1, c)).toBeLessThan(0.01);
  });

  it('흐림을 끄면(품질 낮음) 칸 경계가 더 급하다', () => {
    const edge = (blur: boolean) => {
      const f = new TerritoryField(W, H, 3);
      f.update({ planets: [planet(480, 240, 1, 50)], units: [] }, 0, blur);
      let maxStep = 0;
      for (let x = 480; x < W - f.cell; x += f.cell) maxStep = Math.max(maxStep, Math.abs(f.influence(1, cellAt(f, x, 240)) - f.influence(1, cellAt(f, x + f.cell, 240))));
      return maxStep;
    };
    expect(edge(false)).toBeGreaterThan(edge(true));
  });

  it('RGBA 로 칠할 때: 땅 없는 칸은 투명, 땅은 진영 색이고 짙은 곳일수록 불투명', () => {
    const f = new TerritoryField(W, H, 3);
    f.update({ planets: [planet(360, 240, 1), planet(600, 240, 2)], units: [] }, 0, true);
    const px = new Uint8ClampedArray(f.cols * f.rows * 4);
    f.paint(px, colors);
    const at = (x: number, y: number) => {
      const o = cellAt(f, x, y) * 4;
      return { r: px[o], g: px[o + 1], b: px[o + 2], a: px[o + 3] };
    };
    expect(at(10, 10).a).toBe(0);
    const core = at(360, 240), edge = at(440, 240), red = at(600, 240);
    expect([core.r, core.g, core.b]).toEqual([79, 195, 247]);
    expect([red.r, red.g, red.b]).toEqual([255, 93, 93]);
    expect(core.a).toBeGreaterThan(edge.a);
    expect(edge.a).toBeGreaterThan(0);
  });
});
