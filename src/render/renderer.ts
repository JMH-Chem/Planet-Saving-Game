import { CONFIG } from '../config';
import { NEUTRAL, type GameEvent, type Planet } from '../sim/types';
import type { World } from '../sim/world';
import type { Camera } from './camera';

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

interface Laser { x1: number; y1: number; x2: number; y2: number; color: string; age: number }
interface Particle { x: number; y: number; vx: number; vy: number; color: string; age: number; life: number }
interface Ring { x: number; y: number; r0: number; r1: number; color: string; age: number; life: number }

const LASER_LIFE = 0.12;
const SIZE_LABEL = { small: '소형', medium: '중형', large: '대형' } as const;

export function withAlpha(hex: string, a: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

export class Renderer {
  private ctx: CanvasRenderingContext2D;
  private dpr = 1;
  private width = 1;
  private height = 1;
  private starTile: HTMLCanvasElement;
  private lasers: Laser[] = [];
  private particles: Particle[] = [];
  private rings: Ring[] = [];
  private clock = 0;

  constructor(private canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d', { alpha: false })!;
    this.starTile = makeStarTile(512);
  }

  resize(width: number, height: number): void {
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.width = width;
    this.height = height;
    this.canvas.width = Math.round(width * this.dpr);
    this.canvas.height = Math.round(height * this.dpr);
    this.canvas.style.width = `${width}px`;
    this.canvas.style.height = `${height}px`;
  }

  /** 시뮬레이션 이벤트 → 시각 효과 */
  consume(events: readonly GameEvent[], world: World): void {
    for (const e of events) {
      switch (e.type) {
        case 'shot':
          if (this.lasers.length < 1500) {
            this.lasers.push({ x1: e.x1, y1: e.y1, x2: e.x2, y2: e.y2, color: world.factions[e.faction].color, age: 0 });
          }
          break;
        case 'death': {
          const color = world.factions[e.faction].color;
          for (let i = 0; i < 4 && this.particles.length < 1200; i++) {
            const a = Math.random() * Math.PI * 2;
            const s = 15 + Math.random() * 35;
            this.particles.push({ x: e.x, y: e.y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, color, age: 0, life: 0.35 + Math.random() * 0.25 });
          }
          break;
        }
        case 'capture': {
          const p = world.planets[e.planetId];
          this.rings.push({ x: p.x, y: p.y, r0: p.radius, r1: p.atmosphereRadius + 40, color: world.factions[e.to].color, age: 0, life: 0.9 });
          break;
        }
      }
    }
  }

  /** 명령 지점 피드백 */
  marker(x: number, y: number, color: string): void {
    this.rings.push({ x, y, r0: 18, r1: 4, color, age: 0, life: 0.45 });
  }

  render(world: World, cam: Camera, selection: ReadonlySet<number>, alpha: number, overlay: OverlayState, dt: number): void {
    this.clock += dt;
    const ctx = this.ctx;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.drawBackground(cam);

    // 월드 좌표계
    ctx.save();
    ctx.translate(this.width / 2, this.height / 2);
    ctx.scale(cam.zoom, cam.zoom);
    ctx.translate(-cam.x, -cam.y);

    ctx.strokeStyle = 'rgba(255,255,255,0.05)';
    ctx.lineWidth = 1 / cam.zoom;
    ctx.strokeRect(0, 0, world.width, world.height);

    for (const p of world.planets) this.drawPlanetBack(world, p, cam, overlay);
    this.drawLasers(cam, dt);
    this.drawUnits(world, cam, selection, alpha);
    this.drawParticles(cam, dt);
    for (const p of world.planets) this.drawPlanetLabel(p, cam);
    if (overlay.line) this.drawLinePreview(overlay.line, cam, selection.size);
    ctx.restore();

    // 화면 좌표계
    if (overlay.box) this.drawBox(overlay.box);
    if (overlay.hoverPlanet >= 0) this.drawPlanetTooltip(world, world.planets[overlay.hoverPlanet], cam);
    if (overlay.hint) this.drawHint(overlay.hint, overlay.targeting);
  }

  // ───────────────────────────── 배경 ─────────────────────────────

  private drawBackground(cam: Camera): void {
    const ctx = this.ctx;
    const g = ctx.createRadialGradient(this.width * 0.3, this.height * 0.2, 0, this.width * 0.5, this.height * 0.5, Math.max(this.width, this.height));
    g.addColorStop(0, '#141a33');
    g.addColorStop(0.6, '#0a0d1c');
    g.addColorStop(1, '#05060d');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, this.width, this.height);

    // 시차(parallax) 별 타일
    const tile = this.starTile.width;
    const ox = -((cam.x * cam.zoom * 0.15) % tile) - tile;
    const oy = -((cam.y * cam.zoom * 0.15) % tile) - tile;
    for (let x = ox; x < this.width; x += tile) {
      for (let y = oy; y < this.height; y += tile) ctx.drawImage(this.starTile, x, y);
    }
  }

  // ───────────────────────────── 행성 ─────────────────────────────

  private drawPlanetBack(world: World, p: Planet, cam: Camera, overlay: OverlayState): void {
    const ctx = this.ctx;
    const color = world.factions[p.owner].color;
    const px = 1 / cam.zoom;

    // 대기권: 이 안 = 행성 공격, 밖 = 병력 교전
    const hovered = overlay.hoverPlanet === p.id;
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.atmosphereRadius, 0, Math.PI * 2);
    ctx.fillStyle = withAlpha(color, hovered ? 0.1 : 0.05);
    ctx.fill();
    ctx.setLineDash([4 * px, 4 * px]);
    ctx.lineWidth = (hovered ? 1.5 : 1) * px;
    ctx.strokeStyle = withAlpha(color, hovered ? 0.6 : 0.25);
    ctx.stroke();
    ctx.setLineDash([]);

    // 공격받는 중 경고
    const sinceHit = world.time - p.lastAssaultAt;
    if (sinceHit < 0.4) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.atmosphereRadius, 0, Math.PI * 2);
      ctx.lineWidth = 2.5 * px;
      ctx.strokeStyle = withAlpha(world.factions[p.lastAssaultBy].color, 0.7 * (1 - sinceHit / 0.4));
      ctx.stroke();
    }

    // 본체
    const g = ctx.createRadialGradient(p.x - p.radius * 0.35, p.y - p.radius * 0.35, p.radius * 0.1, p.x, p.y, p.radius);
    if (p.owner === NEUTRAL) {
      g.addColorStop(0, '#6b7280');
      g.addColorStop(1, '#262a33');
    } else {
      g.addColorStop(0, withAlpha(color, 0.95));
      g.addColorStop(0.7, withAlpha(color, 0.45));
      g.addColorStop(1, '#10131f');
    }
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.radius, 0, Math.PI * 2);
    ctx.fillStyle = g;
    ctx.fill();
    ctx.lineWidth = 1.5 * px;
    ctx.strokeStyle = withAlpha(color, 0.9);
    ctx.stroke();

    // 방어도 게이지
    const r = p.radius + 3.5;
    ctx.lineWidth = Math.max(2 * px, 2.5);
    ctx.beginPath();
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.stroke();
    const frac = Math.max(0, p.defense / p.maxDefense);
    ctx.beginPath();
    ctx.arc(p.x, p.y, r, -Math.PI / 2, -Math.PI / 2 + frac * Math.PI * 2);
    ctx.strokeStyle = frac < 0.3 ? '#ff6b6b' : withAlpha(p.owner === NEUTRAL ? '#cfd6df' : color, 0.95);
    ctx.stroke();

    if (p.isHome && p.owner !== NEUTRAL) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.radius - 5, 0, Math.PI * 2);
      ctx.lineWidth = 1 * px;
      ctx.strokeStyle = 'rgba(255,255,255,0.35)';
      ctx.stroke();
    }
  }

  private drawPlanetLabel(p: Planet, cam: Camera): void {
    const ctx = this.ctx;
    const count = p.orbitCount[p.owner];
    const fontPx = Math.max(10, Math.min(22, p.radius * cam.zoom * 0.75));
    ctx.font = `700 ${fontPx / cam.zoom}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 3 / cam.zoom;
    ctx.strokeStyle = 'rgba(0,0,0,0.55)';
    ctx.strokeText(String(count), p.x, p.y);
    ctx.fillStyle = count >= p.capacity && p.owner !== NEUTRAL ? '#ffe08a' : '#ffffff';
    ctx.fillText(String(count), p.x, p.y);
  }

  private drawPlanetTooltip(world: World, p: Planet, cam: Camera): void {
    const ctx = this.ctx;
    const s = cam.toScreen(p.x, p.y + p.atmosphereRadius);
    const owner = world.factions[p.owner];
    const lines = [
      `${SIZE_LABEL[p.size]} 행성 · ${owner.name}${p.isHome ? ' (모성)' : ''}`,
      `방어도 ${Math.ceil(p.defense)} / ${p.maxDefense}`,
      p.owner === NEUTRAL ? '생산 없음 (점령 시 ' + p.production + '/s)' : `생산 ${p.production}/s · 정원 ${p.orbitCount[p.owner]}/${p.capacity}`,
    ];
    ctx.font = '12px system-ui, sans-serif';
    const w = Math.max(...lines.map((l) => ctx.measureText(l).width)) + 16;
    const h = lines.length * 16 + 10;
    const x = Math.min(this.width - w - 8, Math.max(8, s.x - w / 2));
    const y = Math.min(this.height - h - 80, s.y + 8);
    ctx.fillStyle = 'rgba(10,14,28,0.88)';
    ctx.strokeStyle = withAlpha(owner.color, 0.6);
    ctx.lineWidth = 1;
    roundRect(ctx, x, y, w, h, 6);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#dfe6f5';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    lines.forEach((l, i) => ctx.fillText(l, x + 8, y + 6 + i * 16));
  }

  // ───────────────────────────── 병력/효과 ─────────────────────────────

  private drawUnits(world: World, cam: Camera, selection: ReadonlySet<number>, alpha: number): void {
    const ctx = this.ctx;
    const r = Math.max(1.9 / cam.zoom, 2.8);
    const blinkOn = Math.sin(this.clock * 12) > 0;
    const twoPi = Math.PI * 2;

    for (const f of world.factions) {
      ctx.beginPath();
      let any = false;
      for (const u of world.units) {
        if (u.faction !== f.id || (u.isolated && !blinkOn)) continue;
        const x = u.px + (u.x - u.px) * alpha;
        const y = u.py + (u.y - u.py) * alpha;
        ctx.moveTo(x + r, y);
        ctx.arc(x, y, r, 0, twoPi);
        any = true;
      }
      if (any) {
        ctx.fillStyle = f.color;
        ctx.fill();
      }
    }

    // 고립 병력은 희미하게 깜박인다
    if (!blinkOn) {
      for (const f of world.factions) {
        ctx.beginPath();
        let any = false;
        for (const u of world.units) {
          if (u.faction !== f.id || !u.isolated) continue;
          const x = u.px + (u.x - u.px) * alpha;
          const y = u.py + (u.y - u.py) * alpha;
          ctx.moveTo(x + r, y);
          ctx.arc(x, y, r, 0, twoPi);
          any = true;
        }
        if (any) {
          ctx.fillStyle = withAlpha(f.color, 0.3);
          ctx.fill();
        }
      }
    }

    if (selection.size > 0) {
      ctx.beginPath();
      const sr = r + Math.max(1.2 / cam.zoom, 1.2);
      for (const u of world.units) {
        if (!selection.has(u.id)) continue;
        const x = u.px + (u.x - u.px) * alpha;
        const y = u.py + (u.y - u.py) * alpha;
        ctx.moveTo(x + sr, y);
        ctx.arc(x, y, sr, 0, twoPi);
      }
      ctx.lineWidth = Math.max(1 / cam.zoom, 0.8);
      ctx.strokeStyle = 'rgba(255,255,255,0.9)';
      ctx.stroke();
    }
  }

  private drawLasers(cam: Camera, dt: number): void {
    const ctx = this.ctx;
    ctx.lineWidth = Math.max(0.8 / cam.zoom, 0.8);
    ctx.lineCap = 'round';
    for (const l of this.lasers) {
      l.age += dt;
      ctx.globalAlpha = Math.max(0, 1 - l.age / LASER_LIFE) * 0.85;
      ctx.strokeStyle = l.color;
      ctx.beginPath();
      ctx.moveTo(l.x1, l.y1);
      ctx.lineTo(l.x2, l.y2);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    this.lasers = this.lasers.filter((l) => l.age < LASER_LIFE);
  }

  private drawParticles(cam: Camera, dt: number): void {
    const ctx = this.ctx;
    const s = Math.max(1.2 / cam.zoom, 1.4);
    for (const p of this.particles) {
      p.age += dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      ctx.globalAlpha = Math.max(0, 1 - p.age / p.life);
      ctx.fillStyle = p.color;
      ctx.fillRect(p.x - s / 2, p.y - s / 2, s, s);
    }
    this.particles = this.particles.filter((p) => p.age < p.life);

    for (const r of this.rings) {
      r.age += dt;
      const t = Math.min(1, r.age / r.life);
      ctx.globalAlpha = 1 - t;
      ctx.beginPath();
      ctx.arc(r.x, r.y, r.r0 + (r.r1 - r.r0) * t, 0, Math.PI * 2);
      ctx.lineWidth = 2 / cam.zoom;
      ctx.strokeStyle = r.color;
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    this.rings = this.rings.filter((r) => r.age < r.life);
  }

  // ───────────────────────────── 오버레이 ─────────────────────────────

  private drawLinePreview(l: NonNullable<OverlayState['line']>, cam: Camera, count: number): void {
    const ctx = this.ctx;
    const px = 1 / cam.zoom;
    ctx.strokeStyle = 'rgba(79,195,247,0.9)';
    ctx.lineWidth = 2 * px;
    ctx.setLineDash([6 * px, 4 * px]);
    ctx.beginPath();
    ctx.moveTo(l.x1, l.y1);
    ctx.lineTo(l.x2, l.y2);
    ctx.stroke();
    ctx.setLineDash([]);
    for (const [x, y] of [[l.x1, l.y1], [l.x2, l.y2]]) {
      ctx.beginPath();
      ctx.arc(x, y, 4 * px, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(79,195,247,0.9)';
      ctx.fill();
    }
    const len = Math.hypot(l.x2 - l.x1, l.y2 - l.y1);
    const perRow = Math.floor(len / CONFIG.formation.lineSpacing) + 1;
    ctx.font = `600 ${12 * px}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.fillStyle = '#bfe9ff';
    ctx.fillText(`횡대 ${count}기 · ${Math.max(1, Math.ceil(count / perRow))}열`, (l.x1 + l.x2) / 2, (l.y1 + l.y2) / 2 - 10 * px);
  }

  private drawBox(b: NonNullable<OverlayState['box']>): void {
    const ctx = this.ctx;
    const x = Math.min(b.x0, b.x1), y = Math.min(b.y0, b.y1);
    const w = Math.abs(b.x1 - b.x0), h = Math.abs(b.y1 - b.y0);
    ctx.fillStyle = 'rgba(79,195,247,0.08)';
    ctx.fillRect(x, y, w, h);
    ctx.setLineDash([5, 4]);
    ctx.strokeStyle = 'rgba(160,220,255,0.85)';
    ctx.lineWidth = 1;
    ctx.strokeRect(x + 0.5, y + 0.5, w, h);
    ctx.setLineDash([]);
  }

  private drawHint(h: NonNullable<OverlayState['hint']>, targeting: boolean): void {
    const ctx = this.ctx;
    ctx.font = '600 12px system-ui, sans-serif';
    const w = ctx.measureText(h.label).width + 14;
    const x = h.x + 16, y = h.y + 14;
    ctx.fillStyle = targeting ? 'rgba(255,93,93,0.85)' : 'rgba(10,14,28,0.8)';
    roundRect(ctx, x, y, w, 20, 10);
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(h.label, x + 7, y + 10);
  }
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function makeStarTile(size: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d')!;
  for (let i = 0; i < 140; i++) {
    const a = Math.random();
    ctx.fillStyle = `rgba(${200 + Math.random() * 55},${210 + Math.random() * 45},255,${0.15 + a * 0.6})`;
    const s = a > 0.92 ? 1.6 : 1;
    ctx.fillRect(Math.random() * size, Math.random() * size, s, s);
  }
  return c;
}
