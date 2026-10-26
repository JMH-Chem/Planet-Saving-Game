import type { World } from '../sim/world';
import { inView, type Effects, type ViewRect } from './effects';
import { drawSprite, glowSprite, mixHex, softSprite, withAlpha } from './sprites';

// 방어전 워프 게이트: 예고(opensAt) 동안 소용돌이가 점점 커지며 남은 초를 세고,
// 병력이 흘러나오는(spawnAt 이후) 동안에는 고리가 박동한다.

const FALLBACK = '#ff4fa3';

export function invaderColor(world: World): string {
  return world.factions.find((f) => f.invader)?.color ?? world.factions[2]?.color ?? FALLBACK;
}

/** 0(막 열림) → 1(병력 출현) */
function openness(world: World, opensAt: number, spawnAt: number): number {
  if (spawnAt <= opensAt) return 1;
  return Math.max(0, Math.min(1, (world.time - opensAt) / (spawnAt - opensAt)));
}

/** 게이트 반경 (월드 단위) */
function gateRadius(k: number): number {
  return 9 + 21 * (1 - Math.pow(1 - k, 2));
}

/** 마지막 병력이 나온 게이트가 빨려 들어가듯 오므라들며 사라지는 시간(초) */
const CLOSE_TIME = 0.5;

interface ClosingGate {
  id: number;
  x: number;
  y: number;
  /** 닫히기 시작한 렌더러 시각 */
  at: number;
}

/**
 * 게이트 층. 시뮬레이션은 마지막 병력이 나온 틱에 게이트를 목록에서 바로 빼므로(waves.ts),
 * 그대로 그리면 소용돌이가 한 프레임 만에 사라진다. 직전 프레임에 있던 게이트가 없어지면
 * id 로 알아채 그 자리에서 잠깐 닫히는 모습을 따로 그린다 (렌더러는 판마다 새로 만들어진다).
 */
export class GateLayer {
  /** 직전 프레임의 게이트 위치 (id →) */
  private seen = new Map<number, { x: number; y: number }>();
  private closing: ClosingGate[] = [];

  /** 사라진 게이트를 닫힘 목록에 올리고, 다 닫힌 것은 마지막 섬광과 함께 내린다 */
  update(world: World, clock: number, fx: Effects, view: ViewRect): void {
    if (this.seen.size === 0 && world.gates.length === 0 && this.closing.length === 0) return;
    for (const [id, g] of this.seen) {
      if (!world.gates.some((x) => x.id === id)) this.closing.push({ id, x: g.x, y: g.y, at: clock });
    }
    this.seen.clear();
    for (const g of world.gates) this.seen.set(g.id, { x: g.x, y: g.y });

    let w = 0;
    for (const c of this.closing) {
      if (clock - c.at < CLOSE_TIME) {
        this.closing[w++] = c;
      } else if (inView(view, c.x, c.y, 60)) {
        const color = invaderColor(world);
        fx.flash(c.x, c.y, 26, mixHex(color, '#ffffff', 0.4), 0.3);
        fx.ring(c.x, c.y, 4, 48, color, 0.45, 1.6, true);
      }
    }
    this.closing.length = w;
  }

