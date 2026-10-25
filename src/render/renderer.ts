import { CONFIG } from '../config';
import { NEUTRAL, PLAYER, type GameEvent, type Planet } from '../sim/types';
import type { World } from '../sim/world';
import { Background } from './background';
import type { Camera } from './camera';
import { Effects, inView, type ViewRect } from './effects';
import { drawGateLabels, drawGates, invaderColor } from './gates';
import { OrderFx, orderColor, type OrderFeedback, type OrderKind } from './orderFx';
import { PlanetLayer } from './planets';
import { mixHex, roundRect, withAlpha } from './sprites';
import { UnitLayer } from './units';

export { withAlpha } from './sprites';
export type { OrderFeedback, OrderKind } from './orderFx';

/** 입력 쪽에서 넘겨주는 화면 오버레이 상태 */
export interface OverlayState {
  /** 드래그 선택 상자 (화면 좌표) */
  box: { x0: number; y0: number; x1: number; y1: number } | null;
  /** 횡대 선 미리보기 (월드 좌표) */
  line: { x1: number; y1: number; x2: number; y2: number } | null;
  /** 커서 옆 명령 미리보기 (화면 좌표) */
  hint: { x: number; y: number; label: string } | null;
  /** 마우스가 올라간 행성 */
  hoverPlanet: number;
  targeting: boolean;
}

const SIZE_LABEL = { small: '소형', medium: '중형', large: '대형' } as const;
const LOSS_COLOR = '#ff5d5d';

/** 움직임 줄이기 설정. 렌더러는 판마다 새로 만들어지므로 리스너 대신 한 곳에서 매번 읽는다 */
const motionQuery = typeof window !== 'undefined' ? window.matchMedia?.('(prefers-reduced-motion: reduce)') : undefined;
const prefersReducedMotion = () => !!motionQuery?.matches;

/**
 * 캔버스 렌더러. 그리는 순서:
 * 배경 → 행성(대기권 · 표면 · 고리) → 워프 게이트 · 명령 경로 → 연기/파편 → 병력 → 가산 효과(레이저/폭발) → 이름표 · 글자 → 화면 오버레이
 */
export class Renderer {
  private ctx: CanvasRenderingContext2D;
  private dpr = 1;
  private width = 1;
  private height = 1;
  private clock = 0;
  private bg = new Background();
  private fx: Effects;
  private planets = new PlanetLayer();
  private units = new UnitLayer();
  private orders = new OrderFx();
  /** 움직임 줄이기 설정: 화면 흔들림 없음, 입자 절반 */
  private reduced = false;
  /** 직전 프레임에 보이던 월드 영역. 화면 밖 이벤트는 효과를 만들지 않는다 */
  private view: ViewRect = { x0: -Infinity, y0: -Infinity, x1: Infinity, y1: Infinity };
  private trauma = 0;
  private shakeX = 0;
  private shakeY = 0;
  private lastHitShake = -10;

  constructor(private canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d', { alpha: false })!;
    this.reduced = prefersReducedMotion();
    this.fx = new Effects(this.reduced ? 1500 : 3000);
  }

  resize(width: number, height: number): void {
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.width = width;
    this.height = height;
    this.canvas.width = Math.round(width * this.dpr);
    this.canvas.height = Math.round(height * this.dpr);
    this.canvas.style.width = `${width}px`;
    this.canvas.style.height = `${height}px`;
    this.bg.resize(width, height);
  }

  /** 화면 흔들림. intensity = 최대 흔들림 폭(CSS px). 여러 번 불러도 큰 쪽만 남는다 */
  shake(intensity: number): void {
    if (this.reduced) return;
    this.trauma = Math.min(16, Math.max(this.trauma, intensity));
  }

  /** 명령 피드백: 선택 무게중심 → 목표까지의 경로와 명령 종류별 표식 */
  orderFeedback(o: OrderFeedback): void {
    this.orders.add(o);
  }

  /** 명령 지점 피드백 (단순 고리) */
  marker(x: number, y: number, color: string): void {
    this.fx.ring(x, y, 18, 4, color, 0.45, 2, true);
  }

