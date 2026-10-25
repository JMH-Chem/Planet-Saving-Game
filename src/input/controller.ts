import type { Game } from '../game';
import { PLAYER } from '../sim/types';

interface Pointer {
  id: number;
  type: string;
  button: number;
  x: number;
  y: number;
  startX: number;
  startY: number;
  /** 누른 지점의 월드 좌표. 드래그 중 화면이 스크롤돼도 상자/선의 시작점이 전장에 붙어 있게 한다 */
  anchorX: number;
  anchorY: number;
  startTime: number;
}

type Gesture = 'none' | 'pending' | 'box' | 'line' | 'pan' | 'pinch' | 'consumed';

const DRAG_THRESHOLD = 8;
const LONG_PRESS_MS = 450;
const DOUBLE_MS = 320;
/** 같은 부대 번호를 이 시간 안에 두 번 누르면 그 부대로 화면 이동 */
const GROUP_FOCUS_MS = 350;
/** 마우스 가장자리 스크롤: 화면 끝에서 이 거리(px) 안이면 스크롤 */
const EDGE_PX = 14;
/** 가장자리 스크롤 속도 (화면 px/초) */
const EDGE_SPEED = 900;
const KEY_PAN_SPEED = 600;

export interface InputHooks {
  /** 키보드 단축키 중 UI 쪽에서 처리해야 하는 것 (일시정지, 대형 표시, 알림 위치 등) */
  onKey?: (action: 'pause' | 'formation' | 'speed' | 'alert') => void;
}

/**
 * 마우스 · 터치 · 키보드를 Game 의 선택/명령 메서드로 연결한다.
 *
 * PC   : 좌드래그 선택 · 좌클릭 행성 선택 · 우클릭 명령 · 우드래그 횡대 · 휠 줌 · 가운데 드래그/가장자리 스크롤
 * 모바일: 한 손가락 드래그 선택 · 탭 명령(선택 없으면 행성 선택) · 길게 눌러 행성 선택 · 두 손가락 이동/확대(관성)
 *
 * 캔버스에서 시작한 포인터만 다룬다 (미니맵 · HUD 에서 시작한 드래그는 window 로 와도 무시).
 */
export class InputController {
  private pointers = new Map<number, Pointer>();
  private gesture: Gesture = 'none';
  private longPressTimer = 0;
  private lastTap = { time: 0, x: 0, y: 0 };
  private pinch = { dist: 0, midX: 0, midY: 0 };
  /** 두 손가락 이동 속도 추정 (화면 px/초) — 손을 뗄 때 관성으로 넘긴다 */
  private pinchVel = { vx: 0, vy: 0, at: 0 };
  /**
   * 마지막 마우스 위치 (캔버스 기준). inside = 캔버스 위에 있음 (HUD · 미니맵 위면 false).
   * moved = 실제로 움직인 적이 있음: 브라우저는 로드/레이아웃 변경 때 제자리 가짜 pointermove 를 보내므로
   * 그것만으로는 가장자리 스크롤을 켜지 않는다.
   */
  private mouse = { x: 0, y: 0, inside: false, seen: false, moved: false };
  private edgeHold = 0;
  /** 마우스처럼 hover 가 되는 입력 장치가 있을 때만 가장자리 스크롤 (터치 전용 기기에선 가짜 mouse 이벤트에 반응하지 않게) */
  private readonly canHover = window.matchMedia('(any-hover: hover)').matches;
  private lastDigit = { n: 0, at: 0 };
  private keysDown = new Set<string>();
  private keyLoop = 0;
  private disposers: (() => void)[] = [];

