import { CONFIG } from './config';
import { Camera, type Insets, type View } from './render/camera';
import { Renderer, type OverlayState } from './render/renderer';
import { Match, type MatchSettings } from './sim/match';
import { PLAYER, type Formation, type GameEvent, type Order, type Planet } from './sim/types';

export interface GameHooks {
  /** 매 프레임 시뮬레이션 이벤트 전달 (토스트 등) */
  onEvents?: (events: readonly GameEvent[]) => void;
  onSelectionChange?: (count: number) => void;
  onEnd?: (winner: number) => void;
  /** 매 프레임 렌더 직후 (미니맵 · 알림 갱신용, 실제 경과 초) */
  onFrame?: (dt: number) => void;
}

const DT = 1 / CONFIG.tickRate;

/**
 * 한 판의 클라이언트: 시뮬레이션 루프 + 카메라 + 렌더 + 플레이어 선택/명령 상태.
 * 입력 장치(마우스/터치/키보드)와는 분리되어 있어, 입력 계층은 여기의 메서드만 호출한다.
 */
export class Game {
  readonly match: Match;
  readonly camera = new Camera();
  readonly renderer: Renderer;
  readonly selection = new Set<number>();
  readonly overlay: OverlayState = { box: null, line: null, hint: null, hoverPlanet: -1, targeting: false };
  formation: Formation = 'cluster';
  paused = false;
  speed = 1;
  /** 관전 모드(메뉴 배경): 입력/종료 처리 없음, 카메라가 천천히 흐른다 */
  readonly spectator: boolean;

  private groups = new Map<number, number[]>();
  private acc = 0;
  private lastFrame = 0;
  private raf = 0;
  private ended = false;
  /** 전체 보기(Z)에서 되돌아갈 시점 (보이는 영역 중심 + 배율) */
  private overviewReturn: View | null = null;

  constructor(
    canvas: HTMLCanvasElement,
    settings: MatchSettings,
    private hooks: GameHooks = {},
  ) {
    this.match = new Match(settings);
    this.spectator = !!settings.autoplay;
    this.renderer = new Renderer(canvas);
  }

  get world() {
    return this.match.world;
  }

  start(): void {
    this.lastFrame = performance.now();
    const frame = (t: number) => {
      this.frame(t);
      this.raf = requestAnimationFrame(frame);
    };
    this.raf = requestAnimationFrame(frame);
  }

  stop(): void {
    cancelAnimationFrame(this.raf);
  }

  resize(width: number, height: number, insets: Insets, refit: boolean): void {
    this.camera.resize(width, height);
    this.camera.setBounds(this.world.width, this.world.height, insets);
    this.renderer.resize(width, height);
    if (refit) this.resetView();
  }

  // ───────────────────────────── 카메라 ─────────────────────────────

  /**
   * 시작 화면. 관전(메뉴 배경)은 맵 전체를, 플레이는 아군 모성 주변을 확대해서 보여준다.
   * 맵 전체는 오른쪽 아래 미니맵과 전체 보기(Z)로 본다.
   */
  resetView(): void {
    const cam = this.camera;
    const { width: W, height: H } = this.world;
    this.overviewReturn = null;
    if (this.spectator) {
      cam.jumpTo(W / 2, H / 2, cam.fitZoom());
      return;
    }
    const home = this.homeFocus() ?? { x: W / 2, y: H / 2 };
    cam.jumpTo(home.x, home.y, cam.defaultZoom());
  }

  /** 지점으로 부드럽게 이동 (미니맵 탭, 알림, 부대 위치) */
  focusOn(x: number, y: number): void {
    this.overviewReturn = null;
    this.camera.moveTo(x, y, this.focusZoom());
  }

  /** H: 모성 (없으면 병력이 가장 많은 아군 행성, 그것도 없으면 아군 병력 중심) */
  focusHome(): boolean {
    const f = this.homeFocus();
    if (f) this.focusOn(f.x, f.y);
    return !!f;
  }