  /** 시뮬레이션 이벤트 → 시각 효과 */
  consume(events: readonly GameEvent[], world: World): void {
    const fx = this.fx;
    const view = this.view;
    // 부하에 따라 입자 수를 줄인다 (LOD)
    const load = fx.load;
    let lod = this.reduced ? 0.5 : 1;
    if (load > 0.75) lod *= 0.3;
    else if (load > 0.45) lod *= 0.6;
    let deaths = 0;
    for (const e of events) if (e.type === 'death' && inView(view, e.x, e.y)) deaths++;
    if (deaths > 24) lod *= 0.5;
    let shots = 0;

    for (const e of events) {
      switch (e.type) {
        case 'shot': {
          const color = world.factions[e.faction].color;
          const visible = inView(view, e.x1, e.y1, 30) || inView(view, e.x2, e.y2, 30);
          if (e.planet) {
            const p = world.planetAt(e.x2, e.y2);
            if (p) {
              this.planets.hit(p, color);
              // 아군 행성이 적에게 맞으면 아주 살짝, 드문드문 흔든다
              if (p.owner === PLAYER && e.faction !== PLAYER && visible && this.clock - this.lastHitShake > 0.7) {
                this.lastHitShake = this.clock;
                this.shake(1.4);
              }
            }
            if (!visible) break;
            fx.beam(e.x1, e.y1, e.x2, e.y2, color, 0.14);
            fx.flash(e.x1, e.y1, 4, color, 0.08);
            if (p) fx.shieldArc(p.x, p.y, p.radius + 8, Math.atan2(e.y2 - p.y, e.x2 - p.x), color);
            fx.flash(e.x2, e.y2, 6, color, 0.2);
            if (Math.random() < 0.6 * lod) fx.sparks(e.x2, e.y2, 2, color, 70, 0.3, Math.atan2(e.y1 - e.y2, e.x1 - e.x2), 1.6);
            break;
          }
          if (!visible) break;
          shots++;
          fx.beam(e.x1, e.y1, e.x2, e.y2, color);
          // 사격이 아주 많은 프레임에는 섬광을 일부만
          if (shots < 120 || Math.random() < 0.4) {
            fx.flash(e.x1, e.y1, 4.5, color, 0.08);
            fx.flash(e.x2, e.y2, 4, color, 0.11);
          }
          break;
        }
        case 'death': {
          if (!inView(view, e.x, e.y, 20)) break;
          const color = world.factions[e.faction].color;
          // 흰 심을 진영 색 쪽으로 섞어 둬야 여러 개가 겹쳐도 하얗게 타 버리지 않고 색이 남는다
          fx.flash(e.x, e.y, 15, color, 0.42);
          fx.flash(e.x, e.y, 5.5, mixHex(color, '#ffffff', 0.6), 0.14);
          fx.sparks(e.x, e.y, Math.max(2, Math.round((7 + Math.random() * 3) * lod)), color, 125, 0.55);
          fx.debris(e.x, e.y, lod >= 0.6 ? 3 : 1, color, 30);
          if (lod >= 0.6) fx.ring(e.x, e.y, 2, 11, color, 0.26, 1.1, false);
          break;
        }
        case 'spawn': {
          const p = world.planets[e.planetId];
          if (p) this.planets.born(p);
          if (!inView(view, e.x, e.y, 20)) break;
          const color = world.factions[e.faction].color;
          fx.flash(e.x, e.y, 5, color, 0.3);
          if (lod >= 0.6) fx.embers(e.x, e.y, 3, color, 18, 0.5);
          break;
        }
        case 'warp': {
          if (!inView(view, e.x, e.y, 40)) break;
          const color = world.factions[e.faction]?.color ?? invaderColor(world);
          fx.flash(e.x, e.y, 10, color, 0.35);
          fx.ring(e.x, e.y, 2, 14, color, 0.4, 1.5, true);
          fx.embers(e.x, e.y, Math.round(4 * lod), color, 30, 0.6);
          break;
        }
        case 'capture':
          this.onCapture(world, world.planets[e.planetId], e.from, e.to, lod);
          break;
      }
    }

    // 화면 안에서 한꺼번에 많이 터지면 살짝 흔들린다
    if (deaths >= 8) this.shake(Math.min(3.5, 0.8 + deaths * 0.12));
  }

