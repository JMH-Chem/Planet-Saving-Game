import { CONFIG } from '../config';
import type { Command, Planet, Unit } from './types';
import type { World } from './world';

interface Slot {
  x: number;
  y: number;
}

/**
 * 명령을 유닛별 목표 지점(슬롯)으로 풀어서 배정한다.
 * 반환값: 함께 움직일 무리들 (보통 하나, 귀환은 돌아갈 행성마다 하나). World 가 무리마다 보폭을 맞춘다
 */
export function applyCommand(world: World, cmd: Command): Unit[][] {
  const units: Unit[] = [];
  for (const id of cmd.unitIds) {
    const u = world.getUnit(id);
    if (u && u.faction === cmd.faction) units.push(u);
  }
  if (units.length === 0) return [];

  const o = cmd.order;
  switch (o.kind) {
    case 'move': {
      const t = clampToWorld(world, o.x, o.y);
      if (o.formation === 'cluster') {
        const { px, py } = travelAxes(units, t.x, t.y);
        assignByAxis(units, clusterInWorld(world, units.length, t.x, t.y), px, py, -1);
      } else {
        const { dx, dy } = travelAxes(units, t.x, t.y);
        const half = CONFIG.formation.spreadHalfWidth;
        lineOrder(units, t.x - dy * half, t.y + dx * half, t.x + dy * half, t.y - dx * half, world);
      }
      return [units];
    }
    case 'line': {
      const a = clampToWorld(world, o.x1, o.y1);
      const b = clampToWorld(world, o.x2, o.y2);
      lineOrder(units, a.x, a.y, b.x, b.y, world);
      return [units];
    }
    case 'planet': {
      const p = world.planets[o.planetId];
      if (!p) return [];
      if (p.owner === cmd.faction) joinPlanet(units, p);
      else if (o.formation === 'cluster') assaultPlanet(units, p);
      else surroundPlanet(units, p, world);
      return [units];
    }
    case 'return': {
      const friendly = world.planets.filter((p) => p.owner === cmd.faction);
      if (friendly.length === 0) return [];
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
      return [...groups.values()];
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

/** 대형 전체를 안쪽으로 옮겨 가장자리에서도 병력 간격을 보존한다. */
function clusterInWorld(world: World, n: number, cx: number, cy: number): Slot[] {
  const slots = clusterSlots(n, cx, cy);
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const s of slots) {
    minX = Math.min(minX, s.x); minY = Math.min(minY, s.y);
    maxX = Math.max(maxX, s.x); maxY = Math.max(maxY, s.y);
  }
  const dx = minX < 0 ? -minX : maxX > world.width ? world.width - maxX : 0;
  const dy = minY < 0 ? -minY : maxY > world.height ? world.height - maxY : 0;
  // 맵 자체보다 큰 대형에도 좌표 범위는 보장한다.
  return slots.map((s) => clampToWorld(world, s.x + dx, s.y + dy));
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
    assignByAxis(units, clusterInWorld(world, n, x1, y1), px, py, -1);
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

/** 유닛과 슬롯을 같은 축에 투영한 순서로 처음 짝지은 뒤 다듬는다 (assign) */
function assignByAxis(units: Unit[], slots: Slot[], ax: number, ay: number, planetId: number): void {
  assign(units, slots, (x, y) => x * ax + y * ay, planetId);
}

/**
 * 처음 정렬 순서에서 앞뒤 이만큼의 이웃끼리만 맞바꿔 본다: 명령 한 번의 계산량을 n × 창 크기로 묶는다.
 * 모든 쌍을 보는 것과 엇갈림 수가 거의 같고(흩어진 150기 0쌍, 300기 0~4쌍), 300기 명령이 1ms 안팎 (모든 쌍은 3ms)
 */
const TWO_OPT_WINDOW = 32;
/** 맞바꿀 쌍이 남아 있어도 이만큼 훑으면 멈춘다 */
const TWO_OPT_PASSES = 10;

/**
 * 유닛 ↔ 슬롯 짝짓기. key(투영 축 또는 고리 각도) 순서로 처음 짝지은 다음(O(n log n)),
 * 두 유닛의 슬롯을 맞바꿔 두 경로 길이의 합이 줄면 바꾸는 2-opt 로 다듬는다.
 * 유클리드 거리의 합에서는 교차하는 두 경로를 맞바꾸면 반드시 짧아지므로(삼각부등식), 창 안에서 더 바꿀 쌍이
 * 없으면 그 안에 엇갈리는 경로도 없다: 무리가 엉키지 않고 그대로 펴지며 대형이 된다 (예전 축 정렬만으로는 흩어진
 * 300기의 경로가 1200~7400쌍 엇갈렸다). 정렬 · 훑는 순서 모두 입력 순서로 정해져 결정론적이다.
 */
function assign(units: Unit[], slots: Slot[], key: (x: number, y: number) => number, planetId: number): void {
  const us = sortByKey(units, key);
  const ss = sortByKey(slots, key);
  const n = us.length;
  const ux = new Float64Array(n), uy = new Float64Array(n);
  const sx = new Float64Array(n), sy = new Float64Array(n);
  const cost = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    ux[i] = us[i].x;
    uy[i] = us[i].y;
    sx[i] = ss[i].x;
    sy[i] = ss[i].y;
    cost[i] = dist(ux[i], uy[i], sx[i], sy[i]);
  }
  for (let pass = 0; pass < TWO_OPT_PASSES; pass++) {
    let swapped = false;
    for (let i = 0; i < n - 1; i++) {
      const end = Math.min(n, i + TWO_OPT_WINDOW + 1);
      for (let j = i + 1; j < end; j++) {
        const a = dist(ux[i], uy[i], sx[j], sy[j]);
        const b = dist(ux[j], uy[j], sx[i], sy[i]);
        // 아주 작은 이득은 무시: 부동소수 오차로 같은 쌍을 계속 맞바꾸지 않게
        if (a + b < cost[i] + cost[j] - 1e-6) {
          const tx = sx[i], ty = sy[i];
          sx[i] = sx[j];
          sy[i] = sy[j];
          sx[j] = tx;
          sy[j] = ty;
          cost[i] = a;
          cost[j] = b;
          swapped = true;
        }
      }
    }
    if (!swapped) break;
  }
  for (let i = 0; i < n; i++) sendTo(us[i], { x: sx[i], y: sy[i] }, planetId);
}

/** key 순으로 정렬한 사본. key(고리 각도면 atan2)는 항목마다 한 번만 계산한다 (비교 함수 안에서 n log n 번 부르지 않게) */
function sortByKey<T extends Slot>(items: readonly T[], key: (x: number, y: number) => number): T[] {
  const k = items.map((s) => key(s.x, s.y));
  return items
    .map((_, i) => i)
    .sort((a, b) => k[a] - k[b])
    .map((i) => items[i]);
}

/** Math.hypot 대신 sqrt: 더 빠르고, IEEE 754 가 정확한 반올림을 보장해 어느 엔진에서나 같은 값이 나온다 */
function dist(ax: number, ay: number, bx: number, by: number): number {
  const dx = ax - bx, dy = ay - by;
  return Math.sqrt(dx * dx + dy * dy);
}

function sendTo(u: Unit, s: Slot, planetId: number): void {
  u.state = 'move';
  u.tx = s.x;
  u.ty = s.y;
  u.planet = planetId;
}

/** a - b 를 [-π, π) 로 정규화 */
export const angleDiff = (a: number, b: number) => ((((a - b) % (Math.PI * 2)) + Math.PI * 3) % (Math.PI * 2)) - Math.PI;

/** 대기권 안에 다 들어가지 않는 큰 무리를 위해 고리 간격을 좁힐 때의 하한 */
const MIN_RING_SPACING = 2.5;

/**
 * 행성 둘레 고리 위의 슬롯. 진입 방향(a0)을 중심으로 좌우 번갈아 채운다.
 * interleave = true 면 여러 고도에 번갈아 채워 좁고 두껍게(돌파),
 * false 면 안쪽 고리를 다 채운 뒤 바깥 고리로(포위).
 *
 * maxAlt 를 주면 슬롯이 그 고도(표면 기준)를 넘지 않는다: 돌파·합류는 대기권 안에 있어야 의미가 있다.
 * 지금 고리들로 다 들어가는 수는 배치가 그대로이고, 넘칠 때만 간격을 좁히며(하한 MIN_RING_SPACING),
 * 그래도 넘치면 바깥 대신 안쪽 고리들을 조금씩 엇갈려 한 번 더 채운다.
 */
function ringSlots(
  p: Planet,
  n: number,
  a0: number,
  alts: number[],
  spacing: number,
  interleave: boolean,
  maxAlt = Infinity,
): Slot[] {
  const { rowSpacing } = CONFIG.formation;
  const capOf = (alt: number) => Math.max(1, Math.floor((2 * Math.PI * (p.radius + alt)) / spacing));
  if (Number.isFinite(maxAlt)) {
    // 주어진 고리 + 바깥으로 rowSpacing 씩 늘린 고리 중 한계 안에 드는 것들의 정원
    let fit = 0;
    for (const alt of alts) fit += capOf(alt);
    for (let alt = alts[alts.length - 1] + rowSpacing; alt <= maxAlt; alt += rowSpacing) fit += capOf(alt);
    if (n > fit) spacing = Math.max(MIN_RING_SPACING, (spacing * fit) / n);
  }
  const slots: { x: number; y: number; a: number }[] = [];
  const caps = alts.map(capOf);
  const used = alts.map(() => 0);
  /** 안쪽 고리를 다시 채운 횟수 (간격 하한에 걸릴 만큼 큰 무리일 때만 0 보다 커진다) */
  let pass = 0;
  const place = (band: number) => {
    const j = used[band]++;
    const k = j === 0 ? 0 : j % 2 ? (j + 1) / 2 : -j / 2;
    // 다시 채우는 고리는 반 칸 남짓 엇갈리고 조금 안쪽으로: 같은 자리에 겹쳐 서지 않게
    const r = p.radius + alts[band] - (pass % 2) * (rowSpacing / 4);
    const a = a0 + (k * spacing + ((pass * 0.618) % 1) * spacing) / r;
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
    if (placed) continue;
    const next = alts[alts.length - 1] + rowSpacing;
    if (next <= maxAlt) {
      // 모든 고리가 찼으면 바깥으로 고리를 하나 더 만든다.
      alts.push(next);
      caps.push(capOf(next));
      used.push(0);
    } else {
      // 한계 고도까지 꽉 찼다: 바깥으로 내보내지 않고 안쪽 고리들을 한 번 더 채운다
      pass++;
      used.fill(0);
    }
  }
  return slots;
}

/** 행성 둘레 슬롯: 진입 방향(a0) 기준 각도 순서로 처음 짝지은 뒤 다듬는다 (assign) */
function assignOnRing(units: Unit[], p: Planet, slots: Slot[], a0: number, planetId: number): void {
  assign(units, slots, (x, y) => angleDiff(Math.atan2(y - p.y, x - p.x), a0), planetId);
}

function entryAngle(units: Unit[], p: Planet): number {
  const c = centroid(units);
  return Math.atan2(c.y - p.y, c.x - p.x);
}

/**
 * 합류·돌파 슬롯의 최고 고도(표면 기준). 대기권(CONFIG.atmosphere) 경계에서 1 안쪽:
 * 바깥 고리로 밀려난 병력은 강하로 치지 않아 행성을 못 치고, 아군 행성에선 수비대(presence)로 세지 않는다
 */
const INSIDE_ALT = CONFIG.atmosphere - 1;

/** 아군 행성 궤도에 합류 */
function joinPlanet(units: Unit[], p: Planet): void {
  const a0 = entryAngle(units, p);
  const [lo, hi] = CONFIG.orbitBand;
  const alts = [lo + 1, (lo + hi) / 2, hi - 1];
  assignOnRing(units, p, ringSlots(p, units.length, a0, alts, 6, true, INSIDE_ALT), a0, p.id);
}

/** 돌파: 진입 방향으로 뭉쳐서 대기권 안으로 강하, 도착 후 궤도를 돌며 행성을 공격 */
function assaultPlanet(units: Unit[], p: Planet): void {
  const a0 = entryAngle(units, p);
  const [lo, hi] = CONFIG.orbitBand;
  const alts = [lo + 2, (lo + hi) / 2, hi - 2];
  const slots = ringSlots(p, units.length, a0, alts, CONFIG.formation.clusterSpacing, true, INSIDE_ALT);
  assignOnRing(units, p, slots, a0, p.id);
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