  /** 소용돌이 본체 (병력 아래) */
  draw(ctx: CanvasRenderingContext2D, world: World, zoom: number, view: ViewRect, clock: number, reduced: boolean): void {
    if (world.gates.length === 0 && this.closing.length === 0) return;
    const color = invaderColor(world);
    const px = 1 / zoom;
    const spin = reduced ? 0.3 : 1;
    const style: VortexStyle = { color, hot: mixHex(color, '#ffffff', 0.5), px, spin, clock };
    for (const g of world.gates) {
      if (!inView(view, g.x, g.y, 80)) continue;
      const k = openness(world, g.opensAt, g.spawnAt);
      const spawning = world.time >= g.spawnAt && g.remaining > 0;
      const pulse = spawning ? 0.5 + 0.5 * Math.sin(clock * 7) : 0;
      const R = gateRadius(k) * (1 + pulse * 0.06);
      drawVortex(ctx, style, g.x, g.y, R, k, clock * spin * 1.8 + g.id, pulse, 1);
      // 출현 중: 바깥으로 퍼지는 박동 고리 + 중심 섬광
      if (spawning) {
        ctx.globalCompositeOperation = 'lighter';
        ctx.strokeStyle = color;
        for (let i = 0; i < 2; i++) {
          const f = (clock * 1.4 + i * 0.5) % 1;
          ctx.globalAlpha = (1 - f) * 0.7;
          ctx.lineWidth = Math.max(2 * px, 1.2) * (1 - f * 0.5);
          ctx.beginPath();
          ctx.arc(g.x, g.y, R * (1 + f * 0.9), 0, Math.PI * 2);
          ctx.stroke();
        }
        ctx.globalAlpha = 0.5 + pulse * 0.5;
        drawSprite(ctx, glowSprite(color), g.x, g.y, R * 0.55);
        ctx.globalAlpha = 1;
        ctx.globalCompositeOperation = 'source-over';
      }
    }
    // 닫히는 게이트: 점점 빨리 오므라들며 더 빨리 돌고, 빛이 꺼지는 동안 가운데가 한 번 부풀었다 사라진다
    const R0 = gateRadius(1);
    for (const c of this.closing) {
      if (!inView(view, c.x, c.y, 80)) continue;
      const u = Math.min(1, (clock - c.at) / CLOSE_TIME);
      const R = R0 * (1 - u * u);
      if (R > 0.5) drawVortex(ctx, style, c.x, c.y, R, 1, clock * spin * 1.8 + c.id + u * u * spin * 4, 0, 1 - u);
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = Math.sin(u * Math.PI) * 0.8;
      drawSprite(ctx, glowSprite(color), c.x, c.y, R0 * (0.45 + u * 0.3));
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
    }
  }
}

interface VortexStyle {
  color: string;
  /** 밝은 심 색 */
  hot: string;
  /** 화면 1px 의 월드 길이 */
  px: number;
  /** 회전 속도 배율 (움직임 줄이기면 느리게) */
  spin: number;
  clock: number;
}

/**
 * 소용돌이 한 개: 바깥 빛 · 어두운 구멍 · 나선 팔 · 안쪽/가장자리 고리.
 * k = 열린 정도(0~1), rot = 나선 각도, pulse = 출현 박동(0~1), fade = 전체 불투명도
 */