  private onCapture(world: World, p: Planet, from: number, to: number, lod: number): void {
    const color = world.factions[to].color;
    this.planets.captured(p, color);
    const visible = inView(this.view, p.x, p.y, p.atmosphereRadius + 60);
    const playerInvolved = to === PLAYER || from === PLAYER;
    if (playerInvolved) this.shake(to === PLAYER ? 7 : 9);
    if (!visible) return;
    const fx = this.fx;
    const hot = mixHex(color, '#ffffff', 0.4);
    fx.ring(p.x, p.y, p.radius, p.atmosphereRadius + 55, color, 0.85, 3.2, true);
    fx.ring(p.x, p.y, p.radius * 0.6, p.atmosphereRadius + 110, color, 1.4, 1.4, true);
    fx.flash(p.x, p.y, p.radius * 2.2, color, 0.55);
    fx.flash(p.x, p.y, p.radius * 1.1, '#ffffff', 0.25);
    const n = Math.round(36 * lod);
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      fx.sparks(p.x + Math.cos(a) * p.radius, p.y + Math.sin(a) * p.radius, 1, i % 3 === 0 ? hot : color, 170, 0.7, a, 0.3);
    }
    fx.embers(p.x, p.y, Math.round(18 * lod), color, 70, 1.1);
    if (to === PLAYER) fx.text(p.x, p.y - p.atmosphereRadius - 6, '점령!', mixHex(color, '#ffffff', 0.25), 24);
    else if (from === PLAYER) fx.text(p.x, p.y - p.atmosphereRadius - 6, '함락', LOSS_COLOR, 24);
  }

  render(world: World, cam: Camera, selection: ReadonlySet<number>, alpha: number, overlay: OverlayState, dt: number): void {
    this.clock += dt;
    this.reduced = prefersReducedMotion();
    const ctx = this.ctx;
    const zoom = cam.zoom;
    this.updateShake(dt);
    this.fx.update(dt);
    this.planets.update(world, dt);
    this.orders.update(dt);

    // 보이는 월드 영역 (화면 밖은 그리지 않는다)
    const halfW = this.width / 2 / zoom, halfH = this.height / 2 / zoom;
    const margin = 24 / zoom + Math.abs(this.trauma) / zoom;
    const view = this.view;
    view.x0 = cam.x - halfW - margin;
    view.x1 = cam.x + halfW + margin;
    view.y0 = cam.y - halfH - margin;
    view.y1 = cam.y + halfH + margin;

    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    this.bg.draw(ctx, cam, world.width, world.height, this.clock, this.reduced);

    // 월드 좌표계 (흔들림 포함)
    ctx.save();
    ctx.translate(this.width / 2 + this.shakeX, this.height / 2 + this.shakeY);
    ctx.scale(zoom, zoom);
    ctx.translate(-cam.x, -cam.y);

    this.drawWorldBounds(world, zoom);
    this.planets.draw(ctx, world, zoom, view, overlay.hoverPlanet, this.clock, this.reduced);
    drawGates(ctx, world, zoom, view, this.clock, this.reduced);
    this.orders.drawPaths(ctx, zoom);
    this.fx.drawUnder(ctx, view);
    this.units.draw(ctx, world, selection, alpha, zoom, view, this.clock, dt, this.fx, this.reduced);
    this.fx.drawGlow(ctx, view, zoom);
    this.orders.drawMarkers(ctx, zoom, this.clock);
    this.planets.drawLabels(ctx, world, zoom, view, this.clock);
    drawGateLabels(ctx, world, zoom, view);
    this.fx.drawTexts(ctx, zoom);
    if (overlay.line) this.drawLinePreview(overlay.line, zoom, selection.size);
    ctx.restore();

    // 화면 좌표계
    if (overlay.box) this.drawBox(overlay.box);
    if (overlay.hoverPlanet >= 0) this.drawPlanetTooltip(world, world.planets[overlay.hoverPlanet], cam);
    if (overlay.hint) this.drawHint(overlay.hint, overlay.targeting);
    // 이후에 같은 캔버스에 그리는 쪽(미니맵 등)을 위해 기본 상태로 돌려 둔다
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }

  private updateShake(dt: number): void {
    if (this.trauma <= 0.05) {
      this.trauma = this.shakeX = this.shakeY = 0;
      return;
    }
    // 서로 다른 주기의 사인을 섞어 무작위처럼 보이지만 부드럽게 흔든다
    const t = this.clock;
    this.shakeX = this.trauma * (Math.sin(t * 47) * 0.6 + Math.sin(t * 23.3 + 1.7) * 0.4);
    this.shakeY = this.trauma * (Math.sin(t * 41.5 + 0.6) * 0.6 + Math.sin(t * 29.1 + 4.1) * 0.4);
    this.trauma *= Math.exp(-dt * 6.5);
  }

  private drawWorldBounds(world: World, zoom: number): void {
    const ctx = this.ctx;
    ctx.strokeStyle = 'rgba(140,170,255,0.07)';
    ctx.lineWidth = 1 / zoom;
    ctx.setLineDash([2 / zoom, 6 / zoom]);
    ctx.strokeRect(0, 0, world.width, world.height);
    ctx.setLineDash([]);
  }

  // ───────────────────────────── 오버레이 ─────────────────────────────

  private drawLinePreview(l: NonNullable<OverlayState['line']>, zoom: number, count: number): void {
    const ctx = this.ctx;
    const px = 1 / zoom;
    const color = orderColor('line');
    const len = Math.hypot(l.x2 - l.x1, l.y2 - l.y1);

    ctx.globalCompositeOperation = 'lighter';
    ctx.lineCap = 'round';
    ctx.strokeStyle = color;
    ctx.globalAlpha = 0.2;
    ctx.lineWidth = 7 * px;
    ctx.beginPath();
    ctx.moveTo(l.x1, l.y1);
    ctx.lineTo(l.x2, l.y2);
    ctx.stroke();
    ctx.globalAlpha = 0.9;
    ctx.lineWidth = 1.8 * px;
    ctx.setLineDash([6 * px, 4 * px]);
    ctx.lineDashOffset = -this.clock * 30 * px;
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.lineDashOffset = 0;

    // 실제로 설 자리(첫 줄)를 작은 점으로 미리 보여 준다
    const spacing = CONFIG.formation.lineSpacing;
    const perRow = Math.floor(len / spacing) + 1;
    if (count > 0 && len > spacing) {
      const inRow = Math.min(perRow, count);
      const gap = count <= perRow && inRow > 1 ? len / (inRow - 1) : spacing;
      const width = gap * (inRow - 1);
      const ux = (l.x2 - l.x1) / len, uy = (l.y2 - l.y1) / len;
      const mx = (l.x1 + l.x2) / 2, my = (l.y1 + l.y2) / 2;
      ctx.globalAlpha = 0.75;
      ctx.fillStyle = color;
      ctx.beginPath();
      const r = Math.max(1.2, 1.4 * px);
      for (let i = 0; i < inRow; i++) {
        const along = inRow === 1 ? 0 : -width / 2 + gap * i;
        const x = mx + ux * along, y = my + uy * along;
        ctx.moveTo(x + r, y);
        ctx.arc(x, y, r, 0, Math.PI * 2);
      }
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    for (const [x, y] of [[l.x1, l.y1], [l.x2, l.y2]]) {
      ctx.beginPath();
      ctx.arc(x, y, 4 * px, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
    }
    ctx.globalCompositeOperation = 'source-over';

    const text = `횡대 ${count}기 · ${Math.max(1, Math.ceil(count / perRow))}열`;
    ctx.font = `700 ${12 * px}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 3 * px;
    ctx.strokeStyle = 'rgba(3,5,12,0.85)';
    ctx.strokeText(text, (l.x1 + l.x2) / 2, (l.y1 + l.y2) / 2 - 12 * px);
    ctx.fillStyle = '#d4f1ff';
    ctx.fillText(text, (l.x1 + l.x2) / 2, (l.y1 + l.y2) / 2 - 12 * px);
  }

  /** 드래그 선택 상자: 모서리 꺾쇠 + 옅은 채움 */
  private drawBox(b: NonNullable<OverlayState['box']>): void {
    const ctx = this.ctx;
    const x = Math.min(b.x0, b.x1), y = Math.min(b.y0, b.y1);
    const w = Math.abs(b.x1 - b.x0), h = Math.abs(b.y1 - b.y0);
    ctx.fillStyle = 'rgba(79,195,247,0.07)';
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = 'rgba(160,220,255,0.28)';
    ctx.lineWidth = 1;
    ctx.strokeRect(x + 0.5, y + 0.5, w, h);

    const c = Math.min(14, w / 3, h / 3);
    ctx.strokeStyle = 'rgba(190,235,255,0.95)';
    ctx.lineWidth = 2;
    ctx.lineCap = 'square';
    ctx.beginPath();
    for (const [cx, cy, sx, sy] of [[x, y, 1, 1], [x + w, y, -1, 1], [x, y + h, 1, -1], [x + w, y + h, -1, -1]]) {
      ctx.moveTo(cx, cy + sy * c);
      ctx.lineTo(cx, cy);
      ctx.lineTo(cx + sx * c, cy);
    }
    ctx.stroke();
    ctx.lineCap = 'butt';
  }

  private drawPlanetTooltip(world: World, p: Planet, cam: Camera): void {
    const ctx = this.ctx;
    const s = cam.toScreen(p.x, p.y + p.atmosphereRadius);
    const owner = world.factions[p.owner];
    const accent = p.owner === NEUTRAL ? '#b8c4d6' : owner.color;
    const title = `${SIZE_LABEL[p.size]} 행성 · ${owner.name}${p.isHome ? ' (모성)' : ''}`;
    const lines = [
      `방어도 ${Math.ceil(p.defense)} / ${p.maxDefense}`,
      p.owner === NEUTRAL ? `생산 없음 (점령 시 ${p.production}/s)` : `생산 ${p.production}/s · 정원 ${p.orbitCount[p.owner]}/${p.capacity}`,
    ];
    ctx.font = '700 12px system-ui, sans-serif';
    let w = ctx.measureText(title).width;
    ctx.font = '12px system-ui, sans-serif';
    for (const l of lines) w = Math.max(w, ctx.measureText(l).width);
    w += 22;
    const h = 22 + lines.length * 16 + 10;
    const x = Math.min(this.width - w - 8, Math.max(8, s.x - w / 2));
    const y = Math.min(this.height - h - 80, s.y + 10);

    ctx.fillStyle = 'rgba(8,12,26,0.9)';
    roundRect(ctx, x, y, w, h, 8);
    ctx.fill();
    ctx.strokeStyle = withAlpha(accent, 0.45);
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.fillStyle = accent;
    ctx.fillRect(x + 1, y + 7, 2.5, h - 14);

    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.font = '700 12px system-ui, sans-serif';
    ctx.fillStyle = mixHex(accent, '#ffffff', 0.55);
    ctx.fillText(title, x + 11, y + 7);
    // 방어도 막대
    const frac = Math.max(0, p.defense / p.maxDefense);
    const bx = x + 11, by = y + 24, bw = w - 22;
    ctx.fillStyle = 'rgba(255,255,255,0.1)';
    ctx.fillRect(bx, by, bw, 3);
    ctx.fillStyle = frac < 0.3 ? LOSS_COLOR : accent;
    ctx.fillRect(bx, by, bw * frac, 3);
    ctx.font = '12px system-ui, sans-serif';
    ctx.fillStyle = '#dfe6f5';
    lines.forEach((l, i) => ctx.fillText(l, x + 11, y + 31 + i * 16));
  }

  /** 커서 옆 명령 미리보기: 명령 종류별 색 점 + 이름 */
  private drawHint(h: NonNullable<OverlayState['hint']>, targeting: boolean): void {
    const ctx = this.ctx;
    const kind: OrderKind = h.label.includes('돌파') ? 'assault' : h.label.includes('포위') ? 'surround' : h.label.includes('합류') ? 'join' : h.label.includes('횡대') ? 'line' : 'move';
    const color = orderColor(kind);
    ctx.font = '700 12px system-ui, sans-serif';
    const w = ctx.measureText(h.label).width + 28;
    const x = Math.min(this.width - w - 4, h.x + 16), y = Math.min(this.height - 26, h.y + 14);
    ctx.fillStyle = targeting ? 'rgba(200,50,50,0.9)' : 'rgba(8,12,26,0.85)';
    roundRect(ctx, x, y, w, 22, 11);
    ctx.fill();
    ctx.strokeStyle = withAlpha(color, 0.55);
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(x + 11, y + 11, 3.5, 0, Math.PI * 2);
    ctx.fillStyle = targeting ? '#ffffff' : color;
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(h.label, x + 20, y + 11.5);
  }
}
