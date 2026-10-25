import { drawSprite, glowSprite, mixHex, softSprite, withAlpha } from './sprites';

// 짧게 살다 사라지는 시각 효과 전부 (레이저, 섬광, 불꽃, 파편, 연기, 충격파, 방어막 피격, 떠오르는 글자).
// 대규모 전투에서 초당 수천 개가 생기므로 입자는 고정 크기 배열(SoA)에 담아 객체를 만들지 않고,
// 그릴 때는 색 · 밝기 단계별로 경로를 묶어 한 번에 칠한다.

/** 월드 좌표의 보이는 영역 (여유 포함) */
export interface ViewRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export const inView = (v: ViewRect, x: number, y: number, pad = 0) =>
  x >= v.x0 - pad && x <= v.x1 + pad && y >= v.y0 - pad && y <= v.y1 + pad;

const SPARK = 0;
const DEBRIS = 1;
const FLASH = 2;
const SMOKE = 3;
const EMBER = 4;

/** 레이저 밝기 단계 수 (나이에 따라 묶어서 그린다) */
const BEAM_BUCKETS = 2;
const SPARK_BUCKETS = 3;

interface Beam {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  color: number;
  age: number;
  life: number;
}

interface Ring {
  x: number;
  y: number;
  r0: number;
  r1: number;
  width: number;
  color: string;
  age: number;
  life: number;
  glow: boolean;
}

interface Arc {
  x: number;
  y: number;
  r: number;
  angle: number;
  spread: number;
  color: string;
  age: number;
  life: number;
}

interface FloatText {
  x: number;
  y: number;
  text: string;
  color: string;
  age: number;
  life: number;
  size: number;
}

export class Effects {
  /** 색 문자열 ↔ 번호 (입자 배열에는 번호만 넣는다) */
  private colors: string[] = [];
  private hot: string[] = [];
  private colorIds = new Map<string, number>();

  private readonly cap: number;
  private n = 0;
  private px: Float32Array;
  private py: Float32Array;
  private vx: Float32Array;
  private vy: Float32Array;
  private age: Float32Array;
  private life: Float32Array;
  private size: Float32Array;
  private drag: Float32Array;
  private rot: Float32Array;
  private kind: Uint8Array;
  private col: Uint8Array;

  private beams: Beam[] = [];
  private beamCount = 0;
  private rings: Ring[] = [];
  private arcs: Arc[] = [];
  private texts: FloatText[] = [];

  constructor(capacity: number) {
    this.cap = capacity;
    this.px = new Float32Array(capacity);
    this.py = new Float32Array(capacity);
    this.vx = new Float32Array(capacity);
    this.vy = new Float32Array(capacity);
    this.age = new Float32Array(capacity);
    this.life = new Float32Array(capacity);
    this.size = new Float32Array(capacity);
    this.drag = new Float32Array(capacity);
    this.rot = new Float32Array(capacity);
    this.kind = new Uint8Array(capacity);
    this.col = new Uint8Array(capacity);
  }

  /** 입자 배열이 찬 비율 (LOD 판단용) */
  get load(): number {
    return this.n / this.cap;
  }

  colorId(hex: string): number {
    let id = this.colorIds.get(hex);
    if (id === undefined) {
      id = this.colors.length;
      // 255 색을 넘을 일은 없지만, 넘으면 마지막 색을 재사용한다
      if (id > 254) return 254;
      this.colors.push(hex);
      this.hot.push(mixHex(hex, '#ffffff', 0.55));
      this.colorIds.set(hex, id);
    }
    return id;
  }

  // ───────────────────────────── 생성 ─────────────────────────────

  private spawn(kind: number, x: number, y: number, vx: number, vy: number, life: number, size: number, color: number, drag: number): void {
    if (this.n >= this.cap) return;
    const i = this.n++;
    this.kind[i] = kind;
    this.px[i] = x;
    this.py[i] = y;
    this.vx[i] = vx;
    this.vy[i] = vy;
    this.age[i] = 0;
    this.life[i] = life;
    this.size[i] = size;
    this.col[i] = color;
    this.drag[i] = drag;
    this.rot[i] = Math.random() * Math.PI * 2;
  }

