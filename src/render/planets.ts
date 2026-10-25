import { NEUTRAL, type Planet } from '../sim/types';
import type { World } from '../sim/world';
import { inView, type ViewRect } from './effects';
import { PlanetBaker, type PlanetArt } from './planetArt';
import { drawSprite, makeCanvas, mixHex, softSprite, withAlpha } from './sprites';

// 행성: 대기권(게임 규칙상 '안 = 강하, 밖 = 교전' 경계라 늘 또렷하게) · 표면 · 방어도 고리 · 생산 진행 · 이름표.
// 소유 진영은 표면 색이 아니라 바깥 고리 · 대기 광륜 · 가장자리 빛으로 알린다 (표면은 자연스러운 행성 그대로).
//
// 대기 · 광륜 · 표면 · 조명 · 방어도 고리는 행성마다 화면 해상도 그대로의 캔버스 한 장에 합쳐 두고
// (자전으로 0.6px 이상 밀렸거나, 확대 배율 · 소유자 · 방어도가 바뀔 때만 다시 그림) 매 프레임 한 번만 찍는다.
// 축소 · 패턴 · 점선이 섞인 그리기는 GPU 가 없거나 약한 기기에서 특히 비싸기 때문이다.

const NEUTRAL_RING = '#b8c4d6';
const LOW_DEFENSE = '#ff5a5a';
const FULL = '#ffd166';
/** 방어도 고리 칸 수 */
const SEGMENTS = 24;
/** 한 프레임에 행성 텍스처를 굽는 시간 예산(ms). 시작할 때 한꺼번에 굽느라 멈추지 않게 나눈다 */
const BAKE_BUDGET_MS = 5;
/** 이보다 크게 확대(화면 px / 월드 단위)되면 캐시 캔버스가 너무 커지므로 직접 그린다 (그때는 보이는 행성도 몇 개뿐) */
const MAX_CACHE_SCALE = 5;
/** 자전으로 이만큼(화면 px) 밀리면 캐시를 다시 그린다 */
const SPIN_STEP_PX = 0.6;

interface PlanetCache {
  canvas: HTMLCanvasElement;
  g: CanvasRenderingContext2D;
  pattern: CanvasPattern | null;
  scale: number;
  scroll: number;
  owner: number;
  ring: number;
  used: number;
}

interface PlanetState {
  art: PlanetArt | null;
  baker: PlanetBaker | null;
  cache: PlanetCache | null;
  /** 화면에 보이는 방어도 비율 (실제 값을 부드럽게 따라간다) */
  shown: number;
  /** 최근 피해 자국: 잠시 머물렀다가 shown 으로 줄어든다 (격투 게임 체력바처럼) */
  trail: number;
  trailHold: number;
  /** 피격 번쩍임 0~1 */
  hit: number;
  hitColor: string;
  /** 점령 연출 */
  sweep: number;
  sweepColor: string;
  /** 생산 섬광 0~1 */
  birth: number;
}

export class PlanetLayer {
  private states: PlanetState[] = [];
  private matrix = new DOMMatrix();
  /** 직접 그리기(크게 확대했을 때)용 패턴. 패턴은 만든 컨텍스트에서 쓴다 */
  private patterns = new Map<number, CanvasPattern | null>();
  private frames = 0;
  /** 직전 프레임의 배율. 확대/축소 중에는 캐시를 늘려서 쓰고, 멈추면 그 배율로 다시 그린다 */
  private prevScale = 0;

  private state(p: Planet): PlanetState {
    let s = this.states[p.id];
    if (!s) {
      const f = Math.max(0, p.defense / p.maxDefense);
      s = this.states[p.id] = {
        art: null, baker: null, cache: null, shown: f, trail: f, trailHold: 0, hit: 0, hitColor: '#ffffff', sweep: 1, sweepColor: '#ffffff', birth: 0,
      };
    }
    return s;
  }

  hit(p: Planet, color: string): void {
    const s = this.state(p);
    s.hit = 1;
    s.hitColor = color;
  }