  /** 선택한 병력의 중심으로 (부대 번호 두 번 누르기) */
  focusSelection(): boolean {
    let sx = 0, sy = 0, n = 0;
    for (const id of this.selection) {
      const u = this.world.getUnit(id);
      if (!u) continue;
      sx += u.x;
      sy += u.y;
      n++;
    }
    if (n > 0) this.focusOn(sx / n, sy / n);
    return n > 0;
  }

  /** Z / ⤢: 맵 전체 보기 ↔ 직전 시점 */
  toggleOverview(): void {
    const cam = this.camera;
    const inOverview = cam.target.zoom <= cam.fitZoom() * 1.02;
    if (inOverview) {
      const back = this.overviewReturn ?? { ...(this.homeFocus() ?? cam.targetCenter()), zoom: cam.defaultZoom() };
      this.overviewReturn = null;
      cam.moveTo(back.x, back.y, back.zoom);
      return;
    }
    this.overviewReturn = { ...cam.targetCenter(), zoom: cam.target.zoom };
    cam.moveTo(this.world.width / 2, this.world.height / 2, cam.fitZoom());
  }

  /** 맵이 거의 다 보일 만큼 물러나 있으면 기본 배율로 당겨오고, 아니면 지금 배율을 유지한다 */
  private focusZoom(): number {
    const cam = this.camera;
    const z = cam.target.zoom;
    return z <= cam.fitZoom() * 1.25 ? Math.max(z, cam.defaultZoom()) : z;
  }

  private homeFocus(): { x: number; y: number } | null {
    const mine = this.world.planets.filter((p) => p.owner === PLAYER);
    const home = mine.find((p) => p.isHome) ?? mine.sort((a, b) => b.orbitCount[PLAYER] - a.orbitCount[PLAYER])[0];
    if (home) return { x: home.x, y: home.y };
    let sx = 0, sy = 0, n = 0;
    for (const u of this.world.units) {
      if (u.faction !== PLAYER) continue;
      sx += u.x;
      sy += u.y;
      n++;
    }
    return n > 0 ? { x: sx / n, y: sy / n } : null;
  }

  private frame(now: number): void {
    const realDt = Math.min(0.1, (now - this.lastFrame) / 1000);
    this.lastFrame = now;

    if (!this.paused) {
      this.acc += realDt * this.speed;
      let steps = 0;
      while (this.acc >= DT && steps < 12) {
        this.match.step(DT);
        this.acc -= DT;
        steps++;
      }
      if (steps === 12) this.acc = 0;
    }

    const events = this.world.events;
    if (events.length > 0) {
      this.renderer.consume(events, this.world);
      this.hooks.onEvents?.(events);
      this.world.events = [];
    }
    this.pruneSelection();

    if (this.spectator) {
      this.camera.x += Math.sin(now / 9000) * 4 * realDt;
      this.camera.y += Math.cos(now / 11000) * 3 * realDt;
    } else {
      this.camera.update(realDt);
    }

    this.renderer.render(this.world, this.camera, this.selection, this.paused ? 1 : this.acc / DT, this.overlay, realDt);
    this.hooks.onFrame?.(realDt);

    if (!this.spectator && !this.ended && this.world.winner !== null) {
      this.ended = true;
      this.hooks.onEnd?.(this.world.winner);
    }
  }

  // ───────────────────────────── 선택 ─────────────────────────────

  private setSelection(ids: Iterable<number>, additive: boolean): void {
    if (!additive) this.selection.clear();
    for (const id of ids) this.selection.add(id);
    this.hooks.onSelectionChange?.(this.selection.size);
  }

  private pruneSelection(): void {
    if (this.selection.size === 0) return;
    const before = this.selection.size;
    for (const id of this.selection) if (!this.world.getUnit(id)) this.selection.delete(id);
    if (this.selection.size !== before) this.hooks.onSelectionChange?.(this.selection.size);
  }

  /** 월드 좌표 사각형 안의 아군 병력 */
  selectInRect(x0: number, y0: number, x1: number, y1: number, additive: boolean): void {
    const minX = Math.min(x0, x1), maxX = Math.max(x0, x1);
    const minY = Math.min(y0, y1), maxY = Math.max(y0, y1);
    const ids = this.world.units
      .filter((u) => u.faction === PLAYER && u.x >= minX && u.x <= maxX && u.y >= minY && u.y <= maxY)
      .map((u) => u.id);
    this.setSelection(ids, additive);
  }

