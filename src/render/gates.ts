import type { World } from '../sim/world';
import { inView, type ViewRect } from './effects';
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

/** 소용돌이 본체 (병력 아래) */
export function drawGates(ctx: CanvasRenderingContext2D, world: World, zoom: number, view: ViewRect, clock: number, reduced: boolean): void {
  if (world.gates.length === 0) return;
  const color = invaderColor(world);
  const hot = mixHex(color, '#ffffff', 0.5);
  const px = 1 / zoom;
  const spin = reduced ? 0.3 : 1;
  for (const g of world.gates) {
    if (!inView(view, g.x, g.y, 80)) continue;
    const k = openness(world, g.opensAt, g.spawnAt);
    const spawning = world.time >= g.spawnAt && g.remaining > 0;
    const pulse = spawning ? 0.5 + 0.5 * Math.sin(clock * 7) : 0;
    const R = gateRadius(k) * (1 + pulse * 0.06);

    // 바깥 빛
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = 0.35 + 0.35 * k + pulse * 0.2;
    const halo = R * 2.6;
    drawSprite(ctx, softSprite(color), g.x, g.y, halo);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';

    // 어두운 구멍
    const core = ctx.createRadialGradient(g.x, g.y, 0, g.x, g.y, R);
    core.addColorStop(0, 'rgba(3,0,8,0.95)');
    core.addColorStop(0.6, withAlpha(mixHex(color, '#05010a', 0.75), 0.85));
    core.addColorStop(1, withAlpha(color, 0));
    ctx.fillStyle = core;
    ctx.beginPath();
    ctx.arc(g.x, g.y, R, 0, Math.PI * 2);
    ctx.fill();

    // 소용돌이 팔: 바깥에서 안으로 감겨 들어가는 나선이 돈다
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    const arms = 3;
    const rot = clock * spin * 1.8 + g.id;
    for (let layer = 0; layer < 2; layer++) {
      ctx.lineWidth = layer === 0 ? Math.max(4.5 * px, 2.6) * (0.6 + k * 0.6) : Math.max(1.5 * px, 0.9) * (0.7 + k * 0.5);
      ctx.strokeStyle = layer === 0 ? color : hot;
      ctx.globalAlpha = layer === 0 ? 0.3 + 0.2 * k : 0.6 + 0.35 * k;
      ctx.beginPath();
      for (let a = 0; a < arms; a++) {
        const base = rot + (a * Math.PI * 2) / arms;
        for (let i = 0; i <= 14; i++) {
          const f = i / 14;
          const rr = R * (0.12 + f * 0.9);
          const ang = base + f * 2.6;
          const x = g.x + Math.cos(ang) * rr, y = g.y + Math.sin(ang) * rr;
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
      }
      ctx.stroke();
    }
    ctx.lineJoin = 'miter';
    // 안쪽 고리: 반대 방향으로 도는 짧은 호
    ctx.lineWidth = Math.max(1.2 * px, 0.8);
    ctx.strokeStyle = hot;
    ctx.globalAlpha = 0.4 + 0.4 * k;
    ctx.beginPath();
    for (let a = 0; a < 4; a++) {
      const st = -clock * spin * 3 + (a * Math.PI) / 2;
      ctx.moveTo(g.x + Math.cos(st) * R * 0.38, g.y + Math.sin(st) * R * 0.38);
      ctx.arc(g.x, g.y, R * 0.38, st, st + 0.8);
    }
    ctx.stroke();
    // 가장자리 고리
    ctx.globalAlpha = 0.5 + 0.5 * k;
    ctx.lineWidth = Math.max(1.6 * px, 1);
    ctx.strokeStyle = color;
    ctx.beginPath();
    ctx.arc(g.x, g.y, R, 0, Math.PI * 2);
    ctx.stroke();

    // 출현 중: 바깥으로 퍼지는 박동 고리
    if (spawning) {
      for (let i = 0; i < 2; i++) {
        const f = (clock * 1.4 + i * 0.5) % 1;
        ctx.globalAlpha = (1 - f) * 0.7;
        ctx.lineWidth = Math.max(2 * px, 1.2) * (1 - f * 0.5);
        ctx.beginPath();
        ctx.arc(g.x, g.y, R * (1 + f * 0.9), 0, Math.PI * 2);
        ctx.stroke();
      }
      // 중심 섬광
      ctx.globalAlpha = 0.5 + pulse * 0.5;
      const c = R * 0.55;
      drawSprite(ctx, glowSprite(color), g.x, g.y, c);
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }
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
    const label = world.time < g.spawnAt ? `웨이브 ${g.wave}` : `웨이브 ${g.wave} · ${g.remaining}`;
    const ls = 11 * px;
    ctx.font = `700 ${ls}px system-ui, sans-serif`;
    ctx.lineWidth = 3 * px;
    ctx.strokeStyle = 'rgba(0,0,0,0.7)';
    ctx.strokeText(label, g.x, g.y + R + 10 * px);
    ctx.fillStyle = mixHex(color, '#ffffff', 0.35);
    ctx.fillText(label, g.x, g.y + R + 10 * px);
  }
}
