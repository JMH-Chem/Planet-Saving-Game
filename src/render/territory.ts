// 영토(세력권) 장: 맵을 굵은 칸으로 나눠 칸마다 진영별 영향력을 더하고, 가장 센 진영이 그 칸을 가진다.
// 두 진영의 땅이 맞닿은 곳(두 영향력이 같아지는 곳)은 '전선'이라 가는 밝은 선으로 보여 준다.
//
// 전선을 칸 단위로 칠하면(둘째 / 첫째 비율이 1 에 가까운 칸) 영향력이 칸 하나 사이에 크게 바뀌는 탓에, 경계가 칸 한가운데를
// 지날 때만 보이고 칸 사이를 지나면 사라진다 (전선이 끊긴 얼룩이 된다). 그래서 칸 중심들을 꼭짓점으로 하는 사각형마다
// 주인이 바뀌는 변 위에서 '두 진영 영향력의 차 = 0' 인 자리를 선형 보간으로 찾아 잇는다 (마칭 스퀘어).
//
// 그리기와 분리된 순수 계산이라(DOM 없음) 테스트에서 그대로 쓴다. 렌더러는 초당 몇 번만 다시 계산해서
// 칸 하나 = 1px 인 작은 캔버스에 올리고, 그것을 월드 크기로 부드럽게 늘려 행성 밑에 옅게 깐다.

/** 칸 한 변 (월드 단위). 1800×1160 맵이 75×49 칸 */
export const TERRITORY_CELL = 24;

/** 계산에 필요한 만큼만 받는다 (sim 의 Planet · Unit 이 그대로 들어맞는다) */
export interface TerritoryPlanet {
  x: number;
  y: number;
  radius: number;
  owner: number;
  capacity: number;
  orbitCount: readonly number[];
}

export interface TerritoryUnit {
  x: number;
  y: number;
  faction: number;
}

export interface TerritoryInput {
  planets: readonly TerritoryPlanet[];
  units: readonly TerritoryUnit[];
}

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

/** 이보다 약한 영향력은 '아무 땅도 아님' (중립과 같이 아무것도 그리지 않는다) */
const MIN_VALUE = 0.06;
/** 이만큼이면 완전히 칠한다. 행성 중심 세기(0.8~1.6)보다 조금 낮게 잡아 안쪽은 진하고 가장자리로 갈수록 옅어진다
 * (낮게 잡으면 땅 전체가 평평한 판처럼 칠해져 행성 둘이 붙은 영토가 각진 캡슐 모양으로 보인다) */
const FULL_VALUE = 1.1;
/** 전선의 세기: 양쪽 땅의 영향력 중 약한 쪽이 이만큼이면 완전한 전선 (땅 끝자락끼리 스친 곳은 옅게) */
const FRONT_FULL = 0.35;
/** 병력 한 기의 영향력과 한 칸의 상한: 군대는 전선을 밀어내지만 행성만큼 땅을 만들지는 못한다 */
const UNIT_WEIGHT = 0.035;
const UNIT_CELL_CAP = 0.5;
/** 영향력이 새 값으로 따라가는 시간 상수(초): 점령 직후 땅이 한 번에 뒤집히지 않고 스며든다 */
const SMOOTH_TAU = 0.35;
/** 채움의 최대 불투명도 (캔버스에 그릴 때 전체 투명도를 한 번 더 곱한다) */
const FILL_ALPHA = 0.55;

const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** 행성 하나의 영향 반경 (월드 단위): 클수록, 궤도 병력이 많을수록 멀리 미친다 */
export function planetReach(radius: number, garrison: number): number {
  return radius * 2.2 + 90 + Math.min(60, Math.sqrt(Math.max(0, garrison)) * 7);
}

/** 행성 중심에서의 세기: 크기(생산) + 정원 대비 궤도 병력 */
export function planetStrength(radius: number, garrison: number, capacity: number): number {
  return 0.6 + 0.4 * (radius / 34) + 0.5 * Math.min(1, garrison / Math.max(1, capacity));
}

export class TerritoryField {
  readonly cols: number;
  readonly rows: number;
  /** 칸마다 가진 진영 (0 = 없음) */
  readonly owner: Uint8Array;
  /** 칸마다 채움 세기 0~1 */
  readonly fill: Float32Array;
  /** 전선 선분 [x1, y1, x2, y2, 세기 0~1] 묶음 (월드 좌표). segments 개만 유효 */
  front = new Float32Array(0);
  segments = 0;
  /** 진영별 영향력 [진영 × 칸]. value 가 target 을 시간에 따라 따라간다 */
  private value: Float32Array;
  private target: Float32Array;
  private tmp: Float32Array;
  private primed = false;

