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
      // 2-opt 예산은 명령 하나 몫을 무리 크기대로 나눈다: 행성이 많아도 귀환 한 번이 틱을 튀게 하지 않게
      for (const [p, g] of groups) joinPlanet(g, p, Math.floor((TWO_OPT_BUDGET * g.length) / units.length));
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
 * 명령 하나가 2-opt 로 따져 보는 쌍 수의 상한. 명령은 틱 안에서 적용되므로, 막판에 1000~2000기를 한꺼번에 움직여도
 * 그 틱이 튀지 않게 한다 (예전엔 2000기 명령 하나가 쌍을 최대 63만 번 따져 이 PC 에서도 명령 틱이 4~7ms, 폰에선 프레임 몇 장).
 * 300기 × 창 32 × 10번 = 96,000 보다 커서 300기 이하 무리의 짝은 예전과 똑같다. 큰 무리는 첫 훑기를 다 하고
 * 남은 몫으로 바뀐 곳만 더 다듬는다 (2000기: 명령 틱 2~3ms. 다 다듬지 못해 거의 나란한 경로끼리의 엇갈림은
 * 늘지만, 경로 길이 합은 0.3% 안쪽으로 같다)
 */
export const TWO_OPT_BUDGET = 100_000;

/**
 * 유닛 ↔ 슬롯 짝짓기. key(투영 축 또는 고리 각도) 순서로 처음 짝지은 다음(O(n log n)), refineSlots(2-opt)로 다듬는다.
 * 정렬 · 훑는 순서 · 예산 모두 입력 순서와 개수로 정해져 결정론적이다.
 * budget: 따져 볼 쌍 수의 상한 (refineSlots)
 */
function assign(
  units: Unit[],
  slots: Slot[],
  key: (x: number, y: number) => number,
  planetId: number,
  budget = TWO_OPT_BUDGET,
): void {
  const us = sortByKey(units, key);
  const ss = sortByKey(slots, key);
  const n = us.length;
  const ux = new Float64Array(n), uy = new Float64Array(n);
  const sx = new Float64Array(n), sy = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    ux[i] = us[i].x;
    uy[i] = us[i].y;
    sx[i] = ss[i].x;
    sy[i] = ss[i].y;
  }
  refineSlots(ux, uy, sx, sy, budget);
  for (let i = 0; i < n; i++) sendTo(us[i], sx[i], sy[i], planetId);
}

/**
 * i 번 유닛(ux, uy)이 i 번 슬롯(sx, sy)으로 가는 짝을 2-opt 로 다듬는다 (sx, sy 를 그 자리에서 맞바꾼다).
 * 두 유닛의 슬롯을 맞바꿔 두 경로 길이의 합이 줄면 바꾼다. 유클리드 거리의 합에서는 교차하는 두 경로를 맞바꾸면
 * 반드시 짧아지므로(삼각부등식), 창 안에서 더 바꿀 쌍이 없으면 그 안에 엇갈리는 경로도 없다: 무리가 엉키지 않고
 * 그대로 펴지며 대형이 된다 (예전 축 정렬만으로는 흩어진 300기의 경로가 1200~7400쌍 엇갈렸다).
 * 따져 본 쌍이 budget 에 닿으면 훑던 도중이라도 멈춘다. 반환값: 따져 본 쌍 수
 */
export function refineSlots(
  ux: Float64Array,
  uy: Float64Array,
  sx: Float64Array,
  sy: Float64Array,
  budget = TWO_OPT_BUDGET,
): number {
  const n = ux.length;
  const cost = new Float64Array(n);
  for (let i = 0; i < n; i++) cost[i] = dist(ux[i], uy[i], sx[i], sy[i]);
  // 아주 큰 무리(3000기 남짓 넘게)는 창을 좁혀 첫 훑기라도 끝까지 닿게 한다
  const span = Math.min(TWO_OPT_WINDOW, Math.max(4, Math.floor(budget / n)));
  /**
   * 마지막으로 슬롯이 바뀐 훑기 번호 (-1: 아직). 지난 훑기부터 두 쪽 다 그대로인 쌍은 지난번에 안 바꿨으니 이번에도
   * 안 바꾼다: 건너뛰어도 결과가 똑같고, 다 펴진 곳을 다시 따지느라 예산을 쓰지 않는다
   */
  const changed = new Int32Array(n).fill(-1);
  let evals = 0;
  refine: for (let pass = 0; pass < TWO_OPT_PASSES; pass++) {
    let swapped = false;
    const stale = pass - 1;
    for (let i = 0; i < n - 1; i++) {
      const end = Math.min(n, i + span + 1);
      let iStale = changed[i] < stale;
      for (let j = i + 1; j < end; j++) {
        if (iStale && changed[j] < stale) continue;
        if (evals >= budget) break refine;
        evals++;
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
          changed[i] = changed[j] = pass;
          iStale = false;
          swapped = true;
        }
      }
    }
    if (!swapped) break;
  }
  return evals;
}

/**
 * key 순으로 정렬한 사본. key(고리 각도면 atan2)는 항목마다 한 번만 계산한다 (비교 함수 안에서 n log n 번 부르지 않게).
 * 형식 배열 정렬이 일반 배열보다 빠르다 (2000개에서 0.5 → 0.35ms). 키가 같으면 입력 순서: 비교가 전순서라
 * 어느 엔진의 정렬 알고리즘으로도 같은 순서 (예전 안정 정렬과도 같다)
 */
function sortByKey<T extends Slot>(items: readonly T[], key: (x: number, y: number) => number): T[] {
  const n = items.length;
  const k = new Float64Array(n);
  const order = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    k[i] = key(items[i].x, items[i].y);
    order[i] = i;
  }
  order.sort((a, b) => k[a] - k[b] || a - b);
  const out: T[] = [];
  for (let i = 0; i < n; i++) out.push(items[order[i]]);
  return out;
}

/** Math.hypot 대신 sqrt: 더 빠르고, IEEE 754 가 정확한 반올림을 보장해 어느 엔진에서나 같은 값이 나온다 */
function dist(ax: number, ay: number, bx: number, by: number): number {
  const dx = ax - bx, dy = ay - by;
  return Math.sqrt(dx * dx + dy * dy);
}

function sendTo(u: Unit, x: number, y: number, planetId: number): void {
  u.state = 'move';
  u.tx = x;
  u.ty = y;
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
function assignOnRing(units: Unit[], p: Planet, slots: Slot[], a0: number, planetId: number, budget?: number): void {
  assign(units, slots, (x, y) => angleDiff(Math.atan2(y - p.y, x - p.x), a0), planetId, budget);
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

/** 아군 행성 궤도에 합류. budget: 2-opt 예산 (귀환처럼 한 명령을 여러 무리로 나눌 때 나눠 준다) */
function joinPlanet(units: Unit[], p: Planet, budget?: number): void {
  const a0 = entryAngle(units, p);
  const [lo, hi] = CONFIG.orbitBand;
  const alts = [lo + 1, (lo + hi) / 2, hi - 1];
  assignOnRing(units, p, ringSlots(p, units.length, a0, alts, 6, true, INSIDE_ALT), a0, p.id, budget);
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
