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
  /** 이 터치가 눈에 띄게 미끄러지던 관성 스크롤을 멈췄다: 떼어도 탭(선택/명령)으로 처리하지 않는다 */
  stoppedFling: boolean;
  /** 직전 탭을 뗀 직후 같은 자리를 다시 짚었다 (터치 더블탭 후보) */
  secondTap: boolean;
}

type Gesture = 'none' | 'pending' | 'box' | 'line' | 'pan' | 'pinch' | 'consumed';

const DRAG_THRESHOLD = 8;
const LONG_PRESS_MS = 450;
/** 마우스 더블클릭: 두 번째 클릭을 뗀 시각까지 */
const DOUBLE_MS = 320;
/**
 * 터치 더블탭: 첫 탭을 뗀 뒤 이 시간 안에 같은 자리를 다시 짚으면 더블탭.
 * 선택이 있을 때 한 번 탭의 명령은 더블탭이 아님이 확인될 때까지 이만큼 미뤄진다 (더블탭 = 선택만)
 */
const TOUCH_DOUBLE_MS = 250;
/** 더블클릭/탭에서 같은 자리로 보는 거리 (px) */
const DOUBLE_SLOP = 24;
/** 관성 스크롤이 이보다 빠를 때(화면 px/초) 화면을 짚으면 멈추기만 한다. 이보다 느리면 거의 멈춘 것으로 보고 탭도 처리 */
const STOP_FLING_MIN = 100;
/**
 * 두 손가락 이동 속도 표본의 최소 간격(초). 브라우저는 손가락마다 pointermove 를 0~0.1ms 간격으로 따로 보내므로
 * 그보다 가까운 표본은 이동량만 모아 다음 표본에 합친다 (0.1ms 로 나누면 수만 px/초가 된다)
 */
const VEL_MIN_DT = 0.004;
/** 손을 떼기 직전 이 시간(ms) 안에 움직였고 이보다 빨라야(화면 px/초) 관성으로 미끄러진다 */
const FLING_RECENT_MS = 80;
const FLING_MIN_SPEED = 80;
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
 * 두 손가락 이동 속도(화면 px/초)의 지수 평균. 마지막 몇 프레임만 반영되어 '던지는' 느낌이 산다.
 * 표본 시각은 이벤트 시각(e.timeStamp)을 쓴다: 같은 터치 이벤트에서 나온 손가락별 pointermove 는 시각이 같아 한 표본으로 합쳐진다.
 */
export class FlingTracker {
  vx = 0;
  vy = 0;
  /** 마지막 표본 시각 (ms) */
  private at = -Infinity;
  private accX = 0;
  private accY = 0;

  reset(): void {
    this.vx = this.vy = this.accX = this.accY = 0;
    this.at = -Infinity;
  }

  /** 이동량 (dx, dy) 를 시각 t(ms) 의 표본으로 더한다 */
  track(dx: number, dy: number, t: number): void {
    this.accX += dx;
    this.accY += dy;
    const dt = (t - this.at) / 1000;
    // 같은 이벤트 묶음: 시각을 옮기지 않고 이동량만 모은다
    if (dt < VEL_MIN_DT) return;
    if (dt < 0.1) {
      this.vx = this.vx * 0.5 + (this.accX / dt) * 0.5;
      this.vy = this.vy * 0.5 + (this.accY / dt) * 0.5;
    } else {
      // 한동안 멈춰 있었다: 새로 시작
      this.vx = this.vy = 0;
    }
    this.at = t;
    this.accX = this.accY = 0;
  }

  /** 시각 t(ms) 에 손을 뗐을 때의 관성 속도. 직전까지 움직이지 않았거나 느리면 null (속도 상한은 Camera.fling 이 자른다) */
  release(t: number): { vx: number; vy: number } | null {
    if (t - this.at > FLING_RECENT_MS || Math.hypot(this.vx, this.vy) <= FLING_MIN_SPEED) return null;
    return { vx: this.vx, vy: this.vy };
  }
}

/**
 * 마우스 · 터치 · 키보드를 Game 의 선택/명령 메서드로 연결한다.
 *
 * PC   : 좌드래그 선택 · 좌클릭 행성 선택 · 우클릭 명령 · 우드래그 횡대 · 휠 줌 · 가운데 드래그/가장자리 스크롤
 * 모바일: 한 손가락 드래그 선택 · 탭 명령(선택 없으면 행성 선택) · 더블탭 주변 선택 · 길게 눌러 행성 선택 · 두 손가락 이동/확대(관성)
 *
 * 캔버스에서 시작한 포인터만 다룬다 (미니맵 · HUD 에서 시작한 드래그는 window 로 와도 무시).
 */