  /** 레이저: 짧게 번쩍이는 밝은 심 + 넓고 옅은 빛 */
  beam(x1: number, y1: number, x2: number, y2: number, color: string, life = 0.13): void {
    let b: Beam;
    if (this.beamCount < this.beams.length) {
      b = this.beams[this.beamCount];
    } else {
      if (this.beams.length >= 2000) return;
      b = { x1: 0, y1: 0, x2: 0, y2: 0, color: 0, age: 0, life: 0 };
      this.beams.push(b);
    }
    this.beamCount++;
    b.x1 = x1;
    b.y1 = y1;
    b.x2 = x2;
    b.y2 = y2;
    b.color = this.colorId(color);
    b.age = 0;
    b.life = life;
  }

  /** 발광 섬광 (총구, 착탄, 폭발 중심). size = 빛의 반경(월드) */
  flash(x: number, y: number, size: number, color: string, life: number): void {
    this.spawn(FLASH, x, y, 0, 0, life, size, this.colorId(color), 0);
  }

  /** 사방으로 튀는 불꽃 (뒤로 꼬리를 끄는 선). 감속(drag)이 커서 금방 멈춘다 */
  sparks(x: number, y: number, count: number, color: string, speed: number, life: number, dir = 0, spread = Math.PI * 2): void {
    const c = this.colorId(color);
    for (let i = 0; i < count; i++) {
      const a = dir + (Math.random() - 0.5) * spread;
      const s = speed * (0.45 + Math.random() * 0.75);
      this.spawn(SPARK, x, y, Math.cos(a) * s, Math.sin(a) * s, life * (0.6 + Math.random() * 0.6), 1, c, 4.5);
    }
  }