  captured(p: Planet, color: string): void {
    const s = this.state(p);
    s.sweep = 0;
    s.sweepColor = color;
    s.shown = s.trail = Math.max(0, p.defense / p.maxDefense);
  }

  born(p: Planet): void {
    this.state(p).birth = 1;
  }

  update(world: World, dt: number): void {
    const k = 1 - Math.exp(-dt * 9);
    for (const p of world.planets) {
      const s = this.state(p);
      const f = Math.max(0, Math.min(1, p.defense / p.maxDefense));
      s.shown += (f - s.shown) * k;
      if (f >= s.trail) {
        s.trail = s.shown;
        s.trailHold = 0;
      } else if ((s.trailHold += dt) > 0.45) {
        s.trail += (s.shown - s.trail) * (1 - Math.exp(-dt * 3));
      }
      // 거의 다 따라왔으면 딱 맞춰서 고리 캐시가 계속 다시 그려지지 않게 한다
      if (Math.abs(f - s.shown) < 0.001) s.shown = f;
      if (Math.abs(s.trail - s.shown) < 0.001) s.trail = s.shown;
      s.hit = Math.max(0, s.hit - dt * 3.5);
      s.birth = Math.max(0, s.birth - dt * 4);
      if (s.sweep < 1) s.sweep = Math.min(1, s.sweep + dt / 0.75);
    }
  }

  // ───────────────────────────── 행성 (병력 아래) ─────────────────────────────

  draw(ctx: CanvasRenderingContext2D, world: World, zoom: number, view: ViewRect, hover: number, clock: number, reduced: boolean): void {
    const px = 1 / zoom;
    const m = ctx.getTransform();
    const scale = m.a;
    const zooming = scale !== this.prevScale;
    this.prevScale = scale;
    const bakeDeadline = performance.now() + BAKE_BUDGET_MS;

    for (const p of world.planets) {
      if (!inView(view, p.x, p.y, p.atmosphereRadius + 40)) continue;
      const s = this.state(p);
      const color = this.ownerColor(world, p);
      if (!s.art) this.bake(p, s, bakeDeadline);
      const art = s.art;
      const low = s.shown < 0.3;
      const period = art ? art.surface.width / art.scale : 1;
      const scroll = art && !reduced ? (((clock * art.spin) % period) + period) % period : 0;

      if (art && scale <= MAX_CACHE_SCALE) {
        const c = this.cache(p, s, scale);
        // 위험(깜빡임) 상태의 고리는 매 프레임 바뀌므로 캐시에 넣지 않는다
        const ringKey = low ? -1 : Math.round(s.shown * 480) * 1000 + Math.round(s.trail * 480);
        let spun = Math.abs(scroll - c.scroll);
        spun = Math.min(spun, period - spun);
        const ratio = scale / c.scale;
        // 확대/축소가 진행 중이면 (배율 차이가 크지 않은 한) 기존 캐시를 늘려 쓰고, 멈춘 뒤에 다시 그린다
        const rescale = c.scale !== scale && (!zooming || ratio < 0.8 || ratio > 1.25);
        if (rescale || c.owner !== p.owner || c.ring !== ringKey || spun * c.scale >= SPIN_STEP_PX) {
          if (c.scale !== scale) this.fit(c, p, scale);
          const g = c.g;
          g.setTransform(1, 0, 0, 1, 0, 0);
          g.clearRect(0, 0, c.canvas.width, c.canvas.height);
          g.setTransform(scale, 0, 0, scale, c.canvas.width / 2, c.canvas.height / 2);
          c.pattern ??= g.createPattern(art.surface, 'repeat-x');
          this.paint(g, p, s, art, c.pattern, color, scroll, px, !low);
          c.scale = scale;
          c.owner = p.owner;
          c.ring = ringKey;
          c.scroll = scroll;
        }
        c.used = clock;
        const dx = m.a * p.x + m.e, dy = m.d * p.y + m.f;
        const cw = c.canvas.width, ch = c.canvas.height;
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        if (c.scale === scale) {
          // 정수 픽셀에 찍어야 보간 없이 그대로 복사된다
          ctx.drawImage(c.canvas, Math.round(dx - cw / 2), Math.round(dy - ch / 2));
        } else {
          const k = scale / c.scale;
          ctx.drawImage(c.canvas, dx - (cw / 2) * k, dy - (ch / 2) * k, cw * k, ch * k);
        }
        ctx.setTransform(m);
      } else {
        ctx.save();
        ctx.translate(p.x, p.y);
        let pattern = this.patterns.get(p.id);
        if (art && pattern === undefined) this.patterns.set(p.id, (pattern = ctx.createPattern(art.surface, 'repeat-x')));
        this.paint(ctx, p, s, art, pattern ?? null, color, scroll, px, !low);
        ctx.restore();
      }

      this.drawLive(ctx, world, p, s, color, px, hover === p.id, clock, reduced, low);
      if (p.owner !== NEUTRAL) this.drawProduction(ctx, p, color, px, clock);
    }

    // 남은 예산으로 화면 밖 행성도 미리 굽는다 (카메라를 옮겼을 때 대체 그림이 보이지 않게)
    for (const p of world.planets) {
      if (performance.now() > bakeDeadline) break;
      const s = this.state(p);
      if (!s.art) this.bake(p, s, bakeDeadline);
    }

    // 한동안 화면에 안 나온 행성의 캐시는 버린다 (확대한 채 맵을 훑으면 메모리가 쌓이므로)
    if (++this.frames % 120 === 0) {
      for (const s of this.states) if (s?.cache && clock - s.cache.used > 3) s.cache = null;
    }
  }

