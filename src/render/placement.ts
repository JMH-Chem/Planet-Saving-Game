// 화면 위 작은 상자(행성 툴팁 · 커서 힌트)의 자리 고르기. 캔버스에 그리지만 그 위에는 DOM HUD(미니맵 · 버튼 ·
// 토스트)가 떠 있어서, 겹치는 자리에 그리면 아예 보이지 않는다. DOM 을 모르는 순수 함수라 테스트에서 그대로 쓴다.

/** 화면 사각형 (CSS px) */
export interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface Point {
  x: number;
  y: number;
}

export const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

/**
 * w×h 상자의 왼쪽 위 자리. 후보를 순서대로 보며 보이는 영역(view) 안에 다 들어가고 avoid 의 어느 것과도
 * gap 안쪽으로 겹치지 않는 첫 자리를 쓴다. 다 막히면 첫 후보를 영역 안으로 당긴 뒤, 가로막은 상자의
 * 네 옆 중 들어맞는 곳으로 가장 적게 비킨다. 그래도 없으면 영역 안으로 당긴 자리 그대로.
 */
export function placeBox(cands: readonly Point[], w: number, h: number, view: Box, avoid: readonly Box[], gap = 6): Point {
  const blocker = (x: number, y: number) => avoid.find((b) => x < b.right + gap && x + w > b.left - gap && y < b.bottom + gap && y + h > b.top - gap);
  const fits = (x: number, y: number) => x >= view.left && x + w <= view.right && y >= view.top && y + h <= view.bottom && !blocker(x, y);
  for (const c of cands) if (fits(c.x, c.y)) return c;
  const x = clamp(cands[0].x, view.left, view.right - w);
  const y = clamp(cands[0].y, view.top, view.bottom - h);
  const b = blocker(x, y);
  if (!b) return { x, y };
  const moves = [
    { x: b.left - gap - w, y },
    { x: b.right + gap, y },
    { x, y: b.top - gap - h },
    { x, y: b.bottom + gap },
  ].filter((m) => fits(m.x, m.y));
  moves.sort((m1, m2) => Math.abs(m1.x - x) + Math.abs(m1.y - y) - (Math.abs(m2.x - x) + Math.abs(m2.y - y)));
  return moves[0] ?? { x, y };
}
