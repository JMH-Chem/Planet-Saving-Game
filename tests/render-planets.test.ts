import { describe, expect, it } from 'vitest';
import { Camera } from '../src/render/camera';
import { cacheScale, floodCircle, MAX_CACHE_SCALE, onScreenShare } from '../src/render/planets';
import { CONFIG } from '../src/config';

// 렌더러는 DPR 을 2 에서 자른다 (renderer.ts resize)
const MAX_DPR = 2;

describe('행성 캐시 배율', () => {
  it('최대 확대 × DPR 2 까지는 화면 배율 그대로 캐시를 그린다 (늘려 찍지 않아 선명하고, 직접 그리기로 넘어가지 않는다)', () => {
    const top = new Camera().maxZoom * MAX_DPR;
    for (const scale of [0.3, 1, 2.5, 4, 5, 5.2, 5.8, top]) expect(cacheScale(scale)).toBe(scale);
  });

  it('그보다 크게 확대되면 MAX_CACHE_SCALE 에서 멈춘다 (캐시 캔버스 크기 상한)', () => {
    expect(cacheScale(MAX_CACHE_SCALE * 1.5)).toBe(MAX_CACHE_SCALE);
    const largest = Math.max(...Object.values(CONFIG.planet).map((s) => s.radius)) + CONFIG.atmosphere;
    // PlanetLayer.fit 과 같은 식: 가장 큰 행성도 캐시 한 장이 1000px 을 넘지 않는다
    expect(Math.ceil((largest + 4) * 2 * cacheScale(100)) + 2).toBeLessThan(1000);
  });
});

describe('행성이 화면에 걸친 비율 (크게 확대했을 때 캐시 / 직접 그리기 선택)', () => {
  const view = { x0: 0, y0: 0, x1: 400, y1: 250 };
  it('다 보이면 1, 안 보이면 0', () => {
    expect(onScreenShare(view, 200, 125, 50)).toBe(1);
    expect(onScreenShare(view, -100, 125, 50)).toBe(0);
  });
  it('가장자리에 걸치면 걸친 넓이만큼', () => {
    expect(onScreenShare(view, 0, 125, 50)).toBeCloseTo(0.5);
    expect(onScreenShare(view, 0, 0, 50)).toBeCloseTo(0.25);
    expect(onScreenShare(view, 425, 125, 50)).toBeCloseTo(0.25);
  });
});

describe('점령 물결 원', () => {
  const R = 26, A = R + 24;
  const out = { x: 0, y: 0, r: 0 };

  it('공격군이 들어온 표면 자리에서 시작한다', () => {
    floodCircle(R, A, Math.PI / 3, 0, out);
    expect(out.x).toBeCloseTo(Math.cos(Math.PI / 3) * R);
    expect(out.y).toBeCloseTo(Math.sin(Math.PI / 3) * R);
    expect(out.r).toBeLessThan(1);
  });

  it('반지름은 줄지 않고 커진다', () => {
    let prev = 0;
    for (let f = 0; f <= 1.0001; f += 0.05) {
      floodCircle(R, A, 0, Math.min(1, f), out);
      expect(out.r).toBeGreaterThanOrEqual(prev);
      prev = out.r;
    }
  });

  it('끝나면 어느 방향에서 들어왔든 대기권 전체를 덮는다 (이전 모습이 한 픽셀도 남지 않아 연출 뒤 캐시와 같은 그림)', () => {
    for (let k = 0; k < 16; k++) {
      const entry = (k / 16) * Math.PI * 2 - Math.PI;
      floodCircle(R, A, entry, 1, out);
      for (let j = 0; j < 64; j++) {
        // 대기권 경계(+ 안티에일리어싱 1px 여유) 위의 점
        const a = (j / 64) * Math.PI * 2;
        const x = Math.cos(a) * (A + 1), y = Math.sin(a) * (A + 1);
        expect(Math.hypot(x - out.x, y - out.y)).toBeLessThanOrEqual(out.r);
      }
    }
  });
});