  constructor(
    private canvas: HTMLCanvasElement,
    private game: Game,
    private hooks: InputHooks = {},
  ) {
    this.listen(canvas, 'pointerdown', (e) => this.onDown(e as PointerEvent));
    this.listen(window, 'pointermove', (e) => this.onMove(e as PointerEvent));
    this.listen(window, 'pointerup', (e) => this.onUp(e as PointerEvent));
    this.listen(window, 'pointercancel', (e) => this.onCancel(e as PointerEvent));
    this.listen(canvas, 'wheel', (e) => this.onWheel(e as WheelEvent), { passive: false });
    this.listen(canvas, 'contextmenu', (e) => e.preventDefault());
    this.listen(canvas, 'pointerleave', () => {
      this.game.overlay.hint = null;
      this.game.overlay.hoverPlanet = -1;
      this.mouse.inside = false;
    });
    this.listen(window, 'keydown', (e) => this.onKeyDown(e as KeyboardEvent));
    this.listen(window, 'keyup', (e) => this.keysDown.delete((e as KeyboardEvent).code));
    this.listen(window, 'blur', () => {
      this.keysDown.clear();
      this.mouse.inside = false;
    });
    let last = performance.now();
    const tick = (t: number) => {
      // 탭 전환 등으로 프레임이 크게 비면 한 번에 멀리 튀지 않게 자른다
      const dt = Math.min(0.1, (t - last) / 1000);
      last = t;
      this.panWithKeys(dt);
      this.edgeScroll(dt);
      this.refreshDrag();
      this.keyLoop = requestAnimationFrame(tick);
    };
    this.keyLoop = requestAnimationFrame(tick);
  }

  dispose(): void {
    cancelAnimationFrame(this.keyLoop);
    window.clearTimeout(this.longPressTimer);
    for (const d of this.disposers) d();
  }

  private listen(target: EventTarget, type: string, fn: (e: Event) => void, opts?: AddEventListenerOptions): void {
    target.addEventListener(type, fn, opts);
    this.disposers.push(() => target.removeEventListener(type, fn, opts));
  }

