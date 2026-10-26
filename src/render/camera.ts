export interface Insets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface View {
  x: number;
  y: number;
  zoom: number;
}

/** 맵 가장자리 밖으로 보여줄 수 있는 최대 여백(월드 단위) */
const EDGE_MARGIN = 120;
const MAX_ZOOM = 3.2;
/** 한 판 시작 배율: 보이는 영역의 짧은 변에 월드 이만큼이 들어오게 */
const DEFAULT_SPAN = 520;
/** 프로그램 이동(미니맵 탭, 모성 보기 등)이 목표로 수렴하는 속도 (1/초) */
const EASE_RATE = 10;
/** 두 손가락 이동 관성의 감쇠 (1/초) */
const FLING_DECAY = 4.5;
/** 관성 시작 속도 상한 (화면 px/초): 속도 추정이 튀어도 맵 끝까지 날아가지 않게. 이 속도로 약 900px 미끄러진다 */
const MAX_FLING = 4000;

/**
 * 월드 ↔ 화면 좌표 변환. (x, y) 는 화면 중앙에 오는 월드 좌표.
 *
 * 프로그램 이동은 target 을 바꾸고 update() 가 매 프레임 지수적으로 따라간다.
 * 직접 조작(드래그 · 핀치 · 휠 · 가장자리 스크롤)은 손을 따라와야 하므로 현재값과 target 을 함께 바꾼다.
 */
export class Camera {
  x = 0;
  y = 0;
  zoom = 1;
  /** CSS 픽셀 단위 뷰포트 크기 */
  width = 1;
  height = 1;
  minZoom = 0.2;
  maxZoom = MAX_ZOOM;
  readonly target: View = { x: 0, y: 0, zoom: 1 };

  private vx = 0;
  private vy = 0;
  private worldW = 1000;
  private worldH = 1000;
  private insets: Insets = { top: 0, right: 0, bottom: 0, left: 0 };

  resize(width: number, height: number): void {
    this.width = width;
    this.height = height;
  }

  /** 맵 크기와 HUD 여백. 화면이 바뀌어도 보고 있던 곳을 계속 보도록 중심을 유지한 채 다시 맞춘다 */
  setBounds(worldW: number, worldH: number, insets: Insets): void {
    const cur = this.centerOf(this);
    const tgt = this.centerOf(this.target);
    this.worldW = worldW;
    this.worldH = worldH;
    this.insets = { ...insets };
    // 조금 더 멀리까지 빼서 맵 전체가 여유 있게 들어오게 한다
    this.minZoom = this.fitZoom() * 0.9;
    this.maxZoom = Math.max(MAX_ZOOM, this.minZoom);
    this.assign(this, this.place(cur.x, cur.y, this.zoom));
    this.assign(this.target, this.place(tgt.x, tgt.y, this.target.zoom));
  }

  /** HUD 를 뺀, 전장이 실제로 보이는 화면 영역 (CSS px) */
  viewRect(): { left: number; top: number; right: number; bottom: number } {
    const { top, right, bottom, left } = this.insets;
    return { left, top, right: this.width - right, bottom: this.height - bottom };
  }

  /** 맵 전체가 보이는 영역에 꼭 맞는 배율 */
  fitZoom(): number {
    return Math.min(this.viewW / this.worldW, this.viewH / this.worldH);
  }

  /** 한 판의 기본 배율: 맵 일부를 크게 본다 (전체는 미니맵 · 전체 보기로) */
  defaultZoom(): number {
    const z = Math.min(1.6, Math.max(0.7, Math.min(this.viewW, this.viewH) / DEFAULT_SPAN));
    return this.clampZoom(z);
  }

  /** 지금 보이는 영역 중심의 월드 좌표 */
  viewCenter(): { x: number; y: number } {
    return this.centerOf(this);
  }

  /** 이동이 끝났을 때 보이는 영역 중심의 월드 좌표 */
  targetCenter(): { x: number; y: number } {
    return this.centerOf(this.target);
  }

  // ───────────────────────────── 프로그램 이동 ─────────────────────────────

  /** 보이는 영역 중심에 (cx, cy) 가 오도록 부드럽게 이동 */
  moveTo(cx: number, cy: number, zoom = this.target.zoom): void {
    this.stopFling();
    this.assign(this.target, this.place(cx, cy, zoom));
  }

  /**
   * 즉시 이동 (미니맵 드래그). zoom 을 주지 않으면 진행 중인 확대 애니메이션은 그대로 두고
   * 위치만 바로 옮긴다 — 전체 보기에서 미니맵을 끌면 손은 바로 따라오고 배율만 부드럽게 당겨진다.
   */
  jumpTo(cx: number, cy: number, zoom?: number): void {
    this.stopFling();
    this.assign(this, this.place(cx, cy, zoom ?? this.zoom));
    this.assign(this.target, this.place(cx, cy, zoom ?? this.target.zoom));
  }

