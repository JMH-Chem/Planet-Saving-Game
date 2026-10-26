import type { Game } from '../game';
import { NEUTRAL, PLAYER } from '../sim/types';
import type { Alerts } from '../ui/alerts';
import { withAlpha } from './renderer';

/** 병력 · 행성 층을 다시 그리는 빈도. 시점 사각형과 핑은 위에 겹친 캔버스에 매 프레임 그린다 */
const BASE_FPS = 12;
/** 미니맵 안쪽 여백(px): 가장자리 행성 · 게이트 표시가 잘리지 않게 */
const PAD = 5;
/** 병력 점은 이 수까지만 그린다 (넘으면 고르게 건너뛴다) */
const MAX_DOTS = 2500;
/** 이만큼 움직이면 탭이 아니라 드래그 (손가락은 떨림이 커서 더 넉넉하게 — 목표 지정 탭이 드래그로 사라지지 않게) */
const DRAG_PX = { mouse: 4, touch: 8 };
const TWO_PI = Math.PI * 2;
const GATE_FALLBACK_COLOR = '#f472d0';

interface Ping {
  x: number;
  y: number;
  color: string;
  age: number;
}

/**
 * 오른쪽 아래 미니맵: 맵 전체(행성 · 병력 · 워프 게이트 · 알림 핑)와 지금 보고 있는 영역.
 * 탭/클릭 = 그곳으로 부드럽게 이동, 드래그 = 바로 따라 이동, 우클릭 = 선택 병력에 그 지점 명령.
 * 목표 지정(전체 공격) 중에는 탭/클릭이 그 지점 명령이고, 드래그는 여전히 화면 이동이다 (목표를 찾아 둘러볼 수 있게).
 *
 * 캔버스 두 장을 겹친다: 아래(#minimap)는 병력 · 행성을 BASE_FPS 로만, 위(투명)는 시점 사각형 · 핑을 매 프레임.
 * 한 장에 매 프레임 drawImage 로 합성하는 것보다 싸다 (합성은 브라우저가 한다).
 */
export class Minimap {
  /** 병력/행성 층 */
  private ctx: CanvasRenderingContext2D;
  /** 시점 사각형 · 게이트 · 핑 층 (입력은 아래 캔버스가 받는다) */
  private top = document.createElement('canvas');
  private tctx: CanvasRenderingContext2D;
  /** CSS px 크기 (테두리 제외) */
  private w = 1;
  private h = 1;
  private dpr = 1;
  private border = 0;
  /** 월드 → 미니맵 배율과 원점 */
  private scale = 1;
  private ox = PAD;
  private oy = PAD;
  private clock = 0;
  private baseAge = Infinity;
  private drawn = { x: NaN, y: NaN, zoom: NaN };
  private wasAnimating = false;
  private pings: Ping[] = [];
  private drag: { id: number; sx: number; sy: number; slop: number; dragging: boolean } | null = null;
  private disposers: (() => void)[] = [];
  /**
   * 지금 devicePixelRatio 에만 맞는 미디어 쿼리. 창 크기는 그대로 배율만 바뀌면(배율이 다른 모니터로 창을 옮기는 등)
   * resize 가 오지 않는 브라우저가 있어, 이 쿼리가 풀리면 다시 맞추고 새 배율로 다시 건다
   */
  private dprQuery: MediaQueryList | null = null;
  private readonly onDprChange = () => this.layout();

  constructor(
    private canvas: HTMLCanvasElement,
    private game: Game,
    private alerts: Alerts | null = null,
  ) {
    this.ctx = canvas.getContext('2d')!;
    this.tctx = this.top.getContext('2d')!;
    this.top.className = 'minimap-top';
    this.top.setAttribute('aria-hidden', 'true');
    canvas.after(this.top);
    this.listen('pointerdown', (e) => this.onDown(e as PointerEvent));
    this.listen('pointermove', (e) => this.onMove(e as PointerEvent));
    this.listen('pointerup', (e) => this.onUp(e as PointerEvent));
    this.listen('pointercancel', () => (this.drag = null));
    // 놓기를 놓친 드래그 (alt-tab 등): 남아 있으면 버튼 없이 미니맵 위를 지나가기만 해도 화면이 따라간다
    this.listen('lostpointercapture', (e) => {
      if (this.drag?.id === (e as PointerEvent).pointerId) this.drag = null;
    });
    this.listen('contextmenu', (e) => e.preventDefault());
    this.listen('wheel', (e) => this.onWheel(e as WheelEvent), { passive: false });
  }