  private local(e: { clientX: number; clientY: number }) {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  // ───────────────────────────── 포인터 ─────────────────────────────

  private onDown(e: PointerEvent): void {
    e.preventDefault();
    this.canvas.setPointerCapture?.(e.pointerId);
    const { x, y } = this.local(e);
    const cam = this.game.camera;
    // 화면을 짚으면 관성 스크롤은 멈춘다 (진행 중인 부드러운 이동은 그대로)
    cam.stopFling();
    if (e.pointerType !== 'mouse') this.mouse.inside = false;
    const a = cam.toWorld(x, y);
    const p: Pointer = {
      id: e.pointerId, type: e.pointerType, button: e.button,
      x, y, startX: x, startY: y, anchorX: a.x, anchorY: a.y, startTime: performance.now(),
    };
    this.pointers.set(e.pointerId, p);

    if (p.type !== 'mouse') {
      if (this.pointers.size === 2) {
        // 두 번째 손가락: 지금까지의 동작을 취소하고 핀치로 전환
        window.clearTimeout(this.longPressTimer);
        this.game.overlay.box = null;
        this.gesture = 'pinch';
        this.pinch = this.pinchState();
        this.pinchVel = { vx: 0, vy: 0, at: 0 };
      } else if (this.pointers.size === 1) {
        this.gesture = 'pending';
        this.longPressTimer = window.setTimeout(() => this.onLongPress(p), LONG_PRESS_MS);
      }
      return;
    }
    this.gesture = e.button === 1 ? 'pan' : 'pending';
  }

  private onMove(e: PointerEvent): void {
    const { x, y } = this.local(e);
    const p = this.pointers.get(e.pointerId);
    if (e.pointerType === 'mouse') {
      // 캡처 중에는 target 이 캔버스로 고정되므로, 드래그 중엔 HUD 위로 지나가도 가장자리 스크롤이 이어진다
      const m = this.mouse;
      if (m.seen && (m.x !== x || m.y !== y)) m.moved = true;
      m.seen = true;
      m.x = x;
      m.y = y;
      m.inside = e.target === this.canvas;
      if (m.inside) {
        this.updateHover(x, y);
      } else {
        this.game.overlay.hint = null;
        this.game.overlay.hoverPlanet = -1;
      }
    }
    if (!p) return;
    const dx = x - p.x, dy = y - p.y;
    p.x = x;
    p.y = y;
    const moved = Math.hypot(x - p.startX, y - p.startY) > DRAG_THRESHOLD;
    const cam = this.game.camera;

    switch (this.gesture) {
      case 'pinch': {
        const s = this.pinchState();
        if (this.pinch.dist > 0) cam.zoomAt(s.midX, s.midY, s.dist / this.pinch.dist);
        const mdx = s.midX - this.pinch.midX, mdy = s.midY - this.pinch.midY;
        cam.panScreen(mdx, mdy);
        this.trackPinchVelocity(mdx, mdy);
        this.pinch = s;
        return;
      }
      case 'pan':
        cam.panScreen(dx, dy);
        return;
      case 'pending':
        if (!moved) return;
        window.clearTimeout(this.longPressTimer);
        this.gesture = p.type === 'mouse' && p.button === 2 ? 'line' : 'box';
        break;
    }

    this.refreshDrag();
  }

  private onUp(e: PointerEvent): void {
    const p = this.pointers.get(e.pointerId);
    if (!p) return;
    this.pointers.delete(e.pointerId);
    window.clearTimeout(this.longPressTimer);
    const g = this.game;
    const cam = g.camera;

    if (this.gesture === 'pinch') {
      // 손가락이 하나 남아도 탭으로 처리하지 않는다
      this.gesture = this.pointers.size > 0 ? 'consumed' : 'none';
      // 두 손가락을 움직이던 중에 뗐으면 그 속도로 미끄러진다
      const v = this.pinchVel;
      if (performance.now() - v.at < 80 && Math.hypot(v.vx, v.vy) > 80) cam.fling(v.vx, v.vy);
      return;
    }
    if (this.pointers.size > 0) return;

    const gesture = this.gesture;
    this.gesture = 'none';
    const additive = e.shiftKey;

    if (gesture === 'box') {
      const b = cam.toWorld(p.x, p.y);
      g.selectInRect(p.anchorX, p.anchorY, b.x, b.y, additive);
      g.overlay.box = null;
      return;
    }
    if (gesture === 'line') {
      const l = g.overlay.line;
      g.overlay.line = null;
      if (l) g.commandLine(l.x1, l.y1, l.x2, l.y2);
      return;
    }
    if (gesture !== 'pending') return;

    const w = cam.toWorld(p.x, p.y);
    const now = performance.now();
    const isDouble = now - this.lastTap.time < DOUBLE_MS && Math.hypot(p.x - this.lastTap.x, p.y - this.lastTap.y) < 24;
    this.lastTap = { time: isDouble ? 0 : now, x: p.x, y: p.y };

    if (p.type === 'mouse') {
      if (p.button === 2 || g.overlay.targeting) g.commandAt(w.x, w.y);
      else if (p.button === 0) this.clickSelect(w.x, w.y, isDouble, additive);
      return;
    }

    // 터치 탭
    if (g.overlay.targeting) {
      g.commandAt(w.x, w.y);
    } else if (isDouble) {
      this.doubleSelect(w.x, w.y);
    } else if (g.selection.size > 0) {
      g.commandAt(w.x, w.y);
    } else {
      this.clickSelect(w.x, w.y, false, false);
    }
  }

  private onCancel(e: PointerEvent): void {
    this.pointers.delete(e.pointerId);
    window.clearTimeout(this.longPressTimer);
    if (this.pointers.size === 0) {
      this.gesture = 'none';
      this.game.overlay.box = null;
      this.game.overlay.line = null;
    }
  }

  private onLongPress(p: Pointer): void {
    if (this.gesture !== 'pending' || this.pointers.size !== 1) return;
    this.gesture = 'consumed';
    const w = this.game.camera.toWorld(p.x, p.y);
    navigator.vibrate?.(12);
    this.clickSelect(w.x, w.y, false, false);
  }

  private onWheel(e: WheelEvent): void {
    e.preventDefault();
    const { x, y } = this.local(e);
    this.game.camera.zoomAt(x, y, Math.exp(-e.deltaY * 0.0015));
  }

  private pinchState() {
    const [a, b] = [...this.pointers.values()];
    return { dist: Math.hypot(a.x - b.x, a.y - b.y), midX: (a.x + b.x) / 2, midY: (a.y + b.y) / 2 };
  }

  /** 손가락 이동 속도의 지수 평균. 마지막 몇 프레임만 반영되어 '던지는' 느낌이 산다 */
  private trackPinchVelocity(dx: number, dy: number): void {
    const now = performance.now();
    const v = this.pinchVel;
    const dt = (now - v.at) / 1000;
    if (v.at > 0 && dt > 0 && dt < 0.1) {
      v.vx = v.vx * 0.5 + (dx / dt) * 0.5;
      v.vy = v.vy * 0.5 + (dy / dt) * 0.5;
    } else {
      v.vx = 0;
      v.vy = 0;
    }
    v.at = now;
  }

  /**
   * 드래그 상자/횡대 선 미리보기 갱신. 시작점은 월드에 고정돼 있으므로 화면이 스크롤되면
   * 포인터가 가만히 있어도 다시 계산해야 한다 (매 프레임 호출).
   */
  private refreshDrag(): void {
    if (this.gesture !== 'box' && this.gesture !== 'line') return;
    let p: Pointer | undefined;
    for (const q of this.pointers.values()) p = q;
    if (!p) return;
    const cam = this.game.camera;
    if (this.gesture === 'box') {
      const a = cam.toScreen(p.anchorX, p.anchorY);
      this.game.overlay.box = { x0: a.x, y0: a.y, x1: p.x, y1: p.y };
    } else {
      const b = cam.toWorld(p.x, p.y);
      this.game.overlay.line = { x1: p.anchorX, y1: p.anchorY, x2: b.x, y2: b.y };
    }
  }

  // ───────────────────────────── 선택 규칙 ─────────────────────────────

  /** 클릭/탭 선택: 아군 행성 → 궤도 병력, 빈 곳 → 근처 병력, 아무것도 없으면 해제 */
  private clickSelect(x: number, y: number, isDouble: boolean, additive: boolean): void {
    const g = this.game;
    if (isDouble) {
      this.doubleSelect(x, y);
      return;
    }
    const p = g.world.planetAt(x, y);
    if (p && p.owner === PLAYER) {
      g.selectPlanet(p, additive);
      return;
    }
    const radius = 18 / g.camera.zoom;
    if (g.selectNear(x, y, radius, additive) === 0 && !additive) g.clearSelection();
  }

  /** 더블 클릭/탭: 행성 주변 또는 지점 주변의 아군 전부 */
  private doubleSelect(x: number, y: number): void {
    const g = this.game;
    const p = g.world.planetAt(x, y);
    if (p) g.selectNear(p.x, p.y, p.atmosphereRadius + 40, false);
    else g.selectNear(x, y, 70, false);
  }

  private updateHover(sx: number, sy: number): void {
    const g = this.game;
    const w = g.camera.toWorld(sx, sy);
    const p = g.world.planetAt(w.x, w.y, 6);
    g.overlay.hoverPlanet = p ? p.id : -1;
    const label = g.overlay.targeting ? `목표 지정 · ${g.describeCommandAt(w.x, w.y) ?? ''}` : g.describeCommandAt(w.x, w.y);
    g.overlay.hint = label && this.gesture !== 'box' ? { x: sx, y: sy, label } : null;
  }

  // ───────────────────────────── 키보드 ─────────────────────────────

  private onKeyDown(e: KeyboardEvent): void {
    if (e.target instanceof HTMLInputElement) return;
    const g = this.game;
    this.keysDown.add(e.code);
    const digit = /^Digit([1-9])$/.exec(e.code);
    if (digit) {
      const n = Number(digit[1]);
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) {
        g.assignGroup(n);
        return;
      }
      if (e.repeat) return;
      const now = performance.now();
      const twice = this.lastDigit.n === n && now - this.lastDigit.at < GROUP_FOCUS_MS;
      this.lastDigit = { n, at: twice ? 0 : now };
      if (g.recallGroup(n) && twice) g.focusSelection();
      return;
    }
    switch (e.code) {
      case 'KeyA':
        if (e.ctrlKey || e.metaKey) e.preventDefault();
        g.selectAll();
        break;
      case 'Escape':
        g.clearSelection();
        break;
      case 'KeyQ':
        g.halveSelection();
        break;
      case 'KeyF':
        this.hooks.onKey?.('formation');
        break;
      case 'KeyG':
        g.attackAll();
        break;
      case 'KeyR':
        g.commandReturn();
        break;
      case 'KeyP':
        e.preventDefault();
        this.hooks.onKey?.('pause');
        break;
      case 'Space':
        // 방금 누른 HUD 버튼에 포커스가 남아 있으면 Space 가 그 버튼을 다시 누르므로 막는다
        e.preventDefault();
        if (document.activeElement instanceof HTMLButtonElement) document.activeElement.blur();
        if (!e.repeat) this.hooks.onKey?.('alert');
        break;
      case 'Tab':
        e.preventDefault();
        this.hooks.onKey?.('speed');
        break;
      case 'KeyH':
        if (!e.repeat) g.focusHome();
        break;
      case 'KeyZ':
        if (!e.repeat && !e.ctrlKey && !e.metaKey) g.toggleOverview();
        break;
    }
  }

