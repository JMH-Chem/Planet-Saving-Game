import { describe, expect, it } from 'vitest';
import { bloomBands } from '../src/render/bloom';
import { lightAt, nightFactor } from '../src/render/planetArt';

// 발광 합성 띠: 빛이 있는 줄만, 번지는 폭만큼 넓혀, 겹치지 않게 (겹치면 그 자리가 두 번 더해져 밝아진다)

const ROW = 16;
function rows(n: number, spans: Record<number, [number, number]>) {
  const min = new Float32Array(n).fill(Infinity), max = new Float32Array(n).fill(-Infinity);
  for (const [r, [a, b]] of Object.entries(spans)) {
    min[+r] = a;
    max[+r] = b;
  }
  return { min, max };
}

describe('발광 합성 띠', () => {
  it('빛이 없으면 띠도 없다 (합성 비용 0)', () => {
    const { min, max } = rows(10, {});
    expect(bloomBands(min, max, ROW, 20, 800, 160)).toEqual([]);
  });

  it('한 줄의 빛은 번지는 폭만큼 넓힌 사각형 하나 (화면 안으로 자른다)', () => {
    const { min, max } = rows(10, { 3: [100, 140] });
    expect(bloomBands(min, max, ROW, 20, 800, 160)).toEqual([{ x: 80, y: 28, w: 80, h: 56 }]);
    const edge = rows(10, { 0: [0, 10] });
    expect(bloomBands(edge.min, edge.max, ROW, 20, 800, 160)).toEqual([{ x: 0, y: 0, w: 30, h: 36 }]);
  });

  it('맞닿거나 겹치는 줄은 한 띠로 합치고 가로 범위는 합집합', () => {
    const { min, max } = rows(20, { 2: [100, 120], 3: [300, 320], 5: [200, 210] });
    const bands = bloomBands(min, max, ROW, 10, 800, 320);
    expect(bands).toHaveLength(1);
    expect(bands[0]).toEqual({ x: 90, y: 22, w: 240, h: 84 });
  });

  it('멀리 떨어진 빛은 따로 띠를 만들고, 띠끼리는 절대 겹치지 않는다', () => {
    const { min, max } = rows(40, { 2: [100, 120], 20: [500, 600], 21: [550, 560], 35: [0, 800] });
    const bands = bloomBands(min, max, ROW, 24, 800, 640);
    expect(bands).toHaveLength(3);
    for (let i = 1; i < bands.length; i++) expect(bands[i].y).toBeGreaterThanOrEqual(bands[i - 1].y + bands[i - 1].h);
    const area = bands.reduce((s, b) => s + b.w * b.h, 0);
    expect(area).toBeLessThan(800 * 640 * 0.5);
  });
});

describe('행성 밤쪽 · 도시 불빛 자리', () => {
  it('광원(왼쪽 위) 쪽은 낮, 반대쪽 가장자리는 밤', () => {
    const R = 30;
    expect(nightFactor(-R * 0.5, -R * 0.5, R)).toBe(0);
    expect(nightFactor(R * 0.7, R * 0.6, R)).toBe(1);
    // 낮 → 밤으로 갈수록 커진다
    let prev = -1;
    for (let k = -0.6; k <= 0.65; k += 0.05) {
      const n = nightFactor(R * k, R * k, R);
      expect(n).toBeGreaterThanOrEqual(prev);
      prev = n;
    }
  });

  it('불빛은 표면과 같이 돈다: 자전 한 주기(4R)가 지나면 같은 자리, 반 주기면 뒤로 넘어간다', () => {
    const R = 20;
    const lights = new Float32Array([0.25, 0.5, 1]);
    const a = { x: 0, y: 0 }, b = { x: 0, y: 0 };
    expect(lightAt(lights, 0, R, 0, a)).toBe(true);
    expect(a.x).toBeCloseTo(0);
    expect(a.y).toBeCloseTo(0);
    expect(lightAt(lights, 0, R, 4 * R, b)).toBe(true);
    expect(b.x).toBeCloseTo(a.x);
    // 오른쪽으로 R/2 굴리면 왼쪽으로 R/2 이동
    expect(lightAt(lights, 0, R, R / 2, b)).toBe(true);
    expect(b.x).toBeCloseTo(-R / 2);
    expect(lightAt(lights, 0, R, 2 * R, b)).toBe(false);
  });
});