  update(dt: number): void {
    if ((this.vx !== 0 || this.vy !== 0) && dt > 0) {
      const bx = this.x, by = this.y;
      this.panBy(this.vx * dt, this.vy * dt);
      // 맵 끝에 막힌 축의 관성은 없앤다: 화면은 멈췄는데 속도만 남아 있으면 flingSpeed 가 '아직 미끄러지는 중'이라고 답한다
      if (Math.abs(this.x - bx) < 1e-6) this.vx = 0;
      if (Math.abs(this.y - by) < 1e-6) this.vy = 0;
      const decay = Math.exp(-FLING_DECAY * dt);
      this.vx *= decay;
      this.vy *= decay;
      if (Math.hypot(this.vx, this.vy) < 15) this.stopFling();
    }
    const t = this.target;
    if (t.x === this.x && t.y === this.y && t.zoom === this.zoom) return;
    // 프레임 속도와 무관한 지수 접근
    const k = 1 - Math.exp(-EASE_RATE * dt);
    this.x += (t.x - this.x) * k;
    this.y += (t.y - this.y) * k;
    // 배율은 비율로 보간해야 확대/축소 속도가 고르게 느껴진다
    this.zoom *= Math.pow(t.zoom / this.zoom, k);
    const arrived =
      Math.abs(t.x - this.x) * this.zoom < 0.3 && Math.abs(t.y - this.y) * this.zoom < 0.3 && Math.abs(t.zoom / this.zoom - 1) < 0.002;
    if (arrived) this.assign(this, t);
  }

  // ───────────────────────────── 직접 조작 ─────────────────────────────

  panScreen(dx: number, dy: number): void {
    this.stopFling();
    this.panBy(dx, dy);
  }

  /** 화면 좌표 (sx, sy) 를 고정점으로 확대/축소 */
  zoomAt(sx: number, sy: number, factor: number): void {
    this.stopFling();
    const before = this.toWorld(sx, sy);
    this.zoom = this.clampZoom(this.zoom * factor);
    const after = this.toWorld(sx, sy);
    this.x += before.x - after.x;
    this.y += before.y - after.y;
    this.settle();
  }

  /** 두 손가락 이동을 놓은 뒤의 관성 (화면 px/초, MAX_FLING 으로 자른다) */
  fling(vx: number, vy: number): void {
    const s = Math.hypot(vx, vy);
    const k = s > MAX_FLING ? MAX_FLING / s : 1;
    this.vx = vx * k;
    this.vy = vy * k;
  }

  /** 지금 관성으로 미끄러지는 속도 (화면 px/초, 0 = 멈춤) */
  get flingSpeed(): number {
    return Math.hypot(this.vx, this.vy);
  }

  stopFling(): void {
    this.vx = 0;
    this.vy = 0;
  }

  // ───────────────────────────── 변환 ─────────────────────────────

  toScreen(wx: number, wy: number): { x: number; y: number } {
    return { x: (wx - this.x) * this.zoom + this.width / 2, y: (wy - this.y) * this.zoom + this.height / 2 };
  }

  toWorld(sx: number, sy: number): { x: number; y: number } {
    return { x: (sx - this.width / 2) / this.zoom + this.x, y: (sy - this.height / 2) / this.zoom + this.y };
  }

  // ───────────────────────────── 내부 ─────────────────────────────

  private get viewW(): number {
    return Math.max(50, this.width - this.insets.left - this.insets.right);
  }

  private get viewH(): number {
    return Math.max(50, this.height - this.insets.top - this.insets.bottom);
  }

  private clampZoom(z: number): number {
    return Math.min(this.maxZoom, Math.max(this.minZoom, z));
  }

  private panBy(dx: number, dy: number): void {
    this.x -= dx / this.zoom;
    this.y -= dy / this.zoom;
    this.settle();
  }

  /** 직접 조작 뒤: 경계 안으로 넣고, 진행 중이던 프로그램 이동은 취소한다 */
  private settle(): void {
    const c = this.centerOf(this);
    this.assign(this, this.place(c.x, c.y, this.zoom));
    this.assign(this.target, this);
  }

  /** 인셋이 비대칭이면 화면 중앙과 보이는 영역의 중심이 다르다 */
  private centerOf(v: View): { x: number; y: number } {
    const { top, right, bottom, left } = this.insets;
    return { x: v.x + (left - right) / 2 / v.zoom, y: v.y + (top - bottom) / 2 / v.zoom };
  }

  /** 보이는 영역 중심을 (cx, cy) 에 두는 카메라 상태. 맵 밖이 너무 많이 보이지 않게 막는다 */
  private place(cx: number, cy: number, zoom: number): View {
    const z = this.clampZoom(zoom);
    const { top, right, bottom, left } = this.insets;
    const ax = clampAxis(cx, this.viewW / 2 / z, this.worldW);
    const ay = clampAxis(cy, this.viewH / 2 / z, this.worldH);
    return { x: ax - (left - right) / 2 / z, y: ay - (top - bottom) / 2 / z, zoom: z };
  }

  private assign(to: View, from: View): void {
    to.x = from.x;
    to.y = from.y;
    to.zoom = from.zoom;
  }
}

/**
 * 한 축의 중심 위치 제한. 보이는 폭이 맵보다 좁으면 맵 밖 여백을 EDGE_MARGIN 까지만 허용하고
 * (많이 확대했을 땐 화면의 절반까지만 — 빈 우주만 보이는 일이 없게), 넓으면 맵을 가운데 둔다.
 */
function clampAxis(c: number, half: number, size: number): number {
  const m = Math.min(EDGE_MARGIN, half * 0.5);
  const lo = half - m;
  const hi = size - half + m;
  return lo > hi ? size / 2 : Math.min(hi, Math.max(lo, c));
}