  private panWithKeys(dt: number): void {
    if (this.keysDown.size === 0) return;
    const k = this.keysDown;
    const v = KEY_PAN_SPEED * dt;
    const dx = (k.has('ArrowLeft') ? v : 0) - (k.has('ArrowRight') ? v : 0);
    const dy = (k.has('ArrowUp') ? v : 0) - (k.has('ArrowDown') ? v : 0);
    if (dx || dy) this.game.camera.panScreen(dx, dy);
  }

  /**
   * 마우스를 화면 가장자리에 대면 그쪽으로 스크롤. 캔버스 위에 있을 때만 (HUD 버튼 · 미니맵 위는 제외),
   * 드래그 선택/횡대 긋기 중에는 포인터가 HUD 위나 창 밖으로 나가도 계속 — 큰 상자와 긴 선을 그릴 수 있게.
   */
  private edgeScroll(dt: number): void {
    const m = this.mouse;
    // 마우스로 그리는 상자/선만 해당 (터치 드래그는 손가락이 가장자리에 닿아도 스크롤하지 않는다)
    let dragging = false;
    if (this.gesture === 'box' || this.gesture === 'line') {
      for (const p of this.pointers.values()) dragging = p.type === 'mouse';
      if (!dragging) {
        this.edgeHold = 0;
        return;
      }
    }
    const cam = this.game.camera;
    const dx = m.x <= EDGE_PX ? 1 : m.x >= cam.width - EDGE_PX ? -1 : 0;
    const dy = m.y <= EDGE_PX ? 1 : m.y >= cam.height - EDGE_PX ? -1 : 0;
    const active =
      this.canHover && m.moved && (dx !== 0 || dy !== 0) && (m.inside || dragging) && this.gesture !== 'pan' && document.hasFocus();
    if (!active) {
      this.edgeHold = 0;
      return;
    }
    // 버튼을 누르러 가다 가장자리를 스치는 정도로는 크게 움직이지 않도록 짧게 가속한다
    this.edgeHold += dt;
    const v = EDGE_SPEED * Math.min(1, 0.3 + this.edgeHold * 3) * dt;
    cam.panScreen(dx * v, dy * v);
    if (m.inside && !dragging) this.updateHover(m.x, m.y);
  }
}
