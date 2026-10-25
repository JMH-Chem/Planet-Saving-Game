import type { Unit } from './types';

/** 균일 격자 공간 해시. 매 틱 재구성해 근접 탐색을 O(주변 칸)으로 줄인다. */
export class SpatialGrid {
  readonly cellSize: number;
  private cols: number;
  private rows: number;
  private cells: Unit[][];

  constructor(width: number, height: number, cellSize: number) {
    this.cellSize = cellSize;
    this.cols = Math.max(1, Math.ceil(width / cellSize));
    this.rows = Math.max(1, Math.ceil(height / cellSize));
    this.cells = Array.from({ length: this.cols * this.rows }, () => []);
  }

  private cx(x: number): number {
    return Math.min(this.cols - 1, Math.max(0, Math.floor(x / this.cellSize)));
  }

  private cy(y: number): number {
    return Math.min(this.rows - 1, Math.max(0, Math.floor(y / this.cellSize)));
  }

  rebuild(units: readonly Unit[]): void {
    for (const c of this.cells) c.length = 0;
    for (const u of units) {
      if (u.alive) this.cells[this.cy(u.y) * this.cols + this.cx(u.x)].push(u);
    }
  }

  /** 반경 r 안에서 predicate 를 만족하는 가장 가까운 유닛 */
  nearest(x: number, y: number, r: number, predicate: (u: Unit) => boolean): Unit | null {
    const x0 = this.cx(x - r), x1 = this.cx(x + r);
    const y0 = this.cy(y - r), y1 = this.cy(y + r);
    let best: Unit | null = null;
    let bestD = r * r;
    for (let gy = y0; gy <= y1; gy++) {
      for (let gx = x0; gx <= x1; gx++) {
        for (const u of this.cells[gy * this.cols + gx]) {
          const dx = u.x - x, dy = u.y - y;
          const d = dx * dx + dy * dy;
          if (d <= bestD && predicate(u)) {
            bestD = d;
            best = u;
          }
        }
      }
    }
    return best;
  }

  forEachInRadius(x: number, y: number, r: number, fn: (u: Unit) => void): void {
    const x0 = this.cx(x - r), x1 = this.cx(x + r);
    const y0 = this.cy(y - r), y1 = this.cy(y + r);
    const r2 = r * r;
    for (let gy = y0; gy <= y1; gy++) {
      for (let gx = x0; gx <= x1; gx++) {
        for (const u of this.cells[gy * this.cols + gx]) {
          const dx = u.x - x, dy = u.y - y;
          if (dx * dx + dy * dy <= r2) fn(u);
        }
      }
    }
  }
}
