import { NEUTRAL, type Planet } from '../sim/types';
import type { World } from '../sim/world';
import type { Bloom } from './bloom';
import { inView, type Effects, type ViewRect } from './effects';
import { lightAt, nightFactor, PlanetBaker, type PlanetArt } from './planetArt';
import { drawSprite, glowSprite, makeCanvas, mixHex, softSprite, withAlpha } from './sprites';

// 행성: 대기권(게임 규칙상 '안 = 강하, 밖 = 교전' 경계라 늘 또렷하게) · 표면 · 방어도 고리 · 생산 진행 · 이름표.
// 소유 진영은 표면 색이 아니라 바깥 고리 · 대기 광륜 · 가장자리 빛 · 밤쪽 도시 불빛으로 알린다 (표면은 자연스러운 행성 그대로).
//
// 대기 · 광륜 · 표면 · 구름 · 조명 · 도시 불빛 · 방어도 고리는 행성마다 화면 해상도(크게 확대하면 MAX_CACHE_SCALE 까지)의 캔버스 한 장에 합쳐 두고
// (자전 · 구름이 0.6px 이상 밀렸거나, 확대 배율 · 보이는 색 · 방어도 · 불빛 수가 바뀔 때만 다시 그림) 매 프레임 한 번만 찍는다
// (크게 확대했을 때 화면 밖으로 절반 넘게 나간 행성만 보이는 부분을 직접 그린다: DIRECT_SCALE).
// 축소 · 패턴 · 점선이 섞인 그리기는 GPU 가 없거나 약한 기기에서 특히 비싸기 때문이다.

const NEUTRAL_RING = '#b8c4d6';
const LOW_DEFENSE = '#ff5a5a';
const FULL = '#ffd166';
/** 도시 불빛은 진영 색을 따뜻한 전등 색 쪽으로 조금 섞는다 (진영 색 그대로면 네온 간판처럼 보인다) */
const CITY_LIGHT = '#ffd9a0';
/** 방어도가 바닥난 행성의 불길 */
const FIRE = '#ff7a2e';
/** 방어도 고리 칸 수 */
const SEGMENTS = 24;
/** 한 프레임에 행성 텍스처를 굽는 시간 예산(ms). 시작할 때 한꺼번에 굽느라 멈추지 않게 나눈다 */
const BAKE_BUDGET_MS = 5;
/**
 * 캐시 캔버스의 최대 배율(기기 px / 월드 단위) = 최대 확대 3.2 × 렌더러의 DPR 상한 2. 이보다 크게 확대되면(세계가 작아
 * 최소 확대가 3.2 를 넘는 경우뿐) 캐시를 이 배율로 그려 늘려 찍는다. 가장 큰 행성도 캐시가 800px 남짓이다.
 * (예전처럼 5 를 넘으면 직접 그리면 DPR 2 화면에서 2.5배 넘게 확대했을 때 보이는 행성 전부를 매 프레임 통째로 다시 칠한다.
 * 5 에서 멈추고 늘려 찍으면 확대 3.2 에서 고리 · 테두리가 흐려지고, 2.6~2.9 에서는 보간 복사라 1:1 복사보다 오히려 비싸다)
 */
export const MAX_CACHE_SCALE = 6.4;
/**
 * 이 배율(기기 px / 월드 단위)을 넘게 확대했을 때 화면에 절반도 걸치지 않은 행성은 캐시 대신 보이는 부분만 직접 그린다.
 * 그만큼 확대하면 캐시 한 장이 수십만 px 이라, 자전 때문에 다시 그릴 때마다 화면 밖 부분까지 칠하는 값이 보이는 부분만
 * 매 프레임 칠하는 값보다 커진다 (화면을 채운 행성은 캐시가 2~3배 싸다)
 */
const DIRECT_SCALE = 5;
/** 점령 후 새 주인의 색이 행성을 덮어 가는 시간(초) */
const FLOOD_TIME = 0.8;
/** 마지막 강하 피해 뒤 '포위당하는 중' 표시가 남는 시간(초) */
const SIEGE_TIME = 1.2;
/** 방어도가 이 비율 아래면 위험 (고리 깜빡임 · 불길 · 연기) */
const LOW = 0.3;