function drawVortex(ctx: CanvasRenderingContext2D, st: VortexStyle, x: number, y: number, R: number, k: number, rot: number, pulse: number, fade: number): void {
  const { color, hot, px, spin, clock } = st;
  // 바깥 빛
  ctx.globalCompositeOperation = 'lighter';
  ctx.globalAlpha = (0.35 + 0.35 * k + pulse * 0.2) * fade;
  drawSprite(ctx, softSprite(color), x, y, R * 2.6);
  ctx.globalAlpha = fade;
  ctx.globalCompositeOperation = 'source-over';

  // 어두운 구멍
  const core = ctx.createRadialGradient(x, y, 0, x, y, R);
  core.addColorStop(0, 'rgba(3,0,8,0.95)');
  core.addColorStop(0.6, withAlpha(mixHex(color, '#05010a', 0.75), 0.85));
  core.addColorStop(1, withAlpha(color, 0));
  ctx.fillStyle = core;
  ctx.beginPath();
  ctx.arc(x, y, R, 0, Math.PI * 2);
  ctx.fill();

  // 소용돌이 팔: 바깥에서 안으로 감겨 들어가는 나선이 돈다
  ctx.globalCompositeOperation = 'lighter';
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  const arms = 3;
  for (let layer = 0; layer < 2; layer++) {
    ctx.lineWidth = layer === 0 ? Math.max(4.5 * px, 2.6) * (0.6 + k * 0.6) : Math.max(1.5 * px, 0.9) * (0.7 + k * 0.5);
    ctx.strokeStyle = layer === 0 ? color : hot;
    ctx.globalAlpha = (layer === 0 ? 0.3 + 0.2 * k : 0.6 + 0.35 * k) * fade;
    ctx.beginPath();
    for (let a = 0; a < arms; a++) {
      const base = rot + (a * Math.PI * 2) / arms;
      for (let i = 0; i <= 14; i++) {
        const f = i / 14;
        const rr = R * (0.12 + f * 0.9);
        const ang = base + f * 2.6;
        const ax = x + Math.cos(ang) * rr, ay = y + Math.sin(ang) * rr;
        if (i === 0) ctx.moveTo(ax, ay);
        else ctx.lineTo(ax, ay);
      }
    }
    ctx.stroke();
  }
  ctx.lineJoin = 'miter';
  // 안쪽 고리: 반대 방향으로 도는 짧은 호
  ctx.lineWidth = Math.max(1.2 * px, 0.8);
  ctx.strokeStyle = hot;
  ctx.globalAlpha = (0.4 + 0.4 * k) * fade;
  ctx.beginPath();
  for (let a = 0; a < 4; a++) {
    const a0 = -clock * spin * 3 + (a * Math.PI) / 2;
    ctx.moveTo(x + Math.cos(a0) * R * 0.38, y + Math.sin(a0) * R * 0.38);
    ctx.arc(x, y, R * 0.38, a0, a0 + 0.8);
  }
  ctx.stroke();
  // 가장자리 고리
  ctx.globalAlpha = (0.5 + 0.5 * k) * fade;
  ctx.lineWidth = Math.max(1.6 * px, 1);
  ctx.strokeStyle = color;
  ctx.beginPath();
  ctx.arc(x, y, R, 0, Math.PI * 2);
  ctx.stroke();
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
}

/** 남은 초 카운트다운과 웨이브 이름 (병력 위) */
export function drawGateLabels(ctx: CanvasRenderingContext2D, world: World, zoom: number, view: ViewRect): void {
  if (world.gates.length === 0) return;
  const color = invaderColor(world);
  const px = 1 / zoom;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (const g of world.gates) {
    if (!inView(view, g.x, g.y, 80)) continue;
    const k = openness(world, g.opensAt, g.spawnAt);
    const R = gateRadius(k);
    if (world.time < g.spawnAt) {
      const left = Math.ceil(g.spawnAt - world.time);
      const size = Math.max(14, Math.min(26, R * zoom * 0.9)) * px;
      ctx.font = `800 ${size}px system-ui, sans-serif`;
      ctx.lineWidth = 3 * px;
      ctx.strokeStyle = 'rgba(0,0,0,0.7)';
      ctx.strokeText(String(left), g.x, g.y);
      ctx.fillStyle = left <= 3 ? '#ffffff' : mixHex(color, '#ffffff', 0.55);
      ctx.fillText(String(left), g.x, g.y);
    }
    // 예고 중에는 몇 기가 올지(얼마나 막아야 할지), 출현이 시작되면 아직 안 나온 수를 보여 준다
    const label = world.time < g.spawnAt ? `웨이브 ${g.wave} · ${g.count}기` : `웨이브 ${g.wave} · ${g.remaining}`;
    const ls = 11 * px;
    ctx.font = `700 ${ls}px system-ui, sans-serif`;
    ctx.lineWidth = 3 * px;
    ctx.strokeStyle = 'rgba(0,0,0,0.7)';
    ctx.strokeText(label, g.x, g.y + R + 10 * px);
    ctx.fillStyle = mixHex(color, '#ffffff', 0.35);
    ctx.fillText(label, g.x, g.y + R + 10 * px);
  }
}
