import { describe, expect, it } from 'vitest';
import { bloomTarget } from '../src/render/bloom';
import { FLASH_STAMP_PX, flashDome, flashStampAlpha, stampsFlash } from '../src/render/effects';
import { QUALITY } from '../src/render/quality';

// 발광 버퍼의 섬광: 작은 것은 네모를 모아 칠하고, 큰 것은 둥근 빛을 찍는다.
// 큰 섬광을 네모로 그리면 흐림이 모서리를 덮지 못해 행성 점령 · 확대한 화면에서 각진 판이 보였다.

/** 반경 1 둥근 빛의 밝기 총량 (수치 적분) */
function domeSum(): number {
  const N = 4000;
  let s = 0;
  for (let i = 0; i < N; i++) {
    const rho = (i + 0.5) / N;
    s += (flashDome(rho) * 2 * Math.PI * rho) / N;
  }
  return s;
}

/** 품질 q, 배율 zoom 에서 월드 반경 r 인 섬광을 둥근 빛으로 찍는가 */
function stampsAt(q: (typeof QUALITY)['high'], zoom: number, r: number) {
  return stampsFlash((r * zoom * q.bloomScale) / 2 ** bloomTarget(q.bloomLevels));
}

describe('발광 버퍼의 섬광 모양', () => {
  it('둥근 빛은 가운데가 가장 밝고 바깥으로 갈수록 어두워지다 가장자리에서 테두리 없이 0', () => {
    expect(flashDome(0)).toBe(1);
    let prev = 1;
    for (let k = 1; k <= 20; k++) {
      const v = flashDome(k / 20);
      expect(v).toBeLessThan(prev);
      prev = v;
    }
    expect(flashDome(1)).toBe(0);
    expect(flashDome(1.5)).toBe(0);
    // 가장자리 바로 안쪽도 거의 0 (기울기까지 0 이라 흐림이 짧아도 선이 남지 않는다)
    expect(flashDome(0.97)).toBeLessThan(0.004);
  });

  it('둥근 빛으로 바꿔 찍어도 번지는 빛의 총량은 네모(한 변 1.4r, 밝기 0.6(1 − t)²)와 같다: 문턱을 넘어도 밝기가 튀지 않는다', () => {
    const dome = domeSum();
    for (const t of [0.1, 0.3, 0.5, 0.8, 0.95]) {
      const rect = 1.4 * 1.4 * 0.6 * (1 - t) * (1 - t);
      expect(dome * flashStampAlpha(t)).toBeCloseTo(rect, 3);
    }
    // 갓 생긴 섬광은 1 에서 잘린다 (globalAlpha 는 1 을 넘는 값을 무시한다)
    expect(flashStampAlpha(0)).toBe(1);
    expect(flashStampAlpha(1)).toBe(0);
  });

  it('문턱은 합성 단계 버퍼 px: 품질 높음(1 단계에 모은다)은 0 단계 6px, 중간(0 단계)은 3px 부터 찍는다', () => {
    expect(stampsFlash(FLASH_STAMP_PX - 0.01)).toBe(false);
    expect(stampsFlash(FLASH_STAMP_PX)).toBe(true);
    // 반경 r 월드, 0 단계 px = r * zoom * scale
    expect(stampsAt(QUALITY.high, 1, 5.9 / QUALITY.high.bloomScale)).toBe(false);
    expect(stampsAt(QUALITY.high, 1, 6 / QUALITY.high.bloomScale)).toBe(true);
    expect(stampsAt(QUALITY.medium, 1, 3 / QUALITY.medium.bloomScale)).toBe(true);
  });

  it('행성 점령 섬광은 확대 0.5~3.2, 발광 켜진 모든 품질에서 둥근 빛 (대량 격추 섬광은 확대 1.6 이상)', () => {
    for (const q of [QUALITY.high, QUALITY.medium]) {
      for (const zoom of [0.5, 1, 1.6, 2.6, 3.2]) {
        // 큰 행성(반경 34) 점령 섬광 반경 2.2R, 가장 작게 그려지는 갓 생긴 때 (× 0.75). 작은 행성(18)은 확대 1 부터
        expect(stampsAt(q, zoom, 34 * 2.2 * 0.75)).toBe(true);
        if (zoom >= 1) expect(stampsAt(q, zoom, 18 * 2.2 * 0.75)).toBe(true);
        // 대량 격추 섬광 (반경 22~38)
        if (zoom >= 1.6) expect(stampsAt(q, zoom, 22 * 0.75)).toBe(true);
      }
    }
  });

  it('총구 · 착탄 섬광처럼 작은 것은 확대해도 네모로 모아 칠한다 (그리기 수를 늘리지 않는다)', () => {
    for (const q of [QUALITY.high, QUALITY.medium]) {
      for (const zoom of [1.2, 2.6, 3.2]) {
        // 총구 섬광 반경 4~4.5, 다 자랐을 때 (× 1.25)
        expect(stampsAt(q, zoom, 4.5 * 1.25)).toBe(false);
      }
    }
  });
});