  private bake(p: Planet, s: PlanetState, deadline: number): void {
    if (performance.now() > deadline) return;
    s.baker ??= new PlanetBaker(p);
    if (s.baker.step(deadline)) {
      s.art = s.baker.art;
      s.baker = null;
    }
  }

  private cache(p: Planet, s: PlanetState, scale: number): PlanetCache {
    if (!s.cache) {
      const canvas = makeCanvas(1, 1);
      s.cache = { canvas, g: canvas.getContext('2d')!, pattern: null, scale: -1, scroll: -1, owner: -1, ring: -2, used: 0 };
      this.fit(s.cache, p, scale);
    }
    return s.cache;
  }

  /** 배율에 맞게 캐시 캔버스 크기를 맞춘다 (조금 큰 것은 그대로 써서 확대/축소 중 재할당을 줄인다) */
  private fit(c: PlanetCache, p: Planet, scale: number): void {
    const size = Math.ceil((p.atmosphereRadius + 4) * 2 * scale) + 2;
    if (c.canvas.width < size || c.canvas.width > size * 1.3) c.canvas.width = c.canvas.height = size;
  }

  /** 행성 하나를 원점 기준으로 그린다 (캐시 캔버스 또는 화면에 직접) */
  private paint(
    g: CanvasRenderingContext2D,
    p: Planet,
    s: PlanetState,
    art: PlanetArt | null,
    pattern: CanvasPattern | null,
    color: string,
    scroll: number,
    px: number,
    ring: boolean,
  ): void {
    const R = p.radius;
    const A = p.atmosphereRadius;
    const twoPi = Math.PI * 2;

    // 대기: 표면에서 경계로 갈수록 옅어지는 소유자 색 (중립은 단색으로 아주 옅게)
    g.beginPath();
    g.arc(0, 0, A, 0, twoPi);
    if (p.owner === NEUTRAL) {
      g.fillStyle = 'rgba(184,196,214,0.035)';
    } else {
      const atmo = g.createRadialGradient(0, 0, R * 0.9, 0, 0, A);
      atmo.addColorStop(0, withAlpha(color, 0.16));
      atmo.addColorStop(0.55, withAlpha(color, 0.056));
      atmo.addColorStop(0.92, withAlpha(color, 0.04));
      atmo.addColorStop(1, withAlpha(color, 0.1));
      g.fillStyle = atmo;
    }
    g.fill();

    // 광륜: 표면 바로 바깥의 부드러운 빛
    if (p.owner !== NEUTRAL) {
      g.globalCompositeOperation = 'lighter';
      g.globalAlpha = 0.36;
      drawSprite(g, softSprite(color), 0, 0, R * 1.65);
      g.globalAlpha = 1;
      g.globalCompositeOperation = 'source-over';
    }

    // 표면 (가로로 이어지는 텍스처를 밀어서 자전) + 고정 조명
    g.beginPath();
    g.arc(0, 0, R, 0, twoPi);
    if (art && pattern) {
      const m = this.matrix;
      m.a = m.d = 1 / art.scale;
      m.b = m.c = 0;
      m.e = -R - scroll;
      m.f = -R;
      pattern.setTransform(m);
      g.fillStyle = pattern;
      g.fill();
      g.drawImage(art.shade, -R, -R, R * 2, R * 2);
    } else {
      // 굽기 전 한두 프레임만 보이는 대체 그림
      const fallback = g.createRadialGradient(-R * 0.4, -R * 0.4, R * 0.1, 0, 0, R);
      fallback.addColorStop(0, '#7b8597');
      fallback.addColorStop(1, '#151923');
      g.fillStyle = fallback;
      g.fill();
    }

    // 가장자리 빛 (소유자 색, 광원 쪽이 밝다)
    const rim = g.createLinearGradient(-R, -R, R, R);
    rim.addColorStop(0, withAlpha(mixHex(color, '#ffffff', 0.35), 0.95));
    rim.addColorStop(0.5, withAlpha(color, 0.55));
    rim.addColorStop(1, withAlpha(color, 0.2));
    g.lineWidth = Math.max(1.3 * px, 0.9);
    g.strokeStyle = rim;
    g.beginPath();
    g.arc(0, 0, R - 0.4, 0, twoPi);
    g.stroke();

    if (ring) this.drawDefenseRing(g, 0, 0, p, s, color, px, 1);
  }

