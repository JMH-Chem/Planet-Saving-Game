import { CONFIG } from '../config';
import type { Command, Planet, Unit } from './types';
import type { World } from './world';

interface Slot {
  x: number;
  y: number;
}

/** 명령을 유닛별 목표 지점(슬롯)으로 풀어서 배정한다. */
export function applyCommand(world: World, cmd: Command): void {
  const units: Unit[] = [];
  for (const id of cmd.unitIds) {
    const u = world.getUnit(id);
    if (u && u.faction === cmd.faction) units.push(u);
  }
  if (units.length === 0) return;

  const o = cmd.order;
  switch (o.kind) {
    case 'move': {
      const t = clampToWorld(world, o.x, o.y);
      if (o.formation === 'cluster') {
        const { px, py } = travelAxes(units, t.x, t.y);
        assignByAxis(units, clusterSlots(units.length, t.x, t.y), px, py, -1);
      } else {
        const { dx, dy } = travelAxes(units, t.x, t.y);
        lineOrder(units, t.x - dy * 130, t.y + dx * 130, t.x + dy * 130, t.y - dx * 130, world);
      }
      return;
    }
    case 'line': {
      const a = clampToWorld(world, o.x1, o.y1);
      const b = clampToWorld(world, o.x2, o.y2);
      lineOrder(units, a.x, a.y, b.x, b.y, world);
      return;
    }
    case 'planet': {
      const p = world.planets[o.planetId];
      if (!p) return;
      if (p.owner === cmd.faction) joinPlanet(units, p);
      else if (o.formation === 'cluster') assaultPlanet(units, p);
      else surroundPlanet(units, p, world);
      return;
    }
    case 'return': {
      const friendly = world.planets.filter((p) => p.owner === cmd.faction);
      if (friendly.length === 0) return;
      const groups = new Map<Planet, Unit[]>();
      for (const u of units) {
        let best = friendly[0];
        let bestD = Infinity;
        for (const p of friendly) {
          const d = Math.hypot(p.x - u.x, p.y - u.y);
          if (d < bestD) {
            bestD = d;
            best = p;
          }
        }
        const g = groups.get(best) ?? [];
        g.push(u);
        groups.set(best, g);
      }
      for (const [p, g] of groups) joinPlanet(g, p);
      return;
    }
  }
}

// ───────────────────────────── 대형 계산 ─────────────────────────────

function clampToWorld(world: World, x: number, y: number): Slot {
  return { x: Math.min(world.width, Math.max(0, x)), y: Math.min(world.height, Math.max(0, y)) };
}

function centroid(units: readonly Unit[]): Slot {
  let x = 0, y = 0;
  for (const u of units) {
    x += u.x;
    y += u.y;
  }
  return { x: x / units.length, y: y / units.length };
}

/** 진행 방향 단위벡터(dx, dy)와 그에 수직인 축(px, py) */
function travelAxes(units: readonly Unit[], tx: number, ty: number) {
  const c = centroid(units);
  let dx = tx - c.x, dy = ty - c.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-3) {
    dx = 1;
    dy = 0;
  } else {
    dx /= len;
    dy /= len;
  }
  return { dx, dy, px: -dy, py: dx };
}

/** 해바라기(Vogel) 나선 배치: 원형으로 빽빽하게 뭉친다 */
export function clusterSlots(n: number, cx: number, cy: number): Slot[] {
  const golden = Math.PI * (3 - Math.sqrt(5));
  const c = CONFIG.formation.clusterSpacing / Math.sqrt(Math.PI);
  const slots: Slot[] = [];
  for (let i = 0; i < n; i++) {
    const r = c * Math.sqrt(i + 0.5);
    slots.push({ x: cx + Math.cos(i * golden) * r, y: cy + Math.sin(i * golden) * r });
  }
  return slots;
}

/**
 * 선분 A-B 를 따라 횡대 배치. 인원이 적으면 선 전체에 고르게 펼치고,
 * 한 줄에 다 못 서면 부대가 있던 쪽(뒤)으로 줄을 늘린다.
 */
function lineOrder(units: Unit[], x1: number, y1: number, x2: number, y2: number, world: World): void {
  const { lineSpacing, rowSpacing } = CONFIG.formation;
  const n = units.length;
  let ax = x2 - x1, ay = y2 - y1;
  const len = Math.hypot(ax, ay);
  if (len < lineSpacing) {
    const { px, py } = travelAxes(units, x1, y1);
    assignByAxis(units, clusterSlots(n, x1, y1), px, py, -1);
    return;
  }
  ax /= len;
  ay /= len;
  // 뒤쪽 = 선의 법선 중 부대 무게중심이 있는 방향
  const c = centroid(units);
  const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
  let bx = -ay, by = ax;
  if ((c.x - mx) * bx + (c.y - my) * by < 0) {
    bx = -bx;
    by = -by;
  }
  const perRow = Math.max(1, Math.floor(len / lineSpacing) + 1);
  const slots: Slot[] = [];
  for (let row = 0; slots.length < n; row++) {
    const inRow = Math.min(perRow, n - slots.length);
    const gap = n <= perRow && inRow > 1 ? len / (inRow - 1) : lineSpacing;
    const width = gap * (inRow - 1);
    for (let i = 0; i < inRow; i++) {
      const along = inRow === 1 ? 0 : -width / 2 + gap * i;
      const p = clampToWorld(world, mx + ax * along + bx * row * rowSpacing, my + ay * along + by * row * rowSpacing);
      slots.push(p);
    }
  }
  assignByAxis(units, slots, ax, ay, -1);
}