interface PlanetCache {
  canvas: HTMLCanvasElement;
  g: CanvasRenderingContext2D;
  pattern: CanvasPattern | null;
  cloudPattern: CanvasPattern | null;
  scale: number;
  scroll: number;
  /** 그려 둔 소유 색 (점령 직후에는 이전 주인의 색) */
  color: string;
  ring: number;
  /** 도시 불빛 수 · 부가 연출 · 위험 상태를 묶은 값 */
  detail: number;
  used: number;
}

interface PlanetState {
  art: PlanetArt | null;
  baker: PlanetBaker | null;
  cache: PlanetCache | null;
  /** 점령 연출 중 새 주인의 모습 (연출이 끝나면 cache 가 된다) */
  next: PlanetCache | null;
  /** 화면에 보이는 방어도 비율 (실제 값을 부드럽게 따라간다) */
  shown: number;
  /** 최근 피해 자국: 잠시 머물렀다가 shown 으로 줄어든다 (격투 게임 체력바처럼) */
  trail: number;
  trailHold: number;
  /** 방어도 고리가 움직이는 중 (피해 · 회복): 그동안은 캐시에 넣지 않고 매 프레임 그린다 */
  ringLive: boolean;
  /** 피격 번쩍임 0~1 */
  hit: number;
  hitColor: string;
  /** 점령 연출: 0 → 1 동안 새 주인 색이 entry 쪽에서 번져 나간다. 그동안 캐시는 prevColor 로 그린다 */
  flood: number;
  prevColor: string;
  /** 공격군이 들어온 방향 (행성 중심 기준 각도) */
  entry: number;
  /** 생산 섬광 0~1 */
  birth: number;
}

/** 표면 그리기 한 번에 필요한 값들 */
interface PaintParams {
  color: string;
  scroll: number;
  cloudScroll: number;
  /** 켤 도시 불빛 수 */
  lit: number;
  /** 대기 산란 */
  extras: boolean;
  px: number;
  ring: boolean;
}

/** 품질 · 효과 연결 */
export interface PlanetDrawOptions {
  /** 도시 불빛 · 따로 흐르는 구름 · 대기 산란 · 피해 연기 (품질 낮음에서는 끈다) */
  extras: boolean;
  /** 자전으로 이만큼(화면 px) 밀리면 캐시를 다시 그린다 (품질 낮음은 덜 자주) */
  spinStep: number;
  reduced: boolean;
  fx: Effects;
  bloom: Bloom | null;
  dt: number;
}

interface Patterns {
  surface: CanvasPattern | null;
  clouds: CanvasPattern | null;
}

const spot = { x: 0, y: 0 };
const wave = { x: 0, y: 0, r: 0 };

/** 캐시 캔버스를 그릴 배율: 화면 배율 그대로, 단 MAX_CACHE_SCALE 까지 (그 위로는 캐시를 늘려 찍는다) */
export function cacheScale(scale: number): number {
  return Math.min(scale, MAX_CACHE_SCALE);
}

/** 행성(중심 x, y · 반지름 r 의 네모)이 보이는 영역에 걸친 비율 0~1 */
export function onScreenShare(view: ViewRect, x: number, y: number, r: number): number {
  const w = Math.max(0, Math.min(view.x1, x + r) - Math.max(view.x0, x - r));
  const h = Math.max(0, Math.min(view.y1, y + r) - Math.max(view.y0, y - r));
  return (w * h) / (4 * r * r);
}

/**
 * 점령 물결의 원 (행성 중심 기준). 공격군이 들어온 표면 자리(entry 방향)에서 퍼져 나가,
 * flood = 1 이면 들어온 자리에서 반대쪽 대기권 끝까지(R + A)에 여유 2 를 더해 대기권 전체를 덮는다
 */
export function floodCircle(R: number, A: number, entry: number, flood: number, out: { x: number; y: number; r: number }): void {
  const e = 1 - Math.pow(1 - flood, 3);
  out.x = Math.cos(entry) * R;
  out.y = Math.sin(entry) * R;
  out.r = Math.max(0.1, e * (R + A + 2));
}