  /** 천천히 돌며 흩어지는 파편 조각 */
  debris(x: number, y: number, count: number, color: string, speed: number): void {
    const c = this.colorId(mixHex(color, '#1a1f2e', 0.35));
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2;
      const s = speed * (0.3 + Math.random() * 0.7);
      this.spawn(DEBRIS, x, y, Math.cos(a) * s, Math.sin(a) * s, 0.7 + Math.random() * 0.6, 0.9 + Math.random() * 0.8, c, 1.8);
    }
  }

  /** 빛나는 작은 불티 (생산 · 워프) */
  embers(x: number, y: number, count: number, color: string, speed: number, life: number): void {
    const c = this.colorId(color);
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2;
      const s = speed * (0.4 + Math.random() * 0.6);
      this.spawn(EMBER, x, y, Math.cos(a) * s, Math.sin(a) * s, life * (0.6 + Math.random() * 0.6), 1.2 + Math.random(), c, 3);
    }
  }

  /** 고립 병력이 흘리는 연기 (색 번호는 쓰지 않는다: 연기는 늘 같은 회색 스프라이트) */
  smoke(x: number, y: number, size: number): void {
    const a = Math.random() * Math.PI * 2;
    this.spawn(SMOKE, x, y, Math.cos(a) * 4, Math.sin(a) * 4 - 3, 0.9 + Math.random() * 0.5, size, 0, 1.2);
  }

  ring(x: number, y: number, r0: number, r1: number, color: string, life: number, width = 2, glow = true): void {
    if (this.rings.length >= 120) return;
    this.rings.push({ x, y, r0, r1, width, color, age: 0, life, glow });
  }

  /** 방어막 피격: 행성 둘레에 맞은 각도로 번쩍이는 호 */
  shieldArc(x: number, y: number, r: number, angle: number, color: string): void {
    if (this.arcs.length >= 160) return;
    this.arcs.push({ x, y, r, angle, spread: 0.3 + Math.random() * 0.2, color, age: 0, life: 0.38 });
  }

  text(x: number, y: number, text: string, color: string, size = 16, life = 1.6): void {
    if (this.texts.length >= 16) this.texts.shift();
    this.texts.push({ x, y, text, color, age: 0, life, size });
  }

  // ───────────────────────────── 갱신 ─────────────────────────────

  update(dt: number): void {
    // 입자: 죽은 것은 마지막 것과 바꿔 지운다 (순서는 상관없다)
    let i = 0;
    while (i < this.n) {
      const age = this.age[i] + dt;
      if (age >= this.life[i]) {
        const last = --this.n;
        if (i !== last) this.copy(last, i);
        continue;
      }
      this.age[i] = age;
      const k = Math.exp(-this.drag[i] * dt);
      this.vx[i] *= k;
      this.vy[i] *= k;
      this.px[i] += this.vx[i] * dt;
      this.py[i] += this.vy[i] * dt;
      this.rot[i] += dt * 6;
      i++;
    }

    let w = 0;
    for (let j = 0; j < this.beamCount; j++) {
      const b = this.beams[j];
      b.age += dt;
      if (b.age < b.life) {
        // 살아 있는 것을 앞으로 모은다 (객체는 버리지 않고 자리만 바꿔 재사용)
        if (w !== j) {
          this.beams[j] = this.beams[w];
          this.beams[w] = b;
        }
        w++;
      }
    }
    this.beamCount = w;

    this.rings = age(this.rings, dt);
    this.arcs = age(this.arcs, dt);
    this.texts = age(this.texts, dt);
  }

  private copy(from: number, to: number): void {
    this.kind[to] = this.kind[from];
    this.px[to] = this.px[from];
    this.py[to] = this.py[from];
    this.vx[to] = this.vx[from];
    this.vy[to] = this.vy[from];
    this.age[to] = this.age[from];
    this.life[to] = this.life[from];
    this.size[to] = this.size[from];
    this.col[to] = this.col[from];
    this.drag[to] = this.drag[from];
    this.rot[to] = this.rot[from];
  }

  // ───────────────────────────── 그리기 ─────────────────────────────

  /** 일반 합성: 연기, 파편 (병력 아래) */
  drawUnder(ctx: CanvasRenderingContext2D, view: ViewRect): void {
    const smoke = softSprite('#6f7584');
    const debrisPaths: (Path2D | undefined)[] = [];
    for (let i = 0; i < this.n; i++) {
      const k = this.kind[i];
      if (k !== SMOKE && k !== DEBRIS) continue;
      const x = this.px[i], y = this.py[i];
      if (!inView(view, x, y, 12)) continue;
      const t = this.age[i] / this.life[i];
      if (k === SMOKE) {
        const r = this.size[i] * (0.6 + t * 1.4);
        ctx.globalAlpha = 0.28 * (1 - t) * Math.min(1, t * 6);
        drawSprite(ctx, smoke, x, y, r);
      } else {
        const c = this.col[i];
        const p = debrisPaths[c] ?? (debrisPaths[c] = new Path2D());
        const s = this.size[i] * (1 - t * 0.6);
        const a = this.rot[i];
        const ca = Math.cos(a) * s, sa = Math.sin(a) * s;
        // 납작한 삼각형 조각
        p.moveTo(x + ca, y + sa);
        p.lineTo(x - ca * 0.6 - sa * 0.7, y - sa * 0.6 + ca * 0.7);
        p.lineTo(x - ca * 0.5 + sa * 0.5, y - sa * 0.5 - ca * 0.5);
        p.closePath();
      }
    }
    ctx.globalAlpha = 1;
    debrisPaths.forEach((p, c) => {
      if (!p) return;
      ctx.fillStyle = this.colors[c];
      ctx.fill(p);
    });
  }

  /** 가산 합성: 레이저, 섬광, 불꽃, 불티, 충격파, 방어막 호 (병력 위) */
  drawGlow(ctx: CanvasRenderingContext2D, view: ViewRect, zoom: number): void {
    ctx.globalCompositeOperation = 'lighter';
    const px = 1 / zoom;
    // 얇은 선은 둥근 끝이 보이지도 않으면서 소프트웨어 래스터에서는 꽤 비싸다
    ctx.lineCap = 'butt';

    // 레이저: 색 · 밝기 단계별로 묶어서 넓은 빛 → 밝은 심 순서로
    if (this.beamCount > 0) {
      const paths: (Path2D | undefined)[] = [];
      for (let j = 0; j < this.beamCount; j++) {
        const b = this.beams[j];
        if (Math.max(b.x1, b.x2) < view.x0 || Math.min(b.x1, b.x2) > view.x1 || Math.max(b.y1, b.y2) < view.y0 || Math.min(b.y1, b.y2) > view.y1) continue;
        const bucket = Math.min(BEAM_BUCKETS - 1, Math.floor((b.age / b.life) * BEAM_BUCKETS));
        const key = b.color * BEAM_BUCKETS + bucket;
        const p = paths[key] ?? (paths[key] = new Path2D());
        p.moveTo(b.x1, b.y1);
        p.lineTo(b.x2, b.y2);
      }
      const glowW = Math.max(4.5 * px, 2);
      const coreW = Math.max(1.4 * px, 0.6);
      paths.forEach((p, key) => {
        if (!p) return;
        const c = Math.floor(key / BEAM_BUCKETS);
        const fade = 1 - (key % BEAM_BUCKETS) / BEAM_BUCKETS;
        ctx.globalAlpha = 0.3 * fade;
        ctx.strokeStyle = this.colors[c];
        ctx.lineWidth = glowW;
        ctx.stroke(p);
        ctx.globalAlpha = 0.95 * fade;
        ctx.strokeStyle = this.hot[c];
        ctx.lineWidth = coreW;
        ctx.stroke(p);
      });
    }

    // 불꽃: 속도 방향으로 꼬리를 끄는 선 (감속하면서 저절로 짧아진다)
    const sparkPaths: (Path2D | undefined)[] = [];
    for (let i = 0; i < this.n; i++) {
      const k = this.kind[i];
      if (k !== SPARK) continue;
      const x = this.px[i], y = this.py[i];
      if (!inView(view, x, y, 10)) continue;
      const bucket = Math.min(SPARK_BUCKETS - 1, Math.floor((this.age[i] / this.life[i]) * SPARK_BUCKETS));
      const key = this.col[i] * SPARK_BUCKETS + bucket;
      const p = sparkPaths[key] ?? (sparkPaths[key] = new Path2D());
      const tail = 0.05;
      p.moveTo(x, y);
      p.lineTo(x - this.vx[i] * tail, y - this.vy[i] * tail);
    }
    ctx.lineWidth = Math.max(1.2 * px, 0.55);
    sparkPaths.forEach((p, key) => {
      if (!p) return;
      const c = Math.floor(key / SPARK_BUCKETS);
      ctx.globalAlpha = 1 - (key % SPARK_BUCKETS) / SPARK_BUCKETS;
      ctx.strokeStyle = this.hot[c];
      ctx.stroke(p);
    });

    // 섬광 · 불티: 미리 구운 발광 스프라이트
    for (let i = 0; i < this.n; i++) {
      const k = this.kind[i];
      if (k !== FLASH && k !== EMBER) continue;
      const x = this.px[i], y = this.py[i];
      if (!inView(view, x, y, 30)) continue;
      const t = this.age[i] / this.life[i];
      let r: number;
      if (k === FLASH) {
        r = this.size[i] * (0.75 + 0.5 * t);
        ctx.globalAlpha = (1 - t) * (1 - t) * 0.85;
      } else {
        r = Math.max(this.size[i], 1.6 * px);
        ctx.globalAlpha = 1 - t;
      }
      drawSprite(ctx, glowSprite(this.colors[this.col[i]]), x, y, r);
    }

    // 방어막 피격 호
    for (const a of this.arcs) {
      if (!inView(view, a.x, a.y, a.r + 10)) continue;
      const t = a.age / a.life;
      const spread = a.spread * (0.7 + t * 0.6);
      ctx.globalAlpha = (1 - t) * 0.45;
      ctx.strokeStyle = a.color;
      ctx.lineWidth = Math.max(6 * px, 4);
      ctx.beginPath();
      ctx.arc(a.x, a.y, a.r, a.angle - spread, a.angle + spread);
      ctx.stroke();
      ctx.globalAlpha = 1 - t;
      ctx.strokeStyle = mixHex(a.color, '#ffffff', 0.6);
      ctx.lineWidth = Math.max(1.6 * px, 1);
      ctx.beginPath();
      ctx.arc(a.x, a.y, a.r, a.angle - spread * 0.7, a.angle + spread * 0.7);
      ctx.stroke();
    }

    // 충격파 고리
    for (const r of this.rings) {
      if (!inView(view, r.x, r.y, Math.max(r.r0, r.r1) + 10)) continue;
      const t = r.age / r.life;
      const e = 1 - (1 - t) * (1 - t) * (1 - t);
      const rad = r.r0 + (r.r1 - r.r0) * e;
      if (r.glow) {
        ctx.globalAlpha = (1 - t) * 0.3;
        ctx.strokeStyle = r.color;
        ctx.lineWidth = (r.width * 3.5 * (1 - t * 0.5)) * px;
        ctx.beginPath();
        ctx.arc(r.x, r.y, Math.max(0.1, rad), 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.globalAlpha = (1 - t) * (r.glow ? 1 : 0.6);
      ctx.strokeStyle = r.glow ? mixHex(r.color, '#ffffff', 0.35) : r.color;
      ctx.lineWidth = r.width * (1 - t * 0.6) * px;
      ctx.beginPath();
      ctx.arc(r.x, r.y, Math.max(0.1, rad), 0, Math.PI * 2);
      ctx.stroke();
    }

    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }

  /** 떠오르며 사라지는 월드 글자 (행성 이름표 위) */
  drawTexts(ctx: CanvasRenderingContext2D, zoom: number): void {
    if (this.texts.length === 0) return;
    const px = 1 / zoom;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const t of this.texts) {
      const k = t.age / t.life;
      // 튀어나왔다가 천천히 떠오르며 사라진다
      const pop = k < 0.12 ? 0.6 + (k / 0.12) * 0.55 : 1.15 - Math.min(0.15, (k - 0.12) * 0.6);
      const rise = (1 - Math.pow(1 - k, 2)) * 26 * px * Math.max(1, zoom * 0.8);
      const a = k < 0.7 ? 1 : 1 - (k - 0.7) / 0.3;
      const size = t.size * pop * px;
      ctx.font = `800 ${size}px system-ui, sans-serif`;
      ctx.globalAlpha = a;
      ctx.lineWidth = 4 * px;
      ctx.strokeStyle = 'rgba(4,6,14,0.85)';
      ctx.strokeText(t.text, t.x, t.y - rise);
      ctx.shadowColor = withAlpha(t.color, 0.9);
      ctx.shadowBlur = 12;
      ctx.fillStyle = t.color;
      ctx.fillText(t.text, t.x, t.y - rise);
      ctx.shadowBlur = 0;
      ctx.shadowColor = 'transparent';
    }
    ctx.globalAlpha = 1;
  }
}

function age<T extends { age: number; life: number }>(list: T[], dt: number): T[] {
  let w = 0;
  for (const it of list) {
    it.age += dt;
    if (it.age < it.life) list[w++] = it;
  }
  list.length = w;
  return list;
}