  dispose(): void {
    for (const d of this.disposers) d();
    this.disposers = [];
    this.dprQuery?.removeEventListener('change', this.onDprChange);
    this.dprQuery = null;
    this.top.remove();
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  /** 화면 크기 변화 시: 크기는 CSS 변수(--mm-w, --mm-max-h)가 정하고, 비율은 맵을 따른다 */
  layout(): void {
    const cs = getComputedStyle(this.canvas);
    const maxW = parseFloat(cs.getPropertyValue('--mm-w')) || 200;
    const maxH = parseFloat(cs.getPropertyValue('--mm-max-h')) || 200;
    const { width: W, height: H } = this.game.world;
    let s = (maxW - PAD * 2) / W;
    if (H * s + PAD * 2 > maxH) s = (maxH - PAD * 2) / H;
    this.scale = s;
    this.w = Math.round(W * s + PAD * 2);
    this.h = Math.round(H * s + PAD * 2);
    this.ox = (this.w - W * s) / 2;
    this.oy = (this.h - H * s) / 2;
    this.border = parseFloat(cs.borderLeftWidth) || 0;
    this.canvas.style.width = `${this.w + this.border * 2}px`;
    this.canvas.style.height = `${this.h + this.border * 2}px`;
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.watchDpr();
    for (const c of [this.canvas, this.top]) {
      c.width = Math.round(this.w * this.dpr);
      c.height = Math.round(this.h * this.dpr);
    }
    // 위 캔버스는 아래 캔버스의 테두리 안쪽에 정확히 겹친다
    Object.assign(this.top.style, { left: `${this.border}px`, top: `${this.border}px`, width: `${this.w}px`, height: `${this.h}px` });
    // 데스크톱에서 명령 바가 미니맵을 피해 남은 폭의 가운데에 오도록, 미니맵이 차지하는 오른쪽 폭을 알린다
    const rect = this.canvas.getBoundingClientRect();
    this.canvas.closest<HTMLElement>('#hud')?.style.setProperty('--minimap-reserve', `${Math.ceil(window.innerWidth - rect.left + 12)}px`);
    this.baseAge = Infinity;
    this.drawn.x = NaN;
  }

  private watchDpr(): void {
    const media = `(resolution: ${window.devicePixelRatio || 1}dppx)`;
    if (this.dprQuery?.media === media) return;
    this.dprQuery?.removeEventListener('change', this.onDprChange);
    this.dprQuery = window.matchMedia(media);
    this.dprQuery.addEventListener('change', this.onDprChange);
  }

  /** 미니맵 위 짧은 표시 (미니맵으로 내린 명령 지점 등) */
  ping(x: number, y: number, color: string): void {
    this.pings.push({ x, y, color, age: 0 });
  }

  update(dt: number): void {
    this.clock += dt;
    this.baseAge += dt;
    let dirty = false;
    if (this.baseAge >= 1 / BASE_FPS) {
      this.baseAge = 0;
      this.drawBase();
    }
    const cam = this.game.camera;
    const d = this.drawn;
    if (cam.x !== d.x || cam.y !== d.y || cam.zoom !== d.zoom) {
      d.x = cam.x;
      d.y = cam.y;
      d.zoom = cam.zoom;
      dirty = true;
    }
    for (const p of this.pings) p.age += dt;
    if (this.pings.length > 0) this.pings = this.pings.filter((p) => p.age < 0.7);
    // 핑이 막 끝난 프레임에도 한 번 더 지워야 하므로 직전 프레임에 그린 것이 있었는지도 본다
    const animating = this.pings.length > 0 || this.game.world.gates.length > 0 || (this.alerts?.list.length ?? 0) > 0;
    if (dirty || animating || this.wasAnimating) this.drawTop();
    this.wasAnimating = animating;
  }

  // ───────────────────────────── 그리기 ─────────────────────────────

  private drawBase(): void {
    const ctx = this.ctx;
    const world = this.game.world;
    const { scale: s, ox, oy } = this;
    const mw = world.width * s, mh = world.height * s;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.w, this.h);

    // 맵 영역 + 옅은 격자 (어디쯤인지 감을 잡게)
    ctx.fillStyle = 'rgba(120,160,255,0.04)';
    ctx.fillRect(ox, oy, mw, mh);
    ctx.fillStyle = 'rgba(160,190,255,0.06)';
    for (let gx = 250; gx < world.width; gx += 250) ctx.fillRect(Math.round(ox + gx * s), oy, 1, mh);
    for (let gy = 250; gy < world.height; gy += 250) ctx.fillRect(ox, Math.round(oy + gy * s), mw, 1);

    // 대기권 후광 → 병력 → 행성 순: 행성 색이 궤도 병력에 묻히지 않게 행성을 위에 그린다
    for (const p of world.planets) {
      ctx.beginPath();
      ctx.arc(ox + p.x * s, oy + p.y * s, p.atmosphereRadius * s, 0, TWO_PI);
      ctx.fillStyle = withAlpha(world.factions[p.owner].color, p.owner === NEUTRAL ? 0.05 : 0.12);
      ctx.fill();
    }

    // 중립 병력은 행성 궤도를 지키는 수비대뿐이라 행성 자체가 대신 보여준다 (점까지 찍으면 행성이 번져 보인다)
    const units = world.units;
    const step = Math.max(1, Math.ceil(units.length / MAX_DOTS));
    const dot = this.dpr >= 2 ? 1.5 : 2;
    const half = dot / 2;
    for (const f of world.factions) {
      if (f.id === NEUTRAL || !world.unitCount[f.id]) continue;
      ctx.beginPath();
      for (let i = 0; i < units.length; i += step) {
        const u = units[i];
        if (u.faction === f.id) ctx.rect(ox + u.x * s - half, oy + u.y * s - half, dot, dot);
      }
      ctx.fillStyle = f.color;
      ctx.fill();
    }

    // 공격받는 행성은 공격자 색 테두리가 깜박인다
    const blinkOn = Math.sin(this.clock * TWO_PI * 2.5) > 0;
    for (const p of world.planets) {
      const x = ox + p.x * s, y = oy + p.y * s;
      // 실제 비율보다 조금 크게: 미니맵에서는 크기 차이보다 '어디에 누구 행성이 있나'가 중요하다
      const r = Math.max(2.5, p.radius * s * 1.2);
      const color = world.factions[p.owner].color;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, TWO_PI);
      ctx.fillStyle = p.owner === NEUTRAL ? '#5d6572' : color;
      ctx.fill();
      if (p.owner === NEUTRAL) {
        ctx.lineWidth = 1;
        ctx.strokeStyle = 'rgba(207,214,223,0.45)';
        ctx.stroke();
      }
      if (p.isHome && p.owner !== NEUTRAL) {
        ctx.beginPath();
        ctx.arc(x, y, Math.max(1, r * 0.35), 0, TWO_PI);
        ctx.fillStyle = 'rgba(5,6,13,0.75)';
        ctx.fill();
      }
      if (p.owner === PLAYER) {
        ctx.beginPath();
        ctx.arc(x, y, r + 1.25, 0, TWO_PI);
        ctx.lineWidth = 1;
        ctx.strokeStyle = 'rgba(255,255,255,0.85)';
        ctx.stroke();
      }
      if (blinkOn && world.time - p.lastAssaultAt < 0.6 && p.lastAssaultBy !== p.owner) {
        ctx.beginPath();
        ctx.arc(x, y, r + 3, 0, TWO_PI);
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = world.factions[p.lastAssaultBy]?.color ?? '#ff5d5d';
        ctx.stroke();
      }
    }
  }

  private drawTop(): void {
    const ctx = this.tctx;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.w, this.h);
    this.drawGates();
    this.drawAlertPings();
    this.drawViewport();
  }

  /** 방어전 워프 게이트: 예고 중에는 느리게, 병력이 나오기 시작하면 빠르게 맥동 */
  private drawGates(): void {
    const world = this.game.world;
    if (world.gates.length === 0) return;
    const ctx = this.tctx;
    const color = world.factions.find((f) => f.invader)?.color ?? world.factions[2]?.color ?? GATE_FALLBACK_COLOR;
    for (const g of world.gates) {
      const x = this.ox + g.x * this.scale, y = this.oy + g.y * this.scale;
      const active = world.time >= g.spawnAt;
      const t = (this.clock * (active ? 1.8 : 0.9)) % 1;
      ctx.beginPath();
      ctx.arc(x, y, 3 + t * (active ? 9 : 7), 0, TWO_PI);
      ctx.lineWidth = 1.25;
      ctx.strokeStyle = withAlpha(color, 0.85 * (1 - t));
      ctx.stroke();
      const r = active ? 4 : 3.2;
      ctx.beginPath();
      ctx.moveTo(x, y - r);
      ctx.lineTo(x + r, y);
      ctx.lineTo(x, y + r);
      ctx.lineTo(x - r, y);
      ctx.closePath();
      ctx.fillStyle = color;
      ctx.fill();
      ctx.lineWidth = 1;
      ctx.strokeStyle = 'rgba(255,255,255,0.7)';
      ctx.stroke();
    }
  }

  /** 알림 위치에 퍼져 나가는 고리. 막 생긴 알림은 크게 두 겹, 이후엔 작게 계속 */
  private drawAlertPings(): void {
    const ctx = this.tctx;
    const s = this.scale;
    ctx.lineWidth = 1.5;
    if (this.alerts) {
      for (const a of this.alerts.list) {
        const x = this.ox + a.x * s, y = this.oy + a.y * s;
        const fresh = this.alerts.now - a.born < 3;
        for (let k = 0; k < (fresh ? 2 : 1); k++) {
          const t = (this.clock / 1.3 + k * 0.5) % 1;
          ctx.globalAlpha = (1 - t) * (fresh ? 0.95 : 0.55);
          ctx.beginPath();
          ctx.arc(x, y, 3 + t * (fresh ? 15 : 9), 0, TWO_PI);
          ctx.strokeStyle = a.color;
          ctx.stroke();
        }
      }
    }
    for (const p of this.pings) {
      const t = p.age / 0.7;
      ctx.globalAlpha = 1 - t;
      ctx.beginPath();
      ctx.arc(this.ox + p.x * s, this.oy + p.y * s, 8 - t * 6, 0, TWO_PI);
      ctx.strokeStyle = p.color;
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  /** 지금 보이는 영역 (HUD 를 뺀 부분) — 미니맵 밖으로 나가는 부분은 테두리에 붙인다 */
  private drawViewport(): void {
    const ctx = this.tctx;
    const cam = this.game.camera;
    const v = cam.viewRect();
    const a = cam.toWorld(v.left, v.top);
    const b = cam.toWorld(v.right, v.bottom);
    const s = this.scale;
    const lim = 0.75;
    const x0 = Math.max(lim, this.ox + a.x * s), y0 = Math.max(lim, this.oy + a.y * s);
    const x1 = Math.min(this.w - lim, this.ox + b.x * s), y1 = Math.min(this.h - lim, this.oy + b.y * s);
    if (x1 <= x0 || y1 <= y0) return;
    ctx.fillStyle = 'rgba(255,255,255,0.07)';
    ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = 'rgba(255,255,255,0.9)';
    ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
  }

  // ───────────────────────────── 입력 ─────────────────────────────

  private listen(type: string, fn: (e: Event) => void, opts?: AddEventListenerOptions): void {
    this.canvas.addEventListener(type, fn, opts);
    this.disposers.push(() => this.canvas.removeEventListener(type, fn, opts));
  }

  private toWorld(e: MouseEvent): { x: number; y: number } {
    const r = this.canvas.getBoundingClientRect();
    const { width: W, height: H } = this.game.world;
    const x = (e.clientX - r.left - this.border - this.ox) / this.scale;
    const y = (e.clientY - r.top - this.border - this.oy) / this.scale;
    return { x: Math.min(W, Math.max(0, x)), y: Math.min(H, Math.max(0, y)) };
  }

  private onDown(e: PointerEvent): void {
    e.preventDefault();
    // RTS 관례: 미니맵 우클릭 = 그 지점으로 명령 (누르는 순간)
    if (e.pointerType === 'mouse' && e.button === 2) {
      this.command(this.toWorld(e));
      return;
    }
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    // 목표 지정 중이어도 여기서 바로 명령하지 않는다: 탭인지 드래그(둘러보기)인지는 뗄 때 안다
    this.canvas.setPointerCapture?.(e.pointerId);
    this.drag = { id: e.pointerId, sx: e.clientX, sy: e.clientY, slop: e.pointerType === 'mouse' ? DRAG_PX.mouse : DRAG_PX.touch, dragging: false };
  }

  private onMove(e: PointerEvent): void {
    const d = this.drag;
    if (!d || d.id !== e.pointerId) return;
    const p = this.toWorld(e);
    if (!d.dragging) {
      if (Math.hypot(e.clientX - d.sx, e.clientY - d.sy) < d.slop) return;
      d.dragging = true;
      // 전체 보기 상태였다면 배율은 부드럽게 당겨오고, 위치는 아래 jumpTo 로 손을 바로 따라간다
      this.game.focusOn(p.x, p.y);
    }
    this.game.camera.jumpTo(p.x, p.y);
  }

  private onUp(e: PointerEvent): void {
    const d = this.drag;
    if (!d || d.id !== e.pointerId) return;
    this.drag = null;
    // 드래그는 화면만 옮긴다 (목표 지정은 그대로 남아 다음 탭이 목표가 된다)
    if (d.dragging) return;
    const p = this.toWorld(e);
    // 목표 지정(전체 공격) 중의 탭/클릭 = 그 지점 명령. 뗄 때 다시 보므로 누른 사이 Esc 로 취소했으면 그냥 이동
    if (this.game.overlay.targeting) this.command(p);
    else this.game.focusOn(p.x, p.y);
  }

  private command(p: { x: number; y: number }): void {
    const g = this.game;
    if (g.commandAt(p.x, p.y)) this.ping(p.x, p.y, g.world.factions[PLAYER].color);
  }

  /** 미니맵 위 휠 = 보이는 영역 중심 기준 확대/축소 */
  private onWheel(e: WheelEvent): void {
    e.preventDefault();
    const cam = this.game.camera;
    const v = cam.viewRect();
    cam.zoomAt((v.left + v.right) / 2, (v.top + v.bottom) / 2, Math.exp(-e.deltaY * 0.0015));
  }
}
