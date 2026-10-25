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
  startTime: number;
}

type Gesture = 'none' | 'pending' | 'box' | 'line' | 'pan' | 'pinch' | 'consumed';

const DRAG_THRESHOLD = 8;
const LONG_PRESS_MS = 450;
const DOUBLE_MS = 320;

export interface InputHooks {
  /** 키보드 단축키 중 UI 쪽에서 처리해야 하는 것 (일시정지, 대형 표시 등) */
  onKey?: (action: 'pause' | 'formation' | 'speed') => void;
}

/**
 * 마우스 · 터치 · 키보드를 Game 의 선택/명령 메서드로 연결한다.
 *
 * PC   : 좌드래그 선택 · 좌클릭 행성 선택 · 우클릭 명령 · 우드래그 횡대 · 휠 줌 · 가운데 드래그 이동
 * 모바일: 한 손가락 드래그 선택 · 탭 명령(선택 없으면 행성 선택) · 길게 눌러 행성 선택 · 두 손가락 이동/확대
 */
export class InputController {
  private pointers = new Map<number, Pointer>();
  private gesture: Gesture = 'none';
  private longPressTimer = 0;
  private lastTap = { time: 0, x: 0, y: 0 };
  private pinch = { dist: 0, midX: 0, midY: 0 };
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
    });
    this.listen(window, 'keydown', (e) => this.onKeyDown(e as KeyboardEvent));
    this.listen(window, 'keyup', (e) => this.keysDown.delete((e as KeyboardEvent).code));
    this.listen(window, 'blur', () => this.keysDown.clear());
    let last = performance.now();
    const tick = (t: number) => {
      this.panWithKeys((t - last) / 1000);
      last = t;
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
    const p: Pointer = { id: e.pointerId, type: e.pointerType, button: e.button, x, y, startX: x, startY: y, startTime: performance.now() };
    this.pointers.set(e.pointerId, p);

    if (p.type !== 'mouse') {
      if (this.pointers.size === 2) {
        // 두 번째 손가락: 지금까지의 동작을 취소하고 핀치로 전환
        window.clearTimeout(this.longPressTimer);
        this.game.overlay.box = null;
        this.gesture = 'pinch';
        this.pinch = this.pinchState();
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
      if (e.target === this.canvas) this.updateHover(x, y);
      else this.game.overlay.hint = null;
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
        cam.panScreen(s.midX - this.pinch.midX, s.midY - this.pinch.midY);
        cam.clampTo(this.game.world.width, this.game.world.height);
        this.pinch = s;
        return;
      }
      case 'pan':
        cam.panScreen(dx, dy);
        cam.clampTo(this.game.world.width, this.game.world.height);
        return;
      case 'pending':
        if (!moved) return;
        window.clearTimeout(this.longPressTimer);
        this.gesture = p.type === 'mouse' && p.button === 2 ? 'line' : 'box';
        break;
    }

    if (this.gesture === 'box') {
      this.game.overlay.box = { x0: p.startX, y0: p.startY, x1: x, y1: y };
    } else if (this.gesture === 'line') {
      const a = cam.toWorld(p.startX, p.startY);
      const b = cam.toWorld(x, y);
      this.game.overlay.line = { x1: a.x, y1: a.y, x2: b.x, y2: b.y };
    }
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
      return;
    }
    if (this.pointers.size > 0) return;

    const gesture = this.gesture;
    this.gesture = 'none';
    const additive = e.shiftKey;

    if (gesture === 'box') {
      const a = cam.toWorld(p.startX, p.startY);
      const b = cam.toWorld(p.x, p.y);
      g.selectInRect(a.x, a.y, b.x, b.y, additive);
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
    this.game.camera.clampTo(this.game.world.width, this.game.world.height);
  }

  private pinchState() {
    const [a, b] = [...this.pointers.values()];
    return { dist: Math.hypot(a.x - b.x, a.y - b.y), midX: (a.x + b.x) / 2, midY: (a.y + b.y) / 2 };
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
      if (e.ctrlKey || e.metaKey) g.assignGroup(n);
      else g.recallGroup(n);
      e.preventDefault();
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
      case 'Space':
        e.preventDefault();
        this.hooks.onKey?.('pause');
        break;
      case 'Tab':
        e.preventDefault();
        this.hooks.onKey?.('speed');
        break;
      case 'KeyH':
        g.fitCamera();
        break;
    }
  }

  private panWithKeys(dt: number): void {
    if (this.keysDown.size === 0) return;
    const k = this.keysDown;
    const v = 600 * dt;
    const dx = (k.has('ArrowLeft') ? v : 0) - (k.has('ArrowRight') ? v : 0);
    const dy = (k.has('ArrowUp') ? v : 0) - (k.has('ArrowDown') ? v : 0);
    if (dx || dy) {
      this.game.camera.panScreen(dx, dy);
      this.game.camera.clampTo(this.game.world.width, this.game.world.height);
    }
  }
}
