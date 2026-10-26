import { describe, expect, it } from 'vitest';
import { placeBox, type Box, type Point } from '../src/render/placement';

// 1280×800 데스크톱에서 잰 실제 HUD 배치 (camera.viewRect() 와 미니맵 · 그 옆 버튼)
const VIEW: Box = { left: 12, top: 70, right: 1268, bottom: 722 };
const MINIMAP: Box = { left: 1026, top: 634, right: 1268, bottom: 790 };
const TOOLS: Box = { left: 986, top: 634, right: 1020, bottom: 708 };
const HUD = [MINIMAP, TOOLS];

const overlaps = (p: Point, w: number, h: number, b: Box) => p.x < b.right && p.x + w > b.left && p.y < b.bottom && p.y + h > b.top;
const inside = (p: Point, w: number, h: number, v: Box) => p.x >= v.left && p.x + w <= v.right && p.y >= v.top && p.y + h <= v.bottom;

/** renderer.ts 의 행성 툴팁 후보 (대기권 아래 → 위 → 왼쪽 → 오른쪽) */
function tooltipCands(cx: number, cy: number, ar: number, w: number, h: number): Point[] {
  const x = Math.min(VIEW.right - w, Math.max(VIEW.left, cx - w / 2));
  const y = Math.min(VIEW.bottom - h, Math.max(VIEW.top, cy - h / 2));
  return [
    { x, y: cy + ar + 10 },
    { x, y: cy - ar - 10 - h },
    { x: cx - ar - 10 - w, y },
    { x: cx + ar + 10, y },
  ];
}

describe('화면 상자 배치 (툴팁 · 커서 힌트)', () => {
  it('막힌 데가 없으면 첫 후보 그대로', () => {
    expect(placeBox([{ x: 300, y: 300 }], 150, 64, VIEW, HUD)).toEqual({ x: 300, y: 300 });
  });

  it('미니맵 바로 위 행성의 툴팁은 미니맵 밑에 깔리지 않고 행성 위로 넘어간다', () => {
    // 리뷰에서 재현한 자리: 소형 행성(대기권 42) 이 화면 (1116, 589), 배율 1
    const w = 156, h = 64;
    const p = placeBox(tooltipCands(1116, 589, 42, w, h), w, h, VIEW, HUD);
    expect(overlaps(p, w, h, MINIMAP) || overlaps(p, w, h, TOOLS)).toBe(false);
    expect(inside(p, w, h, VIEW)).toBe(true);
    expect(p.y + h).toBeLessThanOrEqual(589 - 42);
  });

  it('명령 바 바로 위의 커서 힌트는 커서 위로 넘어간다', () => {
    const w = 70, cx = 500, cy = 712;
    const p = placeBox([{ x: cx + 16, y: cy + 14 }, { x: cx - 8 - w, y: cy + 14 }, { x: cx + 16, y: cy - 30 }], w, 22, VIEW, HUD);
    expect(p).toEqual({ x: cx + 16, y: cy - 30 });
  });

  it('미니맵 옆 버튼 바로 왼쪽의 커서 힌트는 커서 왼쪽으로', () => {
    const w = 70, cx = 970, cy = 650;
    const p = placeBox([{ x: cx + 16, y: cy + 14 }, { x: cx - 8 - w, y: cy + 14 }], w, 22, VIEW, HUD);
    expect(p).toEqual({ x: cx - 8 - w, y: cy + 14 });
  });

  it('후보가 다 막히면 가로막은 창 옆으로 가장 적게 비킨다', () => {
    const p = placeBox([{ x: 1100, y: 700 }], 100, 30, VIEW, HUD);
    expect(inside(p, 100, 30, VIEW)).toBe(true);
    expect(HUD.some((b) => overlaps(p, 100, 30, b))).toBe(false);
    // 미니맵 위쪽으로 (가로 위치는 그대로)
    expect(p).toEqual({ x: 1100, y: MINIMAP.top - 6 - 30 });
  });

  it('행성이 화면 어디에 있든 툴팁은 보이는 영역 안, HUD 밖', () => {
    const w = 156, h = 64, ar = 42;
    for (let cy = VIEW.top; cy <= VIEW.bottom; cy += 12) {
      for (let cx = VIEW.left; cx <= VIEW.right; cx += 12) {
        const p = placeBox(tooltipCands(cx, cy, ar, w, h), w, h, VIEW, HUD);
        expect(inside(p, w, h, VIEW), `planet at ${cx},${cy}`).toBe(true);
        expect(HUD.some((b) => overlaps(p, w, h, b)), `planet at ${cx},${cy}`).toBe(false);
      }
    }
  });
});
