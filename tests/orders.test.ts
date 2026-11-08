import { describe, expect, it } from 'vitest';
import { CONFIG } from '../src/config';
import { refineSlots, TWO_OPT_BUDGET } from '../src/sim/orders';
import type { Order } from '../src/sim/types';
import { World } from '../src/sim/world';

/** 결정론적 난수 (테스트 입력용) */
function lcg(seed: number) {
  let s = seed;
  return () => (s = (s * 16807) % 2147483647) / 2147483647;
}

/**
 * assign 이 넘겨주는 모양의 입력: 흩어진 유닛과 멀리 떨어진 슬롯을 같은 축(x)으로 정렬해 순서대로 짝지은 것.
 * 축 정렬만으로는 경로가 많이 엇갈려서 2-opt 가 여러 번 훑어야 한다
 */
function sortedPairs(n: number, seed: number) {
  const r = lcg(seed);
  const units = Array.from({ length: n }, () => {
    const a = r() * Math.PI * 2, d = Math.sqrt(r()) * 120;
    const cx = r() < 0.6 ? 300 : 450;
    return [cx + Math.cos(a) * d, 400 + (cx - 300) + Math.sin(a) * d];
  });
  const slots = Array.from({ length: n }, () => [1200 + r() * 80, 300 + r() * 400]);
  units.sort((a, b) => a[1] - b[1]);
  slots.sort((a, b) => a[1] - b[1]);
  return {
    ux: Float64Array.from(units, (p) => p[0]), uy: Float64Array.from(units, (p) => p[1]),
    sx: Float64Array.from(slots, (p) => p[0]), sy: Float64Array.from(slots, (p) => p[1]),
  };
}

/** 예산 · 건너뛰기 없이 매번 창 안의 모든 쌍을 따지는 예전 2-opt (창 32, 10번) */
function reference2opt(ux: Float64Array, uy: Float64Array, sx: Float64Array, sy: Float64Array): void {
  const n = ux.length;
  const d = (ax: number, ay: number, bx: number, by: number) => Math.sqrt((ax - bx) ** 2 + (ay - by) ** 2);
  const cost = Float64Array.from({ length: n }, (_, i) => d(ux[i], uy[i], sx[i], sy[i]));
  for (let pass = 0; pass < 10; pass++) {
    let swapped = false;
    for (let i = 0; i < n - 1; i++) {
      for (let j = i + 1; j < Math.min(n, i + 33); j++) {
        const a = d(ux[i], uy[i], sx[j], sy[j]);
        const b = d(ux[j], uy[j], sx[i], sy[i]);
        if (a + b < cost[i] + cost[j] - 1e-6) {
          [sx[i], sx[j], sy[i], sy[j]] = [sx[j], sx[i], sy[j], sy[i]];
          cost[i] = a;
          cost[j] = b;
          swapped = true;
        }
      }
    }
    if (!swapped) break;
  }
}

const totalLength = (p: ReturnType<typeof sortedPairs>) =>
  p.ux.reduce((t, x, i) => t + Math.hypot(x - p.sx[i], p.uy[i] - p.sy[i]), 0);