  /** 행성 궤도를 돌고 있는 아군 병력 */
  selectPlanet(p: Planet, additive: boolean): void {
    const ids = this.world.units.filter((u) => u.faction === PLAYER && u.state === 'orbit' && u.planet === p.id).map((u) => u.id);
    this.setSelection(ids, additive);
  }

  /** 지점 주변 반경 안의 아군 병력 */
  selectNear(x: number, y: number, radius: number, additive: boolean): number {
    const ids = this.world.units.filter((u) => u.faction === PLAYER && Math.hypot(u.x - x, u.y - y) <= radius).map((u) => u.id);
    if (ids.length > 0 || !additive) this.setSelection(ids, additive);
    return ids.length;
  }

  selectAll(): void {
    this.setSelection(this.world.units.filter((u) => u.faction === PLAYER).map((u) => u.id), false);
  }

  clearSelection(): void {
    this.overlay.targeting = false;
    this.setSelection([], false);
  }

  /** 선택을 절반으로 (행성/위치 그룹마다 고르게 남긴다) */
  halveSelection(): void {
    if (this.selection.size <= 1) return;
    const groups = new Map<number, number[]>();
    for (const id of this.selection) {
      const u = this.world.getUnit(id);
      if (!u) continue;
      const key = u.state === 'orbit' ? u.planet : -1;
      const g = groups.get(key) ?? [];
      g.push(id);
      groups.set(key, g);
    }
    const keep: number[] = [];
    for (const g of groups.values()) keep.push(...g.filter((_, i) => i % 2 === 0));
    this.setSelection(keep, false);
  }

  assignGroup(n: number): void {
    this.groups.set(n, [...this.selection]);
  }

  recallGroup(n: number): boolean {
    const ids = (this.groups.get(n) ?? []).filter((id) => this.world.getUnit(id));
    if (ids.length === 0) return false;
    this.setSelection(ids, false);
    return true;
  }

  // ───────────────────────────── 명령 ─────────────────────────────

  private send(order: Order): boolean {
    if (this.selection.size === 0) return false;
    this.world.enqueue({ faction: PLAYER, unitIds: [...this.selection], order });
    return true;
  }

  /** 지점에 명령: 행성 위면 합류/돌파/포위, 아니면 현재 대형으로 이동 */
  commandAt(x: number, y: number): boolean {
    const p = this.world.planetAt(x, y, 6);
    const ok = p
      ? this.send({ kind: 'planet', planetId: p.id, formation: this.formation })
      : this.send({ kind: 'move', x, y, formation: this.formation });
    if (ok) this.renderer.marker(p ? p.x : x, p ? p.y : y, this.world.factions[PLAYER].color);
    this.overlay.targeting = false;
    return ok;
  }

  commandLine(x1: number, y1: number, x2: number, y2: number): boolean {
    this.overlay.targeting = false;
    return this.send({ kind: 'line', x1, y1, x2, y2 });
  }

  commandReturn(): boolean {
    return this.send({ kind: 'return' });
  }

  /** 전체 선택 후 목표 지정 대기 */
  attackAll(): void {
    this.selectAll();
    this.overlay.targeting = this.selection.size > 0;
  }

  toggleFormation(): Formation {
    this.formation = this.formation === 'cluster' ? 'spread' : 'cluster';
    return this.formation;
  }

  /** 커서 위치에서 지금 명령하면 무슨 일이 일어나는지 한 단어로 */
  describeCommandAt(x: number, y: number): string | null {
    if (this.selection.size === 0) return null;
    const p = this.world.planetAt(x, y, 6);
    if (p?.owner === PLAYER) return `합류 ${this.selection.size}`;
    if (p) return this.formation === 'cluster' ? `돌파 ▶ ${this.selection.size}` : `포위 ◎ ${this.selection.size}`;
    return this.formation === 'cluster' ? `이동 ${this.selection.size}` : `횡대 이동 ${this.selection.size}`;
  }
}