  constructor(
    width: number,
    height: number,
    readonly factions: number,
    readonly cell = TERRITORY_CELL,
  ) {
    this.cols = Math.max(1, Math.ceil(width / cell));
    this.rows = Math.max(1, Math.ceil(height / cell));
    const n = this.cols * this.rows;
    this.owner = new Uint8Array(n);
    this.fill = new Float32Array(n);
    this.value = new Float32Array(n * factions);
    this.target = new Float32Array(n * factions);
    this.tmp = new Float32Array(n);
  }

  /** 진영 f 의 칸 i 영향력 (테스트 · 디버그용) */
  influence(f: number, i: number): number {
    return this.value[f * this.cols * this.rows + i];
  }

  /**
   * 다시 계산한다. dt = 직전 계산 뒤 흐른 시간(초): 영향력이 그만큼 새 값을 따라간다 (첫 계산은 바로 맞춘다).
   * blur = 진영별 영향력을 이웃 칸과 섞어 경계를 부드럽게 (품질 낮음에서는 끈다)
   */
  update(input: TerritoryInput, dt: number, blur: boolean): void {
    const { cols, rows, cell, factions } = this;
    const n = cols * rows;
    const t = this.target;
    t.fill(0);

    // 행성: 중심에서 반경 끝까지 매끄럽게 0 으로 줄어드는 언덕 (1 - (d/R)²)². 반경 밖은 아예 계산하지 않는다
    for (const p of input.planets) {
      const f = p.owner;
      if (f <= 0 || f >= factions) continue;
      const garrison = p.orbitCount[f] ?? 0;
      const reach = planetReach(p.radius, garrison);
      const strength = planetStrength(p.radius, garrison, p.capacity);
      const base = f * n;
      const c0 = Math.max(0, Math.floor((p.x - reach) / cell)), c1 = Math.min(cols - 1, Math.floor((p.x + reach) / cell));
      const r0 = Math.max(0, Math.floor((p.y - reach) / cell)), r1 = Math.min(rows - 1, Math.floor((p.y + reach) / cell));
      const inv = 1 / (reach * reach);
      for (let r = r0; r <= r1; r++) {
        const dy = (r + 0.5) * cell - p.y;
        for (let c = c0; c <= c1; c++) {
          const dx = (c + 0.5) * cell - p.x;
          const q = 1 - (dx * dx + dy * dy) * inv;
          if (q > 0) t[base + r * cols + c] += strength * q * q;
        }
      }
    }

    // 병력: 있는 칸에 조금씩 (중립 수비대는 행성이 대신 말해 준다)
    const u = this.tmp;
    for (let f = 1; f < factions; f++) {
      u.fill(0);
      let any = false;
      for (const un of input.units) {
        if (un.faction !== f) continue;
        const c = Math.floor(un.x / cell), r = Math.floor(un.y / cell);
        if (c < 0 || r < 0 || c >= cols || r >= rows) continue;
        u[r * cols + c] += UNIT_WEIGHT;
        any = true;
      }
      if (!any) continue;
      const base = f * n;
      for (let i = 0; i < n; i++) if (u[i] > 0) t[base + i] += Math.min(UNIT_CELL_CAP, u[i]);
    }

    if (blur) for (let f = 1; f < factions; f++) this.blur(t, f * n);

    // 시간에 따라 따라가기
    const v = this.value;
    if (!this.primed) {
      v.set(t);
      this.primed = true;
    } else {
      const k = 1 - Math.exp(-Math.max(0, dt) / SMOOTH_TAU);
      for (let i = 0; i < v.length; i++) v[i] += (t[i] - v[i]) * k;
    }

    // 칸마다 첫째 · 둘째 진영
    for (let i = 0; i < n; i++) {
      let best = 0, b1 = 0, b2 = 0;
      for (let f = 1; f < factions; f++) {
        const x = v[f * n + i];
        if (x > b1) {
          b2 = b1;
          b1 = x;
          best = f;
        } else if (x > b2) {
          b2 = x;
        }
      }
      if (b1 < MIN_VALUE) {
        this.owner[i] = 0;
        this.fill[i] = 0;
        continue;
      }
      this.owner[i] = best;
      this.fill[i] = smoothstep(MIN_VALUE, FULL_VALUE, b1);
    }
    this.traceFronts();
  }