/** 유닛과 슬롯을 같은 축에 투영해 정렬한 뒤 짝지어, 이동 경로가 덜 엇갈리게 한다 */
function assignByAxis(units: Unit[], slots: Slot[], ax: number, ay: number, planetId: number): void {
  const us = [...units].sort((a, b) => a.x * ax + a.y * ay - (b.x * ax + b.y * ay));
  const ss = [...slots].sort((a, b) => a.x * ax + a.y * ay - (b.x * ax + b.y * ay));
  us.forEach((u, i) => sendTo(u, ss[i], planetId));
}

function sendTo(u: Unit, s: Slot, planetId: number): void {
  u.state = 'move';
  u.tx = s.x;
  u.ty = s.y;
  u.planet = planetId;
}

/** a - b 를 [-π, π) 로 정규화 */
export const angleDiff = (a: number, b: number) => ((((a - b) % (Math.PI * 2)) + Math.PI * 3) % (Math.PI * 2)) - Math.PI;

/**
 * 행성 둘레 고리 위의 슬롯. 진입 방향(a0)을 중심으로 좌우 번갈아 채운다.
 * interleave = true 면 여러 고도에 번갈아 채워 좁고 두껍게(돌파),
 * false 면 안쪽 고리를 다 채운 뒤 바깥 고리로(포위).
 */
function ringSlots(p: Planet, n: number, a0: number, alts: number[], spacing: number, interleave: boolean): Slot[] {
  const slots: { x: number; y: number; a: number }[] = [];
  const caps = alts.map((alt) => Math.max(1, Math.floor((2 * Math.PI * (p.radius + alt)) / spacing)));
  const used = alts.map(() => 0);
  const place = (band: number) => {
    const j = used[band]++;
    const k = j === 0 ? 0 : j % 2 ? (j + 1) / 2 : -j / 2;
    const r = p.radius + alts[band];
    const a = a0 + (k * spacing) / r;
    slots.push({ x: p.x + Math.cos(a) * r, y: p.y + Math.sin(a) * r, a });
  };
  while (slots.length < n) {
    let placed = false;
    for (let b = 0; b < alts.length && slots.length < n; b++) {
      if (used[b] >= caps[b]) continue;
      if (!interleave) {
        while (used[b] < caps[b] && slots.length < n) place(b);
      } else {
        place(b);
      }
      placed = true;
    }
    if (!placed) {
      // 모든 고리가 찼으면 바깥으로 고리를 하나 더 만든다.
      alts.push(alts[alts.length - 1] + CONFIG.formation.rowSpacing);
      caps.push(Math.floor((2 * Math.PI * (p.radius + alts[alts.length - 1])) / spacing));
      used.push(0);
    }
  }
  return slots;
}

function assignOnRing(units: Unit[], p: Planet, slots: Slot[], a0: number, planetId: number): void {
  const key = (x: number, y: number) => angleDiff(Math.atan2(y - p.y, x - p.x), a0);
  const us = [...units].sort((a, b) => key(a.x, a.y) - key(b.x, b.y));
  const ss = [...slots].sort((a, b) => key(a.x, a.y) - key(b.x, b.y));
  us.forEach((u, i) => sendTo(u, ss[i], planetId));
}

function entryAngle(units: Unit[], p: Planet): number {
  const c = centroid(units);
  return Math.atan2(c.y - p.y, c.x - p.x);
}

/** 아군 행성 궤도에 합류 */
function joinPlanet(units: Unit[], p: Planet): void {
  const a0 = entryAngle(units, p);
  const [lo, hi] = CONFIG.orbitBand;
  const alts = [lo + 1, (lo + hi) / 2, hi - 1];
  assignOnRing(units, p, ringSlots(p, units.length, a0, alts, 6, true), a0, p.id);
}

/** 돌파: 진입 방향으로 뭉쳐서 대기권 안으로 강하, 도착 후 궤도를 돌며 행성을 공격 */
function assaultPlanet(units: Unit[], p: Planet): void {
  const a0 = entryAngle(units, p);
  const [lo, hi] = CONFIG.orbitBand;
  const alts = [lo + 2, (lo + hi) / 2, hi - 2];
  assignOnRing(units, p, ringSlots(p, units.length, a0, alts, CONFIG.formation.clusterSpacing, true), a0, p.id);
}

/** 포위: 대기권 바로 바깥에 넓게 펼쳐 궤도 수비대를 사거리에 넣는다 */
function surroundPlanet(units: Unit[], p: Planet, world: World): void {
  const a0 = entryAngle(units, p);
  const alts = [CONFIG.surroundAltitude];
  const slots = ringSlots(p, units.length, a0, alts, CONFIG.formation.lineSpacing, false).map((s) =>
    clampToWorld(world, s.x, s.y),
  );
  assignOnRing(units, p, slots, a0, -1);
}