  /** 매 프레임 바뀌는 것들: 마우스 강조, 피격 번쩍임, 대기권 경계 점선, 점령 연출, 위험 고리 */
  private drawLive(
    ctx: CanvasRenderingContext2D,
    world: World,
    p: Planet,
    s: PlanetState,
    color: string,
    px: number,
    hovered: boolean,
    clock: number,
    reduced: boolean,
    low: boolean,
  ): void {
    const R = p.radius;
    const twoPi = Math.PI * 2;
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.atmosphereRadius, 0, twoPi);
    if (hovered) {
      ctx.fillStyle = withAlpha(color, 0.07);
      ctx.fill();
    }

    // 공격받는 중: 대기권 전체가 공격자 색으로 번쩍인다
    const sinceHit = world.time - p.lastAssaultAt;
    if (sinceHit < 0.5 && p.lastAssaultBy !== p.owner) {
      const a = 1 - sinceHit / 0.5;
      const attacker = world.factions[p.lastAssaultBy].color;
      ctx.fillStyle = withAlpha(attacker, 0.07 * a);
      ctx.fill();
      ctx.lineWidth = Math.max(2.5 * px, 1.5);
      ctx.strokeStyle = withAlpha(attacker, 0.55 * a);
      ctx.stroke();
    }

    // 경계 점선: 천천히 돌아서 '살아 있는' 막처럼 보인다
    ctx.setLineDash([5 * px, 4 * px]);
    ctx.lineDashOffset = reduced ? 0 : -clock * 6 * px;
    ctx.lineWidth = (hovered ? 1.8 : 1.15) * px;
    ctx.strokeStyle = withAlpha(color, hovered ? 0.8 : p.owner === NEUTRAL ? 0.32 : 0.45);
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.atmosphereRadius, 0, twoPi);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.lineDashOffset = 0;

    if (s.hit > 0 && p.owner !== NEUTRAL) {
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = s.hit * 0.25;
      drawSprite(ctx, softSprite(color), p.x, p.y, R * 1.65);
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
    }

    // 점령 연출: 새 주인의 색이 시계 방향으로 행성을 덮으며 지나간다
    if (s.sweep < 1) {
      const e = 1 - Math.pow(1 - s.sweep, 3);
      const a0 = -Math.PI / 2;
      ctx.globalCompositeOperation = 'lighter';
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
      ctx.arc(p.x, p.y, R, a0, a0 + e * twoPi);
      ctx.closePath();
      ctx.fillStyle = withAlpha(s.sweepColor, 0.55 * (1 - s.sweep));
      ctx.fill();
      ctx.globalCompositeOperation = 'source-over';
    }

    // 생산 순간 표면 테두리가 살짝 빛난다
    if (s.birth > 0) {
      ctx.lineWidth = Math.max(1.6 * px, 1);
      ctx.strokeStyle = withAlpha(mixHex(color, '#ffffff', 0.5), 0.6 * s.birth);
      ctx.beginPath();
      ctx.arc(p.x, p.y, R - 0.4, 0, twoPi);
      ctx.stroke();
    }

    const pulse = reduced ? 1 : 0.55 + 0.45 * Math.sin(clock * 9);
    if (low) this.drawDefenseRing(ctx, p.x, p.y, p, s, color, px, pulse);
    if (low || s.hit > 0) {
      // 피격 · 위험 시 고리가 번쩍인다
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = Math.max(low ? 0.35 * pulse : 0, s.hit * 0.8);
      ctx.lineCap = 'butt';
      ctx.lineWidth = Math.max(2.6, 2.4 * px) * 2.4;
      ctx.strokeStyle = low ? LOW_DEFENSE : mixHex(s.hitColor, '#ffffff', 0.3);
      ctx.beginPath();
      ctx.arc(p.x, p.y, R + 4.5, -Math.PI / 2, -Math.PI / 2 + Math.max(0.02, s.shown) * twoPi);
      ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
    }
  }

  /** 24칸 방어도 고리. pulse = 위험 상태 깜빡임 (1 = 최대) */
  private drawDefenseRing(g: CanvasRenderingContext2D, cx: number, cy: number, p: Planet, s: PlanetState, color: string, px: number, pulse: number): void {
    const r = p.radius + 4.5;
    const w = Math.max(2.6, 2.4 * px);
    const a0 = -Math.PI / 2;
    // 칸 나누기는 점선으로: 칸마다 호를 따로 그리는 것보다 싸다 (경계 가운데에 틈이 오도록 맞춘다)
    const step = (Math.PI * 2 * r) / SEGMENTS;
    const gap = Math.min(step * 0.3, 1.3 * Math.max(1, px));
    g.setLineDash([step - gap, gap]);
    g.lineDashOffset = step - gap / 2;
    g.lineCap = 'butt';
    g.lineWidth = w;
    const arc = (to: number) => {
      g.beginPath();
      g.arc(cx, cy, r, a0, a0 + to * Math.PI * 2);
    };

    // 빈 칸 (전체 바탕) → 최근 피해 자국 → 남은 방어도 순으로 덮는다
    arc(1);
    g.strokeStyle = 'rgba(200,215,240,0.13)';
    g.stroke();
    if (s.trail > s.shown + 0.002) {
      arc(s.trail);
      g.strokeStyle = 'rgba(255,244,230,0.75)';
      g.stroke();
    }
    if (s.shown > 0.0005) {
      arc(s.shown);
      g.strokeStyle = s.shown < 0.3 ? withAlpha(LOW_DEFENSE, 0.6 + 0.4 * pulse) : p.owner === NEUTRAL ? NEUTRAL_RING : color;
      g.stroke();
    }
    g.setLineDash([]);
    g.lineDashOffset = 0;
  }

  private drawProduction(ctx: CanvasRenderingContext2D, p: Planet, color: string, px: number, clock: number): void {
    const r = p.radius + 4.5 + Math.max(2.6, 2.4 * px) / 2 + Math.max(1.6, 2 * px);
    const full = p.orbitCount[p.owner] >= p.capacity;
    ctx.lineWidth = Math.max(0.9 * px, 0.6);
    ctx.beginPath();
    if (full) {
      // 정원이 찼다: 생산이 멈춘 상태임을 노란 점선 고리로
      ctx.setLineDash([2 * px, 3 * px]);
      ctx.strokeStyle = withAlpha(FULL, 0.45 + 0.25 * Math.sin(clock * 4));
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
    } else if (p.prodProgress > 0.01) {
      ctx.strokeStyle = withAlpha(mixHex(color, '#ffffff', 0.3), 0.6);
      ctx.arc(p.x, p.y, r, -Math.PI / 2, -Math.PI / 2 + p.prodProgress * Math.PI * 2);
      ctx.stroke();
    }
  }

  // ───────────────────────────── 이름표 (병력 위) ─────────────────────────────

  drawLabels(ctx: CanvasRenderingContext2D, world: World, zoom: number, view: ViewRect, clock: number): void {
    const px = 1 / zoom;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const shadow = softSprite('#03040a');
    for (const p of world.planets) {
      if (!inView(view, p.x, p.y, p.atmosphereRadius + 20)) continue;
      const count = p.orbitCount[p.owner];
      const fontPx = Math.max(11, Math.min(24, p.radius * zoom * 0.78));
      const size = fontPx * px;
      const full = count >= p.capacity && p.owner !== NEUTRAL;

      // 글자 뒤를 살짝 어둡게 해서 무늬가 있는 표면 위에서도 읽히게
      ctx.globalAlpha = 0.55;
      const sr = size * 1.25;
      ctx.drawImage(shadow.img, shadow.sx, shadow.sy, shadow.size, shadow.size, p.x - sr, p.y - sr * 0.8, sr * 2, sr * 1.6);
      ctx.globalAlpha = 1;

      ctx.font = `800 ${size}px system-ui, sans-serif`;
      ctx.lineWidth = 3 * px;
      ctx.strokeStyle = 'rgba(0,0,0,0.6)';
      ctx.strokeText(String(count), p.x, p.y);
      ctx.fillStyle = full ? FULL : '#ffffff';
      ctx.fillText(String(count), p.x, p.y);

      if (full && p.radius * zoom > 15) {
        ctx.font = `800 ${size * 0.42}px system-ui, sans-serif`;
        ctx.fillStyle = withAlpha(FULL, 0.85);
        ctx.fillText('MAX', p.x, p.y + size * 0.78);
      }

      if (p.isHome && p.owner !== NEUTRAL) this.drawHomeMarker(ctx, world, p, px, clock);
    }
  }

  /** 모성 표시: 고리 위쪽의 빛나는 별 모양 표지 */
  private drawHomeMarker(ctx: CanvasRenderingContext2D, world: World, p: Planet, px: number, clock: number): void {
    const color = world.factions[p.owner].color;
    const x = p.x;
    const y = p.y - p.radius - 4.5 - Math.max(2.6, 2.4 * px) / 2 - Math.max(5.5, 7 * px);
    const s = Math.max(4, 5.5 * px);
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = 0.5 + 0.2 * Math.sin(clock * 2.5);
    drawSprite(ctx, softSprite(color), x, y, s * 2.6);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.beginPath();
    for (let i = 0; i < 8; i++) {
      const a = -Math.PI / 2 + (i * Math.PI) / 4;
      const r = i % 2 === 0 ? s : s * 0.38;
      const vx = x + Math.cos(a) * r, vy = y + Math.sin(a) * r;
      if (i === 0) ctx.moveTo(vx, vy);
      else ctx.lineTo(vx, vy);
    }
    ctx.closePath();
    ctx.fillStyle = mixHex(color, '#ffffff', 0.55);
    ctx.fill();
    ctx.lineWidth = Math.max(0.8 * px, 0.5);
    ctx.strokeStyle = color;
    ctx.stroke();
  }

  private ownerColor(world: World, p: Planet): string {
    return p.owner === NEUTRAL ? NEUTRAL_RING : world.factions[p.owner].color;
  }
}
