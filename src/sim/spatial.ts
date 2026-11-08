import type { FactionId, Unit } from './types';

/**
 * 균일 격자 공간 해시. 매 틱 재구성해 근접 탐색을 O(주변 칸)으로 줄인다.
 * 칸마다 연결 리스트(head → next)로 담는다: 칸 배열(Unit[][])을 비우고 다시 채우던 판은 1,000기 이상에서 틱의 17~24% 를 썼다.
 * 리스트는 units 배열을 뒤에서부터 앞에 끼워 넣어 만들므로, 한 칸 안의 순회 순서는 units 배열 순서 그대로다
 * (가장 가까운 적을 고를 때 거리가 같으면 먼저 본 쪽이 이긴다: 순서가 바뀌면 결과가 달라진다).
 * 재구성 때의 Unit 참조를 따로 들고 있으므로, 재구성 뒤 units 배열에서 빠진(죽은) 병력도 다음 재구성까지 질의에 나온다
 * (예전 판과 같다).
 */
export class SpatialGrid {
  readonly cellSize: number;
  private cols: number;
  private rows: number;
  /** 칸마다 첫 항목 (items 번호), 비었으면 -1 */
  private head: Int32Array;
  /** 칸이 쓰였는지 (다음 재구성 때 쓴 칸만 되돌린다) */
  private used: Int32Array;
  private usedCount = 0;
  private next = new Int32Array(0);
  private items: Unit[] = [];
  /** 재구성 때의 좌표 · 진영 (nearestEnemy 전용: 흩어진 Unit 객체를 읽지 않고 연속된 배열에서 거리를 잰다) */
  private xs = new Float64Array(0);
  private ys = new Float64Array(0);
  private fs = new Int32Array(0);

  constructor(width: number, height: number, cellSize: number) {
    this.cellSize = cellSize;
    this.cols = Math.max(1, Math.ceil(width / cellSize));
    this.rows = Math.max(1, Math.ceil(height / cellSize));
    this.head = new Int32Array(this.cols * this.rows).fill(-1);
    this.used = new Int32Array(this.cols * this.rows);
  }

  private cx(x: number): number {
    return Math.min(this.cols - 1, Math.max(0, Math.floor(x / this.cellSize)));
  }

  private cy(y: number): number {
    return Math.min(this.rows - 1, Math.max(0, Math.floor(y / this.cellSize)));
  }

  rebuild(units: readonly Unit[]): void {
    const head = this.head;
    const used = this.used;
    for (let k = 0; k < this.usedCount; k++) head[used[k]] = -1;
    let usedCount = 0;
    const n = units.length;
    if (this.next.length < n) {
      const cap = Math.max(n, this.next.length * 2, 256);
      this.next = new Int32Array(cap);
      this.xs = new Float64Array(cap);
      this.ys = new Float64Array(cap);
      this.fs = new Int32Array(cap);
    }
    const { next, xs, ys, fs } = this;
    const items = this.items;
    items.length = n;
    // 뒤에서부터 앞에 끼우면 리스트 순서 = units 배열 순서
    for (let i = n - 1; i >= 0; i--) {
      const u = units[i];
      items[i] = u;
      if (!u.alive) continue;
      xs[i] = u.x;
      ys[i] = u.y;
      fs[i] = u.faction;
      const c = this.cy(u.y) * this.cols + this.cx(u.x);
      const h = head[c];
      if (h < 0) used[usedCount++] = c;
      next[i] = h;
      head[c] = i;
    }
    this.usedCount = usedCount;
  }

  /** 반경 r 안에서 predicate 를 만족하는 가장 가까운 유닛 */
  nearest(x: number, y: number, r: number, predicate: (u: Unit) => boolean): Unit | null {
    const x0 = this.cx(x - r), x1 = this.cx(x + r);
    const y0 = this.cy(y - r), y1 = this.cy(y + r);
    const head = this.head, next = this.next, items = this.items, cols = this.cols;
    let best: Unit | null = null;
    let bestD = r * r;
    for (let gy = y0; gy <= y1; gy++) {
      for (let gx = x0; gx <= x1; gx++) {
        for (let i = head[gy * cols + gx]; i >= 0; i = next[i]) {
          const u = items[i];
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

  /**
   * nearest(x, y, r, (v) => v.faction !== faction && v.hp > 0) 와 같다 (전투의 표적 찾기: 틱마다 클로저를 만들지 않는다).
   * 좌표 · 진영은 재구성 때 값을 쓴다: 재구성(이동 직후)과 전투 사이에는 병력이 움직이지 않는다. 체력은 그때그때 읽는다.
   */
  nearestEnemy(x: number, y: number, r: number, faction: FactionId): Unit | null {
    const x0 = this.cx(x - r), x1 = this.cx(x + r);
    const y0 = this.cy(y - r), y1 = this.cy(y + r);
    const { head, next, items, xs, ys, fs, cols } = this;
    let best = -1;
    let bestD = r * r;
    for (let gy = y0; gy <= y1; gy++) {
      for (let gx = x0; gx <= x1; gx++) {
        for (let i = head[gy * cols + gx]; i >= 0; i = next[i]) {
          const dx = xs[i] - x, dy = ys[i] - y;
          const d = dx * dx + dy * dy;
          if (d <= bestD && fs[i] !== faction && items[i].hp > 0) {
            bestD = d;
            best = i;
          }
        }
      }
    }
    return best >= 0 ? items[best] : null;
  }

  forEachInRadius(x: number, y: number, r: number, fn: (u: Unit) => void): void {
    const x0 = this.cx(x - r), x1 = this.cx(x + r);
    const y0 = this.cy(y - r), y1 = this.cy(y + r);
    const head = this.head, next = this.next, items = this.items, cols = this.cols;
    const r2 = r * r;
    for (let gy = y0; gy <= y1; gy++) {
      for (let gx = x0; gx <= x1; gx++) {
        for (let i = head[gy * cols + gx]; i >= 0; i = next[i]) {
          const u = items[i];
          const dx = u.x - x, dy = u.y - y;
          if (dx * dx + dy * dy <= r2) fn(u);
        }
      }
    }
  }
}