export class PlanetLayer {
  private states: PlanetState[] = [];
  private matrix = new DOMMatrix();
  /** 직접 그리기(크게 확대해 화면 가장자리에 걸친 행성)용 패턴. 패턴은 만든 컨텍스트에서 쓴다 */
  private patterns = new Map<number, Patterns>();
  private frames = 0;
  /** 직전 프레임의 배율. 확대/축소 중에는 캐시를 늘려서 쓰고, 멈추면 그 배율로 다시 그린다 */
  private prevScale = 0;

  private state(p: Planet): PlanetState {
    let s = this.states[p.id];
    if (!s) {
      const f = Math.max(0, p.defense / p.maxDefense);
      s = this.states[p.id] = {
        art: null, baker: null, cache: null, next: null, shown: f, trail: f, trailHold: 0, ringLive: false, hit: 0, hitColor: '#ffffff', flood: 1, prevColor: NEUTRAL_RING, entry: 0, birth: 0,
      };
    }
    return s;
  }

  hit(p: Planet, color: string): void {
    const s = this.state(p);
    s.hit = 1;
    s.hitColor = color;
  }

  /** 점령: fromColor = 이전 주인 색(중립이면 null), entry = 공격군이 들어온 방향 */
  captured(p: Planet, fromColor: string | null, entry: number): void {
    const s = this.state(p);
    // 연출 도중 다시 넘어가면 지금 보이던 색에서 이어 간다
    s.prevColor = s.flood < 1 ? s.prevColor : (fromColor ?? NEUTRAL_RING);
    s.flood = 0;
    s.entry = entry;
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
      s.ringLive = s.shown !== f || s.trail !== s.shown;
      s.hit = Math.max(0, s.hit - dt * 3.5);
      s.birth = Math.max(0, s.birth - dt * 4);
      if (s.flood < 1) s.flood = Math.min(1, s.flood + dt / FLOOD_TIME);
    }
  }

  // ───────────────────────────── 행성 (병력 아래) ─────────────────────────────

  draw(ctx: CanvasRenderingContext2D, world: World, zoom: number, view: ViewRect, hover: number, clock: number, opts: PlanetDrawOptions): void {
    const { reduced, extras } = opts;
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
      // 점령 연출 중에는 물결 바깥이 이전 주인의 모습이다 (아래 flooding)
      const shownColor = s.flood < 1 ? s.prevColor : color;
      if (!s.art) this.bake(p, s, bakeDeadline);
      const art = s.art;
      const low = s.shown < LOW;
      const period = art ? art.surface.width / art.scale : 1;
      const scroll = art && !reduced ? mod(clock * art.spin, period) : 0;
      // 구름: 품질이 낮으면 표면에 붙여 같이 돈다. 따로 흐를 때도 다시 그리는 시점은 표면 자전이 정한다
      // (구름 때문에 따로 다시 그리면 캐시 다시 그리기가 40% 늘고, 한 번마다 캔버스 복사가 따라붙어 비싸다)
      const cloudScroll = art?.clouds && extras && !reduced ? mod(clock * art.cloudSpin, period) : scroll;
      const lit = (color: string) => (extras && art && color !== NEUTRAL_RING ? this.litCount(p, art, low) : 0);
      // 고리가 움직이는 동안(공격받는 중 · 회복 중 · 위험)은 매 프레임 직접 그린다. 캐시에 넣으면 고리가 바뀔 때마다
      // 행성 전체를 다시 그리고 복사하게 되는데, 전투 중인 행성은 그게 매 프레임이다
      const liveRing = low || s.ringLive;
      const params: PaintParams = { color: shownColor, scroll, cloudScroll, lit: lit(shownColor), extras, px, ring: !liveRing };

      // 점령 연출: 이전 주인의 모습(s.cache)은 물결 바깥에만, 새 주인의 모습(s.next)은 물결 안에만 찍는다.
      // 새 모습을 이전 모습 위에 겹쳐 칠하면 반투명 대기 · 가산 광륜이 두 겹으로 쌓였다가 연출이 끝나는 프레임에 한 겹으로
      // 돌아가며 확 어두워진다. 새 모습도 같은 방식(캐시)으로 그려 두었다가 끝나면 그대로 이어 쓰므로 마지막 프레임과 똑같다
      // (화면에 바로 그리면 가산 광륜이 투명 캐시에 그린 것보다 밝아 그만큼 또 튄다)
      const flooding = s.flood < 1;
      if (!flooding && s.next) {
        s.cache = s.next;
        s.next = null;
      }
      if (flooding) {
        floodCircle(p.radius, p.atmosphereRadius, s.entry, s.flood, wave);
        const half = 2 * (p.radius + p.atmosphereRadius) + 8;
        ctx.save();
        ctx.beginPath();
        ctx.rect(p.x - half, p.y - half, half * 2, half * 2);
        ctx.arc(p.x + wave.x, p.y + wave.y, wave.r, 0, Math.PI * 2);
        ctx.clip('evenodd');
      }
      const direct = scale > DIRECT_SCALE && onScreenShare(view, p.x, p.y, p.atmosphereRadius + 4) < 0.5;
      this.drawPlanet(ctx, m, p, s, art, 'cache', direct, scale, zooming, clock, opts.spinStep, params);
      if (flooding) {
        ctx.restore();
        const next: PaintParams = { ...params, color, lit: lit(color) };
        ctx.save();
        ctx.beginPath();
        ctx.arc(p.x + wave.x, p.y + wave.y, wave.r, 0, Math.PI * 2);
        ctx.clip();
        this.drawPlanet(ctx, m, p, s, art, 'next', direct, scale, zooming, clock, opts.spinStep, next);
        ctx.restore();
        this.drawFlood(ctx, p, s, next);
      }
      this.drawLive(ctx, world, p, s, color, px, hover === p.id, clock, low, liveRing, art, scroll, opts);
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
      for (const s of this.states) {
        if (s?.cache && clock - s.cache.used > 3) s.cache = null;
        if (s?.next && clock - s.next.used > 3) s.next = null;
      }
    }
  }

  /** 켤 도시 불빛 수: 크기(생산)만큼 있는 도시 중 궤도 병력이 찰수록 더 많이. 위험 상태면 대부분 정전 */
  private litCount(p: Planet, art: PlanetArt, low: boolean): number {
    const total = art.lights.length / 3;
    const garrison = p.owner === NEUTRAL ? 0 : p.orbitCount[p.owner];
    // 10 단계로 끊어 병력이 한 기씩 늘 때마다 캐시를 다시 그리지 않게
    const k = Math.round(Math.min(1, 0.2 + (0.8 * garrison) / p.capacity) * 10) / 10;
    return Math.round(total * k * (low ? 0.35 : 1));
  }

  /** 화면에 직접 그릴 때 쓰는 패턴 (캐시 캔버스의 패턴은 그 컨텍스트 전용이라 따로 둔다) */
  private directPatterns(ctx: CanvasRenderingContext2D, p: Planet, art: PlanetArt | null): Patterns {
    let pats = this.patterns.get(p.id);
    if (!pats && art) {
      pats = { surface: ctx.createPattern(art.surface, 'repeat-x'), clouds: art.clouds ? ctx.createPattern(art.clouds, 'repeat-x') : null };
      this.patterns.set(p.id, pats);
    }
    return pats ?? { surface: null, clouds: null };
  }

  private bake(p: Planet, s: PlanetState, deadline: number): void {
    if (performance.now() > deadline) return;
    s.baker ??= new PlanetBaker(p);
    if (s.baker.step(deadline)) {
      s.art = s.baker.art;
      s.baker = null;
    }
  }

  /**
   * 행성 하나를 캐시 s[slot] 으로 찍는다 (slot = 'cache' 지금 보이는 모습, 'next' 점령 연출 중 새 주인의 모습).
   * 캐시는 배율 · 색 · 고리 · 불빛이 바뀌었거나 자전으로 spinStep 이상 밀렸을 때만 다시 그린다.
   * direct(크게 확대해 화면 가장자리에 걸친 행성)이거나 굽기 전(대체 그림)이면 화면에 직접 그린다
   */
  private drawPlanet(
    ctx: CanvasRenderingContext2D,
    m: DOMMatrix,
    p: Planet,
    s: PlanetState,
    art: PlanetArt | null,
    slot: 'cache' | 'next',
    direct: boolean,
    scale: number,
    zooming: boolean,
    clock: number,
    spinStep: number,
    o: PaintParams,
  ): void {
    if (!art || direct) {
      ctx.save();
      ctx.translate(p.x, p.y);
      this.paint(ctx, p, s, art, this.directPatterns(ctx, p, art), o);
      ctx.restore();
      return;
    }
    const cs = cacheScale(scale);
    const c = (s[slot] ??= this.newCache(p, cs));
    const period = art.surface.width / art.scale;
    const ringKey = o.ring ? Math.round(s.shown * 480) * 1000 + Math.round(s.trail * 480) : -1;
    const detail = o.lit * 4 + (o.extras ? 2 : 0) + (s.shown < LOW ? 1 : 0);
    const spun = wrapDist(o.scroll, c.scroll, period);
    const ratio = cs / c.scale;
    // 확대/축소가 진행 중이면 (배율 차이가 크지 않은 한) 기존 캐시를 늘려 쓰고, 멈춘 뒤에 다시 그린다
    const rescale = c.scale !== cs && (!zooming || ratio < 0.8 || ratio > 1.25);
    if (rescale || c.color !== o.color || c.ring !== ringKey || c.detail !== detail || spun * c.scale >= spinStep) {
      if (c.scale !== cs) this.fit(c, p, cs);
      const g = c.g;
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.clearRect(0, 0, c.canvas.width, c.canvas.height);
      g.setTransform(cs, 0, 0, cs, c.canvas.width / 2, c.canvas.height / 2);
      c.pattern ??= g.createPattern(art.surface, 'repeat-x');
      if (art.clouds) c.cloudPattern ??= g.createPattern(art.clouds, 'repeat-x');
      this.paint(g, p, s, art, { surface: c.pattern, clouds: c.cloudPattern }, o);
      c.scale = cs;
      c.color = o.color;
      c.ring = ringKey;
      c.detail = detail;
      c.scroll = o.scroll;
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
  }

  private newCache(p: Planet, scale: number): PlanetCache {
    const canvas = makeCanvas(1, 1);
    const c: PlanetCache = { canvas, g: canvas.getContext('2d')!, pattern: null, cloudPattern: null, scale: -1, scroll: -1, color: '', ring: -2, detail: -1, used: 0 };
    this.fit(c, p, scale);
    return c;
  }

  /** 배율에 맞게 캐시 캔버스 크기를 맞춘다 (조금 큰 것은 그대로 써서 확대/축소 중 재할당을 줄인다) */
  private fit(c: PlanetCache, p: Planet, scale: number): void {
    const size = Math.ceil((p.atmosphereRadius + 4) * 2 * scale) + 2;
    if (c.canvas.width < size || c.canvas.width > size * 1.3) c.canvas.width = c.canvas.height = size;
  }

  /** 행성 하나를 원점 기준으로 그린다 (캐시 캔버스 또는 화면에 직접) */
  private paint(g: CanvasRenderingContext2D, p: Planet, s: PlanetState, art: PlanetArt | null, pats: Patterns, o: PaintParams): void {
    const R = p.radius;
    const A = p.atmosphereRadius;
    const twoPi = Math.PI * 2;
    const { color, px } = o;
    // 점령 연출 중의 이전 모습은 주인이 바뀐 뒤에도 중립으로 그려야 하므로 소유자가 아니라 색으로 판단한다
    const neutral = color === NEUTRAL_RING;

    // 대기: 표면에서 경계로 갈수록 옅어지는 소유자 색 (중립은 단색으로 아주 옅게)
    g.beginPath();
    g.arc(0, 0, A, 0, twoPi);
    if (neutral) {
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
    if (!neutral) {
      g.globalCompositeOperation = 'lighter';
      g.globalAlpha = 0.36;
      drawSprite(g, softSprite(color), 0, 0, R * 1.65);
      g.globalAlpha = 1;
      g.globalCompositeOperation = 'source-over';
    }

    // 표면 (가로로 이어지는 텍스처를 밀어서 자전) + 구름 (조금 더 빨리 흐른다) + 고정 조명 + 밤쪽 불빛
    g.beginPath();
    g.arc(0, 0, R, 0, twoPi);
    if (art && pats.surface) {
      const m = this.matrix;
      m.a = m.d = 1 / art.scale;
      m.b = m.c = 0;
      m.e = -R - o.scroll;
      m.f = -R;
      pats.surface.setTransform(m);
      g.fillStyle = pats.surface;
      g.fill();
      if (pats.clouds) {
        m.e = -R - o.cloudScroll;
        pats.clouds.setTransform(m);
        g.fillStyle = pats.clouds;
        g.fill();
      }
      g.drawImage(art.shade, -R, -R, R * 2, R * 2);
      if (o.lit > 0) drawCityLights(g, art, R, o.scroll, o.lit, color, px);
      if (o.extras) drawRimScatter(g, R, art.haze, px);
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

    if (o.ring) this.drawDefenseRing(g, 0, 0, p, s, color, px, 1);
  }

  /**
   * 점령 연출: 공격군이 들어온 쪽 표면에서 새 주인의 모습(대기 · 광륜 · 가장자리 · 고리 · 불빛)이 물결처럼 번져
   * 0.8초 만에 행성 전체를 덮는다 (두 모습은 draw() 가 물결 원 안팎으로 나눠 찍었다).
   * 여기서는 물결 앞머리를 밝게, 덮인 표면을 잠깐 새 주인 색으로 물들인다. 둘 다 끝날 때 0 으로 사라진다
   */
  private drawFlood(ctx: CanvasRenderingContext2D, p: Planet, s: PlanetState, o: PaintParams): void {
    const R = p.radius, A = p.atmosphereRadius;
    const twoPi = Math.PI * 2;
    const ex = p.x + wave.x, ey = p.y + wave.y;
    const rad = wave.r;
    const fade = 1 - s.flood;

    ctx.globalCompositeOperation = 'lighter';
    // 덮인 표면을 새 색으로 잠깐 물들인다
    ctx.save();
    ctx.beginPath();
    ctx.arc(p.x, p.y, R, 0, twoPi);
    ctx.clip();
    ctx.beginPath();
    ctx.arc(ex, ey, rad, 0, twoPi);
    ctx.fillStyle = withAlpha(o.color, 0.42 * fade);
    ctx.fill();
    ctx.restore();
    // 물결 앞머리 (대기권 안쪽만)
    ctx.save();
    ctx.beginPath();
    ctx.arc(p.x, p.y, A, 0, twoPi);
    ctx.clip();
    ctx.beginPath();
    ctx.arc(ex, ey, rad, 0, twoPi);
    ctx.strokeStyle = withAlpha(mixHex(o.color, '#ffffff', 0.45), 0.9 * fade);
    ctx.lineWidth = Math.max(2.4 * o.px, 1.4);
    ctx.stroke();
    ctx.globalAlpha = 0.35 * fade;
    ctx.lineWidth = Math.max(7 * o.px, 4);
    ctx.strokeStyle = o.color;
    ctx.stroke();
    ctx.restore();
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }

  /** 매 프레임 바뀌는 것들: 마우스 강조, 피격 번쩍임, 포위 표시, 대기권 경계 점선, 위험 고리 · 불길 */
  private drawLive(
    ctx: CanvasRenderingContext2D,
    world: World,
    p: Planet,
    s: PlanetState,
    color: string,
    px: number,
    hovered: boolean,
    clock: number,
    low: boolean,
    liveRing: boolean,
    art: PlanetArt | null,
    scroll: number,
    opts: PlanetDrawOptions,
  ): void {
    const { reduced } = opts;
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

    if (sinceHit < SIEGE_TIME && p.lastAssaultBy !== p.owner) this.drawSiege(ctx, world, p, px, clock, sinceHit, reduced);

    if (s.hit > 0 && p.owner !== NEUTRAL) {
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = s.hit * 0.25;
      drawSprite(ctx, softSprite(color), p.x, p.y, R * 1.65);
      ctx.globalAlpha = 1;
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
    if (liveRing) this.drawDefenseRing(ctx, p.x, p.y, p, s, color, px, low ? pulse : 1);
    if (low && art) this.drawDamage(ctx, p, s, art, scroll, clock, opts);
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

  /**
   * 포위당하는 중: 대기권 경계에 공격자 색 꺾쇠가 안쪽을 겨누며 천천히 돈다.
   * 꺾쇠 크기 = 대기권 안 공격측 비율 (강하 한 발의 피해가 공격측 / (공격측 + 수비측) 에 비례하므로, 클수록 잘 깎이는 중)
   */
  private drawSiege(ctx: CanvasRenderingContext2D, world: World, p: Planet, px: number, clock: number, sinceHit: number, reduced: boolean): void {
    const by = p.lastAssaultBy;
    const atk = p.presence[by] ?? 0, def = p.presence[p.owner] ?? 0;
    const share = atk / Math.max(1, atk + def);
    const rec = 1 - sinceHit / SIEGE_TIME;
    const A = p.atmosphereRadius;
    // 화면에서 일정한 크기지만, 축소했을 때 행성보다 커 보이지 않게 대기권 두께의 일부로 묶는다
    const size = Math.min((5 + 5 * share) * px, (A - p.radius) * (0.3 + 0.25 * share));
    const half = (size * 0.7) / A;
    const rot = reduced ? 0 : clock * 0.5;
    // 속이 빈 V 꺾쇠가 경계선에 걸쳐 안쪽을 겨눈다 (안을 채운 화살촉은 함선과 헷갈린다)
    const tip = A - size * 0.45, base = A + size * 0.55;
    ctx.beginPath();
    for (let i = 0; i < 4; i++) {
      const a = rot + (i * Math.PI) / 2 + Math.PI / 4;
      ctx.moveTo(p.x + Math.cos(a - half) * base, p.y + Math.sin(a - half) * base);
      ctx.lineTo(p.x + Math.cos(a) * tip, p.y + Math.sin(a) * tip);
      ctx.lineTo(p.x + Math.cos(a + half) * base, p.y + Math.sin(a + half) * base);
    }
    const color = world.factions[by].color;
    ctx.lineJoin = 'miter';
    ctx.lineCap = 'butt';
    ctx.globalCompositeOperation = 'lighter';
    ctx.strokeStyle = color;
    ctx.globalAlpha = 0.2 * rec;
    ctx.lineWidth = 4.5 * px;
    ctx.stroke();
    ctx.globalAlpha = 0.3 + 0.6 * rec;
    ctx.strokeStyle = mixHex(color, '#ffffff', 0.25);
    ctx.lineWidth = 1.8 * px;
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }

  /**
   * 방어도가 바닥난 행성: 큰 도시 자리(표면과 같이 돈다)에서 불길이 일렁이고, 연기와 불티가 피어오른다.
   * 연기 · 불티는 부가 연출(품질)과 움직임 줄이기 설정을 따른다
   */
  private drawDamage(ctx: CanvasRenderingContext2D, p: Planet, s: PlanetState, art: PlanetArt, scroll: number, clock: number, opts: PlanetDrawOptions): void {
    const { reduced, extras, fx, bloom, dt } = opts;
    const R = p.radius;
    const sev = 1 - s.shown / LOW;
    const fires = 2 + Math.round(sev * 3);
    const fire = glowSprite(FIRE);
    const glow = bloom?.g ?? null;
    ctx.globalCompositeOperation = 'lighter';
    // 큰 도시부터, 지금 앞면에 보이는 자리만 (돌아서 뒤로 넘어가면 다음 도시가 탄다)
    const total = art.lights.length / 3;
    for (let i = 0, lit = 0; i < total && lit < fires; i++) {
      if (!lightAt(art.lights, i, R, scroll, spot)) continue;
      lit++;
      const x = p.x + spot.x, y = p.y + spot.y;
      const flick = reduced ? 0.7 : 0.6 + 0.4 * Math.sin(clock * (9 + i * 1.7) + i * 2.3) * Math.sin(clock * 5.3 + i);
      const r = 3 + 3.5 * sev;
      ctx.globalAlpha = 0.5 + 0.45 * flick;
      drawSprite(ctx, fire, x, y, r);
      if (glow && bloom) {
        glow.globalAlpha = 0.5 * flick;
        drawSprite(glow, fire, x, y, r * 2);
        bloom.mark(x, y, r * 2);
      }
      if (extras && !reduced) {
        if (Math.random() < dt * (1 + 3 * sev)) fx.smoke(x, y, 5 + 4 * sev);
        if (Math.random() < dt * 0.9) fx.embers(x, y, 2, FIRE, 22, 0.8);
      }
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    if (glow) glow.globalAlpha = 1;
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
      // 중립의 color 는 이미 NEUTRAL_RING (점령 연출 중의 이전 모습도 색으로 넘어온다)
      g.strokeStyle = s.shown < LOW ? withAlpha(LOW_DEFENSE, 0.6 + 0.4 * pulse) : color;
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

const mod = (a: number, m: number) => ((a % m) + m) % m;

/** 주기 period 위에서 두 위치의 거리 */
function wrapDist(a: number, b: number, period: number): number {
  const d = Math.abs(a - b) % period;
  return Math.min(d, period - d);
}

/**
 * 밤쪽 도시 불빛: 진영 색이 섞인 전등 빛 점들 (밝기 세 단계로 묶어 칠한다). 큰 도시는 은은한 빛무리도 얹는다.
 * 캐시를 다시 그릴 때만 불리므로 점 수십 개는 부담이 없다
 */
function drawCityLights(g: CanvasRenderingContext2D, art: PlanetArt, R: number, scroll: number, count: number, color: string, px: number): void {
  const tint = mixHex(color, CITY_LIGHT, 0.3);
  const paths = [new Path2D(), new Path2D(), new Path2D()];
  const halo = softSprite(tint);
  g.globalCompositeOperation = 'lighter';
  for (let i = 0; i < count; i++) {
    if (!lightAt(art.lights, i, R, scroll, spot)) continue;
    const night = nightFactor(spot.x, spot.y, R);
    if (night < 0.05) continue;
    const w = art.lights[i * 3 + 2];
    const a = night * (0.5 + 0.5 * w);
    const size = Math.max(1.1 * px, 0.5 + 0.8 * w);
    paths[a > 0.66 ? 2 : a > 0.33 ? 1 : 0].rect(spot.x - size / 2, spot.y - size / 2, size, size);
    // 큰 도시는 불빛이 번진 빛무리 (멀리서도 '사람이 사는 행성'으로 읽히게)
    if (w > 0.55 && night > 0.3) {
      g.globalAlpha = 0.5 * night * w;
      drawSprite(g, halo, spot.x, spot.y, Math.max(3 * px, 2.6 + 2 * w));
    }
  }
  g.fillStyle = tint;
  paths.forEach((path, b) => {
    g.globalAlpha = [0.4, 0.7, 1][b];
    g.fill(path);
  });
  g.globalAlpha = 1;
  g.globalCompositeOperation = 'source-over';
}

/** 가장자리 대기 산란: 광원(왼쪽 위) 쪽 둘레가 대기 색으로 옅게 빛나고 반대쪽으로 사라진다 */
function drawRimScatter(g: CanvasRenderingContext2D, R: number, haze: string, px: number): void {
  const grad = g.createLinearGradient(-R * 0.75, -R * 0.8, R * 0.45, R * 0.5);
  grad.addColorStop(0, withAlpha(haze, 0.75));
  grad.addColorStop(0.45, withAlpha(haze, 0.25));
  grad.addColorStop(1, withAlpha(haze, 0));
  g.globalCompositeOperation = 'lighter';
  g.strokeStyle = grad;
  g.beginPath();
  g.arc(0, 0, R * 1.03, 0, Math.PI * 2);
  g.globalAlpha = 0.35;
  g.lineWidth = Math.max(R * 0.22, 3 * px);
  g.stroke();
  g.globalAlpha = 0.8;
  g.lineWidth = Math.max(R * 0.06, 1.1 * px);
  g.stroke();
  g.globalAlpha = 1;
  g.globalCompositeOperation = 'source-over';
}