export class InputController {
  private pointers = new Map<number, Pointer>();
  private gesture: Gesture = 'none';
  private longPressTimer = 0;
  private lastTap = { time: 0, x: 0, y: 0 };
  private pinch = { dist: 0, midX: 0, midY: 0 };
  /**
   * 핀치 중 손가락이 움직였는데 아직 화면에 반영하지 않음. 손가락마다 따로 오는 pointermove 를 하나씩 반영하면
   * 한 손가락만 움직인 중간 상태로 배율이 프레임 안에서 오락가락하므로, 위치만 기록하고 프레임마다 한 번 반영한다
   */
  private pinchDirty = false;
  /** 마지막 핀치 pointermove 의 이벤트 시각 (속도 표본 시각) */
  private pinchAt = 0;
  /** 두 손가락 이동 속도 추정 — 손을 뗄 때 관성으로 넘긴다 */
  private flingVel = new FlingTracker();
  /** 터치: 선택이 있을 때 한 번 탭의 명령을 더블탭인지 확인될 때까지 미뤄 둔 것 (월드 좌표는 탭한 순간 기준) */
  private pendingTap: { wx: number; wy: number; timer: number } | null = null;
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
    // 놓기(pointerup)가 사라진 경우 (드래그 중 alt-tab, OS 오버레이 등): 브라우저는 lostpointercapture 만 보낸다.
    // 정상적으로 뗀 뒤에도 오지만 그때는 onUp 이 이미 포인터를 지웠으므로 무시된다
    this.listen(canvas, 'lostpointercapture', (e) => {
      const pe = e as PointerEvent;
      if (this.pointers.has(pe.pointerId)) this.onCancel(pe);
    });
    // 캔버스 밖(HUD 버튼 · 미니맵)을 누르면 미뤄 둔 탭 명령부터 내린다: 그 버튼의 동작보다 먼저 한 탭이니까
    this.listen(window, 'pointerdown', (e) => {
      if (e.target !== canvas) this.flushTap();
    }, { capture: true });
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
      this.game.overlay.hint = null;
      this.game.overlay.hoverPlanet = -1;
    });
    let last = performance.now();
    const tick = (t: number) => {
      // 탭 전환 등으로 프레임이 크게 비면 한 번에 멀리 튀지 않게 자른다
      const dt = Math.min(0.1, (t - last) / 1000);
      last = t;
      this.applyPinch();
      this.panWithKeys(dt);
      this.edgeScroll(dt);
      this.refreshDrag();
      // 커서 힌트 · 행성 툴팁은 선택 · 목표 지정 · 대형 · 카메라 · 행성 주인에 따라 달라진다.
      // 마우스가 가만히 있어도 바뀌므로 마지막 마우스 위치로 매 프레임 다시 계산한다 (행성 찾기 두 번이라 싸다)
      if (this.mouse.inside) this.updateHover(this.mouse.x, this.mouse.y);
      this.keyLoop = requestAnimationFrame(tick);
    };
    this.keyLoop = requestAnimationFrame(tick);
  }

  dispose(): void {
    cancelAnimationFrame(this.keyLoop);
    window.clearTimeout(this.longPressTimer);
    this.cancelTap();
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
    // 화면을 짚으면 관성 스크롤은 멈춘다 (진행 중인 부드러운 이동은 그대로).
    // 눈에 띄게 미끄러지던 중이었다면 이 터치는 '멈춤' 손짓이므로 떼어도 탭으로 처리하지 않는다 (마우스는 관성이 없다)
    const stoppedFling = e.pointerType !== 'mouse' && cam.flingSpeed > STOP_FLING_MIN;
    cam.stopFling();
    if (e.pointerType !== 'mouse') this.mouse.inside = false;
    const a = cam.toWorld(x, y);
    const now = performance.now();
    const p: Pointer = {
      id: e.pointerId, type: e.pointerType, button: e.button,
      x, y, startX: x, startY: y, anchorX: a.x, anchorY: a.y, startTime: now, stoppedFling,
      secondTap: e.pointerType !== 'mouse' && now - this.lastTap.time < TOUCH_DOUBLE_MS && Math.hypot(x - this.lastTap.x, y - this.lastTap.y) < DOUBLE_SLOP,
    };
    this.pointers.set(e.pointerId, p);
    // 새 동작의 시작: 놓기를 놓쳐 남은 상자/선 미리보기가 있으면 지운다
    if (this.pointers.size === 1) {
      this.game.overlay.box = null;
      this.game.overlay.line = null;
    }
    // 미뤄 둔 탭 명령: 같은 자리를 곧바로 다시 짚었으면 더블탭일 수 있으니 이 손가락을 뗄 때 정한다. 아니면 지금 내린다
    if (this.pendingTap) {
      if (p.secondTap && this.pointers.size === 1) window.clearTimeout(this.pendingTap.timer);
      else this.flushTap();
    }

    if (p.type !== 'mouse') {
      if (this.pointers.size === 2) {
        // 두 번째 손가락: 지금까지의 동작을 취소하고 핀치로 전환
        window.clearTimeout(this.longPressTimer);
        this.game.overlay.box = null;
        this.gesture = 'pinch';
        this.pinch = this.pinchState();
        this.pinchDirty = false;
        this.flingVel.reset();
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
    // 버튼이 하나도 눌려 있지 않은데 드래그 중: 놓기를 놓쳤다 (lostpointercapture 를 보내지 않는 브라우저 대비)
    if (p.type === 'mouse' && e.buttons === 0) {
      this.onCancel(e);
      return;
    }
    const dx = x - p.x, dy = y - p.y;
    p.x = x;
    p.y = y;
    const moved = Math.hypot(x - p.startX, y - p.startY) > DRAG_THRESHOLD;

    switch (this.gesture) {
      case 'pinch':
        // 위치만 기록하고 화면은 프레임마다 한 번 (applyPinch)
        this.pinchDirty = true;
        this.pinchAt = e.timeStamp;
        return;
      case 'pan':
        this.game.camera.panScreen(dx, dy);
        return;
      case 'pending':
        if (!moved) return;
        window.clearTimeout(this.longPressTimer);
        // 탭이 아니라 드래그 선택이 됐다: 미뤄 둔 탭 명령은 지금 선택에 먼저 내린다
        this.flushTap();
        this.gesture = p.type === 'mouse' && p.button === 2 ? 'line' : 'box';
        break;
    }

    this.refreshDrag();
  }

  private onUp(e: PointerEvent): void {
    const p = this.pointers.get(e.pointerId);
    if (!p) return;
    // 이번 프레임에 아직 반영하지 않은 손가락 움직임부터 반영한다 (두 손가락이 다 있을 때 계산해야 한다)
    this.applyPinch();
    this.pointers.delete(e.pointerId);
    window.clearTimeout(this.longPressTimer);
    const g = this.game;
    const cam = g.camera;
    // 캡처 중에는 HUD 위에서도 캔버스로 왔으므로, 뗀 자리가 정말 캔버스 위인지 다시 본다 (매 프레임 힌트 갱신용)
    if (p.type === 'mouse') {
      this.mouse.inside = document.elementFromPoint(e.clientX, e.clientY) === this.canvas;
      if (!this.mouse.inside) {
        g.overlay.hint = null;
        g.overlay.hoverPlanet = -1;
      }
    }

    if (this.gesture === 'pinch') {
      // 손가락이 하나 남아도 탭으로 처리하지 않는다
      this.gesture = this.pointers.size > 0 ? 'consumed' : 'none';
      // 두 손가락을 움직이던 중에 뗐으면 그 속도로 미끄러진다
      const v = this.flingVel.release(e.timeStamp);
      if (v) cam.fling(v.vx, v.vy);
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
    // 관성 스크롤을 멈추려고 짚은 터치: 선택도 명령도 하지 않고, 더블탭의 첫 탭으로도 치지 않는다
    if (p.stoppedFling) {
      this.flushTap();
      return;
    }

    const w = cam.toWorld(p.x, p.y);
    const now = performance.now();

    if (p.type === 'mouse') {
      const isDouble = now - this.lastTap.time < DOUBLE_MS && Math.hypot(p.x - this.lastTap.x, p.y - this.lastTap.y) < DOUBLE_SLOP;
      this.lastTap = { time: isDouble ? 0 : now, x: p.x, y: p.y };
      if (p.button === 2 || g.overlay.targeting) g.commandAt(w.x, w.y);
      else if (p.button === 0) this.clickSelect(w.x, w.y, isDouble, additive);
      return;
    }

    // 터치 탭
    this.lastTap = { time: p.secondTap ? 0 : now, x: p.x, y: p.y };
    if (g.overlay.targeting) {
      this.flushTap();
      g.commandAt(w.x, w.y);
      // 목표 지정 탭을 곧바로 한 번 더 눌러도 더블탭 선택으로 선택이 바뀌지 않게
      this.lastTap.time = 0;
    } else if (p.secondTap) {
      // 더블탭은 선택만 한다: 첫 탭에서 미뤄 둔 명령은 버린다
      this.cancelTap();
      this.doubleSelect(w.x, w.y);
    } else if (g.selection.size > 0) {
      // 곧 두 번째 탭이 오면 더블탭(선택)이므로, 명령은 더블탭 시간이 지난 뒤에 내린다
      this.flushTap();
      this.pendingTap = { wx: w.x, wy: w.y, timer: window.setTimeout(() => this.flushTap(), TOUCH_DOUBLE_MS) };
    } else {
      this.flushTap();
      this.clickSelect(w.x, w.y, false, false);
    }
  }

  private onCancel(e: PointerEvent): void {
    this.pointers.delete(e.pointerId);
    window.clearTimeout(this.longPressTimer);
    // 더블탭 후보였던 터치가 취소됐으면 첫 탭의 명령은 그대로 내린다
    this.flushTap();
    if (this.pointers.size === 0) {
      this.gesture = 'none';
      this.game.overlay.box = null;
      this.game.overlay.line = null;
    } else if (this.gesture === 'pinch') {
      // 손가락 하나만 남은 핀치: onUp 과 같이 남은 손가락은 탭으로 처리하지 않는다
      this.gesture = 'consumed';
    }
  }

  private onLongPress(p: Pointer): void {
    if (this.gesture !== 'pending' || this.pointers.size !== 1) return;
    this.gesture = 'consumed';
    this.flushTap();
    const w = this.game.camera.toWorld(p.x, p.y);
    navigator.vibrate?.(12);
    this.clickSelect(w.x, w.y, false, false);
  }

  /** 미뤄 둔 탭 명령을 지금 내린다 (없으면 아무것도 안 함) */
  private flushTap(): void {
    const t = this.pendingTap;
    if (!t) return;
    this.cancelTap();
    this.game.commandAt(t.wx, t.wy);
  }

  /** 미뤄 둔 탭 명령을 버린다 */
  private cancelTap(): void {
    if (!this.pendingTap) return;
    window.clearTimeout(this.pendingTap.timer);
    this.pendingTap = null;
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

  /** 핀치: 기록해 둔 두 손가락 위치로 확대/이동을 한 번에 반영하고 이동 속도 표본을 남긴다 (매 프레임 · 손을 뗄 때) */
  private applyPinch(): void {
    if (!this.pinchDirty || this.gesture !== 'pinch' || this.pointers.size < 2) return;
    this.pinchDirty = false;
    const cam = this.game.camera;
    const s = this.pinchState();
    if (this.pinch.dist > 0) cam.zoomAt(s.midX, s.midY, s.dist / this.pinch.dist);
    const mdx = s.midX - this.pinch.midX, mdy = s.midY - this.pinch.midY;
    cam.panScreen(mdx, mdy);
    this.flingVel.track(mdx, mdy, this.pinchAt);
    this.pinch = s;
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

  /** 더블 클릭/탭: 행성 주변 또는 지점 주변의 아군 전부. 주변에 아군이 없으면 지금 선택을 그대로 둔다 */
  private doubleSelect(x: number, y: number): void {
    const g = this.game;
    const p = g.world.planetAt(x, y);
    const cx = p ? p.x : x, cy = p ? p.y : y;
    const r = p ? p.atmosphereRadius + 40 : 70;
    // selectNear(…, false) 는 아무도 없으면 선택을 비우므로 먼저 확인한다 (터치에선 선택이 곧 다음 탭의 명령 대상)
    if (g.world.units.some((u) => u.faction === PLAYER && Math.hypot(u.x - cx, u.y - cy) <= r)) g.selectNear(cx, cy, r, false);
  }

  /** 커서 위치의 행성 툴팁과 '지금 명령하면 일어날 일' 힌트 (이동 · 매 프레임) */
  private updateHover(sx: number, sy: number): void {
    const g = this.game;
    const w = g.camera.toWorld(sx, sy);
    const p = g.world.planetAt(w.x, w.y, 6);
    g.overlay.hoverPlanet = p ? p.id : -1;
    const label = g.overlay.targeting ? `목표 지정 · ${g.describeCommandAt(w.x, w.y) ?? ''}` : g.describeCommandAt(w.x, w.y);
    const h = g.overlay.hint;
    if (!label || this.gesture === 'box') g.overlay.hint = null;
    else if (!h || h.x !== sx || h.y !== sy || h.label !== label) g.overlay.hint = { x: sx, y: sy, label };
  }

  // ───────────────────────────── 키보드 ─────────────────────────────

  private onKeyDown(e: KeyboardEvent): void {
    if (e.target instanceof HTMLInputElement) return;
    const g = this.game;
    // 키보드 명령보다 먼저 한 탭이므로 미뤄 둔 탭 명령부터 내린다 (순서가 뒤바뀌지 않게)
    this.flushTap();
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
  }
}