  /**
   * 전선 선분 찾기 (마칭 스퀘어). 꼭짓점 = 칸 중심. 사각형의 네 변 중 양 끝 칸의 주인이 다른(둘 다 땅인) 변마다
   * 두 진영 a · b 의 영향력 차 (v_a − v_b) 가 0 이 되는 자리를 보간으로 찾는다. 그런 점이 둘이면 잇고,
   * 셋 이상(세 진영이 만나는 곳 · 안장점)이면 그 점들의 가운데로 모은다.
   */
  private traceFronts(): void {
    const { cols, rows, owner } = this;
    const v = this.value;
    const n = cols * rows;
    const cell = this.cell;
    const out: number[] = [];
    const px: number[] = [], py: number[] = [], pw: number[] = [];
    // 칸 i(주인 a) → 칸 j(주인 b) 변 위의 경계점
    const cross = (i: number, j: number, xi: number, yi: number, xj: number, yj: number) => {
      const a = owner[i], b = owner[j];
      if (a === 0 || b === 0 || a === b) return;
      const di = v[a * n + i] - v[b * n + i];
      const dj = v[a * n + j] - v[b * n + j];
      const t = di - dj > 1e-9 ? Math.max(0, Math.min(1, di / (di - dj))) : 0.5;
      px.push(xi + (xj - xi) * t);
      py.push(yi + (yj - yi) * t);
      pw.push(smoothstep(MIN_VALUE, FRONT_FULL, Math.min(v[a * n + i], v[b * n + j])));
    };
    for (let r = 0; r + 1 < rows; r++) {
      const y0 = (r + 0.5) * cell, y1 = y0 + cell;
      for (let c = 0; c + 1 < cols; c++) {
        const i00 = r * cols + c, i10 = i00 + 1, i01 = i00 + cols, i11 = i01 + 1;
        const o = owner[i00];
        // 네 칸 주인이 모두 같으면 경계 없음 (대부분의 사각형)
        if (owner[i10] === o && owner[i01] === o && owner[i11] === o) continue;
        const x0 = (c + 0.5) * cell, x1 = x0 + cell;
        px.length = py.length = pw.length = 0;
        cross(i00, i10, x0, y0, x1, y0);
        cross(i10, i11, x1, y0, x1, y1);
        cross(i11, i01, x1, y1, x0, y1);
        cross(i01, i00, x0, y1, x0, y0);
        const k = px.length;
        if (k === 2) {
          out.push(px[0], py[0], px[1], py[1], (pw[0] + pw[1]) / 2);
        } else if (k > 2) {
          let mx = 0, my = 0, mw = 0;
          for (let q = 0; q < k; q++) {
            mx += px[q] / k;
            my += py[q] / k;
            mw += pw[q] / k;
          }
          for (let q = 0; q < k; q++) out.push(px[q], py[q], mx, my, (pw[q] + mw) / 2);
        }
      }
    }
    this.segments = out.length / 5;
    if (this.front.length < out.length) this.front = new Float32Array(Math.max(out.length, this.front.length * 2));
    this.front.set(out);
  }

  /** 가로 · 세로로 [1 2 1] / 4 를 한 번씩 (진영 하나의 영향력 판) */
  private blur(a: Float32Array, base: number): void {
    const { cols, rows } = this;
    const tmp = this.tmp;
    for (let r = 0; r < rows; r++) {
      const row = base + r * cols;
      for (let c = 0; c < cols; c++) {
        const l = a[row + Math.max(0, c - 1)], m = a[row + c], rr = a[row + Math.min(cols - 1, c + 1)];
        tmp[r * cols + c] = (l + 2 * m + rr) * 0.25;
      }
    }
    for (let r = 0; r < rows; r++) {
      const up = Math.max(0, r - 1) * cols, dn = Math.min(rows - 1, r + 1) * cols, mid = r * cols;
      for (let c = 0; c < cols; c++) a[base + mid + c] = (tmp[up + c] + 2 * tmp[mid + c] + tmp[dn + c]) * 0.25;
    }
  }

  /** RGBA 픽셀(칸 하나 = 1px, 곱하지 않은 알파)로 칠한다. colors[진영] = 진영 색. 전선은 따로 선으로 그린다 */
  paint(out: Uint8ClampedArray, colors: readonly Rgb[]): void {
    const n = this.cols * this.rows;
    for (let i = 0; i < n; i++) {
      const o = i * 4;
      const f = this.owner[i];
      if (f === 0) {
        out[o + 3] = 0;
        continue;
      }
      const c = colors[f] ?? colors[0];
      out[o] = c.r;
      out[o + 1] = c.g;
      out[o + 2] = c.b;
      out[o + 3] = 255 * this.fill[i] * FILL_ALPHA;
    }
  }
}