describe('슬롯 다듬기(2-opt) 예산', () => {
  it.each([50, 150, 300])('%i기 이하 무리는 예산에 닿지 않고 예전과 똑같이 짝짓는다', (n) => {
    for (const seed of [1, 2, 3]) {
      const p = sortedPairs(n, seed);
      const q = { ux: p.ux, uy: p.uy, sx: p.sx.slice(), sy: p.sy.slice() };
      const sx0 = p.sx.slice();
      const evals = refineSlots(p.ux, p.uy, p.sx, p.sy);
      reference2opt(q.ux, q.uy, q.sx, q.sy);
      expect(evals).toBeLessThan(TWO_OPT_BUDGET);
      // 실제로 많이 맞바꾼 입력이어야 비교가 의미 있다
      expect(p.sx.filter((x, i) => x !== sx0[i]).length).toBeGreaterThan(n / 4);
      expect([...p.sx]).toEqual([...q.sx]);
      expect([...p.sy]).toEqual([...q.sy]);
    }
  });

  it('그대로인 쌍을 건너뛰어도 결과는 모든 쌍을 다시 따질 때와 똑같다 (예산이 없으면 큰 무리도)', () => {
    const p = sortedPairs(1000, 7);
    const q = { ux: p.ux, uy: p.uy, sx: p.sx.slice(), sy: p.sy.slice() };
    refineSlots(p.ux, p.uy, p.sx, p.sy, Infinity);
    reference2opt(q.ux, q.uy, q.sx, q.sy);
    expect([...p.sx]).toEqual([...q.sx]);
    expect([...p.sy]).toEqual([...q.sy]);
  });

  it('큰 무리는 예산 안에서 멈추고, 슬롯을 잃거나 겹치지 않으며 경로가 길어지지 않는다', () => {
    const p = sortedPairs(2000, 11);
    const before = totalLength(p);
    const slotsBefore = [...p.sx].map((x, i) => `${x},${p.sy[i]}`).sort();
    const evals = refineSlots(p.ux, p.uy, p.sx, p.sy);
    expect(evals).toBeLessThanOrEqual(TWO_OPT_BUDGET);
    expect([...p.sx].map((x, i) => `${x},${p.sy[i]}`).sort()).toEqual(slotsBefore);
    expect(totalLength(p)).toBeLessThan(before);
    // 작은 예산도 그대로 지킨다
    const s = sortedPairs(2000, 12);
    expect(refineSlots(s.ux, s.uy, s.sx, s.sy, 5000)).toBeLessThanOrEqual(5000);
  });

  it('예산에 걸려 멈춰도 결정론적이다', () => {
    const a = sortedPairs(2000, 5), b = sortedPairs(2000, 5);
    refineSlots(a.ux, a.uy, a.sx, a.sy);
    refineSlots(b.ux, b.uy, b.sx, b.sy);
    expect([...a.sx]).toEqual([...b.sx]);
    expect([...a.sy]).toEqual([...b.sy]);
  });
});

describe('큰 무리 명령', () => {
  const world = (seed: number) => {
    const w = new World({
      width: 1700, height: 1100, seed, factionCount: 2, aiFactions: [],
      planets: [
        { x: 150, y: 150, size: 'small', owner: 1, garrison: 0 },
        { x: 1450, y: 550, size: 'large', owner: 2, garrison: 0 },
        { x: 500, y: 550, size: 'medium', owner: 1, garrison: 0 },
      ],
    });
    for (const p of w.planets) p.production = 0;
    const r = lcg(seed);
    const army = Array.from({ length: 2000 }, () => {
      const a = r() * Math.PI * 2, d = Math.sqrt(r()) * 120;
      const cx = 250 + Math.floor(r() * 4) * 150;
      return w.spawnAt(1, cx + Math.cos(a) * d, 300 + (cx - 250) + Math.sin(a) * d, false);
    });
    return { w, army };
  };

  it.each([
    ['집중 이동', { kind: 'move', x: 1200, y: 500, formation: 'cluster' }],
    ['횡대', { kind: 'line', x1: 1250, y1: 250, x2: 1350, y2: 850 }],
    ['돌파', { kind: 'planet', planetId: 1, formation: 'cluster' }],
    ['포위', { kind: 'planet', planetId: 1, formation: 'spread' }],
    ['귀환', { kind: 'return' }],
  ] as [string, Order][])('2000기 %s: 모두 명령을 받고, 같은 입력이면 같은 짝', (_, o) => {
    const targets = () => {
      const { w, army } = world(3);
      w.enqueue({ faction: 1, unitIds: army.map((u) => u.id), order: o });
      w.step(1 / CONFIG.tickRate);
      // 귀환은 이미 대기권 안에 있던 병력이 그 틱에 바로 궤도에 든다: 위치 고수(hold)로 남은 병력만 없으면 된다
      expect(army.every((u) => u.state !== 'hold')).toBe(true);
      return army.map((u) => `${u.tx},${u.ty}`);
    };
    expect(targets()).toEqual(targets());
  });
});
