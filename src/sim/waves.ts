import { DEFENSE, type Difficulty } from '../config';
import { PLAYER, type FactionId, type Order, type Planet, type Unit, type WarpGate } from './types';
import type { World } from './world';

/** 방어전에서 침공군이 쓰는 진영 번호 (0 중립, 1 플레이어) */
export const INVADER: FactionId = 2;

export interface WaveSpec {
  wave: number;
  /** 예고(게이트 열림) 시각(초) */
  warnAt: number;
  /** 출현 시작 시각(초) */
  spawnAt: number;
  /** 웨이브 총 병력 */
  size: number;
  gates: number;
}

/** 웨이브 n(1부터)의 총 병력 */
export function waveSize(n: number, difficulty: Difficulty): number {
  const { base, linear, quad } = DEFENSE.waveSize;
  const k = n - 1;
  return Math.round((base + linear * k + quad * k * k) * DEFENSE.difficultyMult[difficulty]);
}

export function gatesForWave(n: number): number {
  let gates = 1;
  for (const [from, count] of DEFENSE.gatesByWave) if (n >= from) gates = count;
  return gates;
}

/** 웨이브 일정표. 간격은 웨이브가 오를수록 조금씩 짧아진다 */
export function waveSchedule(difficulty: Difficulty): WaveSpec[] {
  const list: WaveSpec[] = [];
  let spawnAt = DEFENSE.firstWarningAt + DEFENSE.warningLead;
  for (let n = 1; n <= DEFENSE.totalWaves; n++) {
    if (n > 1) spawnAt += Math.max(DEFENSE.minInterval, DEFENSE.interval - DEFENSE.intervalShrink * (n - 2));
    list.push({ wave: n, warnAt: spawnAt - DEFENSE.warningLead, spawnAt, size: waveSize(n, difficulty), gates: gatesForWave(n) });
  }
  return list;
}

interface Group {
  units: Set<number>;
  wave: number;
  /**
   * gather = 게이트 앞에 모이는 중, stage = 포위로 수비대를 깎는 중, assault = 돌파 중,
   * chase = 돌파가 막혀 가장 가까운 플레이어 병력에게 달려드는 중
   */
  phase: 'gather' | 'stage' | 'assault' | 'chase';
  /** 목표 행성 (-1 = 아직 없음) */
  target: number;
  /** 모이는 중인 게이트 (-1 = 게이트 출신이 아님: 빼앗은 행성에서 출격한 무리) */
  gateId: number;
  phaseAt: number;
}

/**
 * 방어전 진행자: 웨이브 일정에 따라 가장자리에 워프 게이트를 열고, 침공군 병력을 내보내 지휘하고, 승패를 판정한다.
 * 침공군은 AIController 와 마찬가지로 Command 로만 움직인다. 난수는 world.rng 만 써서 결정론을 지킨다.
 *
 * 전술 단계 (웨이브 번호 기준):
 *  - 1~4  : 게이트에서 가장 가까운 아군 행성으로 곧장 돌파
 *  - 5~   : 일부 무리는 포위로 수비대를 깎다가, 수비대가 얇아지면(또는 시간 초과) 돌파
 *  - 8~   : 무리를 둘로 나눠 서로 다른 행성을 협공
 *  - 웨이브가 오를수록 모성을 노리는 경향이 커진다
 */
export class WaveDirector {
  readonly totalWaves = DEFENSE.totalWaves;
  readonly schedule: WaveSpec[];
  /** 출현이 시작된 마지막 웨이브 번호 (첫 웨이브 전에는 0) */
  wave = 0;
  /** 출현 중인 게이트가 있거나 침공군이 남아 있다 */
  inProgress = false;
  /** 지키는 모성 (방어전 패배 조건) */
  readonly homeId: number;

  private announced = 0;
  private nextGateId = 1;
  private groups: Group[] = [];
  private nextThink = 0;
  private nextRaid: number = DEFENSE.raidInterval;

  constructor(
    world: World,
    difficulty: Difficulty,
    readonly faction: FactionId = INVADER,
  ) {
    this.schedule = waveSchedule(difficulty);
    const inv = world.factions[faction];
    inv.name = DEFENSE.invader.name;
    inv.color = DEFENSE.invader.color;
    inv.isAI = true;
    inv.invader = true;
    const home = world.planets.find((p) => p.owner === PLAYER && p.isHome) ?? world.planets.find((p) => p.owner === PLAYER);
    this.homeId = home ? home.id : -1;
    world.winRule = (w) => this.judge(w);
  }

  /** 다음 웨이브 출현 시각 (마지막 웨이브가 나온 뒤에는 null) */
  get nextSpawnAt(): number | null {
    return this.wave < this.schedule.length ? this.schedule[this.wave].spawnAt : null;
  }

  /** 다음 웨이브가 예고되어 게이트가 열려 있다 */
  get warned(): boolean {
    return this.announced > this.wave;
  }

  /** 모든 웨이브가 다 나왔다 (게이트가 전부 닫힘) */
  isFinished(world: World): boolean {
    return this.wave === this.totalWaves && world.gates.length === 0;
  }

  /** 버틴 웨이브 수 (결과 화면용) */
  survived(world: World): number {
    if (world.winner === PLAYER) return this.totalWaves;
    return Math.max(0, this.wave - (this.inProgress ? 1 : 0));
  }

  /** 매 틱 world.step 뒤에 호출 */
  update(world: World): void {
    if (world.winner !== null) return;
    const t = world.time;

    while (this.announced < this.schedule.length && t >= this.schedule[this.announced].warnAt) {
      this.openGates(world, this.schedule[this.announced]);
      this.announced++;
    }
    while (this.wave < this.schedule.length && t >= this.schedule[this.wave].spawnAt) {
      this.wave++;
      world.events.push({ type: 'wave', wave: this.wave, total: this.totalWaves, phase: 'start' });
    }
    if (world.gates.length > 0) this.emit(world, t);

    if (t >= this.nextThink) {
      this.nextThink = t + DEFENSE.thinkInterval;
      this.think(world);
    }
    this.inProgress = world.gates.some((g) => t >= g.spawnAt) || world.unitCount[this.faction] > 0;
  }

  /**
   * world.winRule: 모성이 넘어가면 패배 (행성·병력이 모두 없는 경우도 여기에 포함된다),
   * 모든 웨이브가 다 나온 뒤 침공군의 병력과 행성이 하나도 남지 않으면 승리
   */
  private judge(world: World): FactionId | null {
    const home = world.planets[this.homeId];
    if (!home || home.owner !== PLAYER) return this.faction;
    if (this.isFinished(world) && world.unitCount[this.faction] === 0 && world.planetCount[this.faction] === 0) return PLAYER;
    return null;
  }

  // ───────────────────────────── 게이트 ─────────────────────────────

  private openGates(world: World, spec: WaveSpec): void {
    const spots = this.gateSpots(world, spec.gates);
    spots.forEach((s, i) => {
      // 총 병력을 게이트 수로 나누고, 나머지는 앞 게이트부터 하나씩 더 준다
      const count = Math.floor(spec.size / spots.length) + (i < spec.size % spots.length ? 1 : 0);
      if (count <= 0) return;
      const gate: WarpGate = {
        id: this.nextGateId++,
        x: s.x,
        y: s.y,
        wave: spec.wave,
        opensAt: spec.warnAt,
        spawnAt: spec.spawnAt,
        count,
        remaining: count,
      };
      world.gates.push(gate);
    });
    world.events.push({ type: 'wave', wave: spec.wave, total: this.totalWaves, phase: 'warning' });
  }

  /**
   * 맵 경계 안쪽 띠에서 행성과 충분히 떨어진 후보를 뽑고, 첫 게이트는 무작위,
   * 나머지는 이미 고른 게이트에서 가장 먼 후보를 골라 서로 흩어지게 한다.
   */
  private gateSpots(world: World, n: number): { x: number; y: number }[] {
    const { width: W, height: H } = world;
    const [inMin, inMax] = DEFENSE.gateInset;
    const perimeter = 2 * (W + H);
    let clearance: number = DEFENSE.gateClearance;
    let candidates: { x: number; y: number }[] = [];
    // 행성이 가장자리를 많이 막는 맵이면 거리 조건을 조금씩 풀어서라도 자리를 찾는다
    for (let round = 0; candidates.length < n && round < 8; round++, clearance *= 0.85) {
      candidates = [];
      for (let i = 0; i < 80; i++) {
        const s = world.rng.range(0, perimeter);
        const inset = world.rng.range(inMin, inMax);
        let x: number, y: number;
        if (s < W) [x, y] = [s, inset];
        else if (s < W + H) [x, y] = [W - inset, s - W];
        else if (s < 2 * W + H) [x, y] = [2 * W + H - s, H - inset];
        else [x, y] = [inset, perimeter - s];
        x = Math.min(W - inMin, Math.max(inMin, x));
        y = Math.min(H - inMin, Math.max(inMin, y));
        if (world.planets.every((p) => Math.hypot(p.x - x, p.y - y) >= clearance)) candidates.push({ x, y });
      }
    }
    if (candidates.length === 0) return [{ x: inMin, y: inMin }];

    const chosen = [candidates[Math.floor(world.rng.next() * candidates.length)]];
    while (chosen.length < n) {
      let best = candidates[0];
      let bestD = -1;
      for (const c of candidates) {
        let d = Infinity;
        for (const g of chosen) d = Math.min(d, Math.hypot(g.x - c.x, g.y - c.y));
        if (d > bestD) {
          bestD = d;
          best = c;
        }
      }
      chosen.push(best);
    }
    return chosen;
  }

  /**
   * 열린 게이트에서 병력을 내보낸다 (초당 warpRate 기, 큰 게이트는 warpDuration 초 안에 다 나오도록 더 빠르게).
   * 다 나오면 게이트를 닫고 모인 무리를 출격시킨다.
   */
  private emit(world: World, t: number): void {
    const golden = Math.PI * (3 - Math.sqrt(5));
    for (const g of world.gates) {
      if (t < g.spawnAt) continue;
      let group = this.groups.find((gr) => gr.gateId === g.id);
      const rate = Math.max(DEFENSE.warpRate, g.count / DEFENSE.warpDuration);
      const due = Math.min(g.count, Math.floor((t - g.spawnAt) * rate) + 1);
      let throttled = false;
      while (g.count - g.remaining < due) {
        // 전장 전체 병력이 상한에 닿으면 게이트가 잠시 숨을 고른다 (성능 보호. 병력이 줄면 이어서 나온다)
        if (world.units.length >= DEFENSE.unitCap) {
          throttled = true;
          break;
        }
        if (!group) {
          group = { units: new Set(), wave: g.wave, phase: 'gather', target: -1, gateId: g.id, phaseAt: t };
          this.groups.push(group);
        }
        // 해바라기 나선으로 게이트 둘레에 차곡차곡: 같은 자리에 겹쳐 나오지 않게
        const i = g.count - g.remaining;
        const r = 3.2 * Math.sqrt(i + 0.5);
        const x = Math.min(world.width - 4, Math.max(4, g.x + Math.cos(i * golden) * r));
        const y = Math.min(world.height - 4, Math.max(4, g.y + Math.sin(i * golden) * r));
        const u = world.spawnAt(this.faction, x, y);
        g.remaining--;
        group.units.add(u.id);
        world.events.push({ type: 'warp', x, y, faction: this.faction, gateId: g.id });
      }
      // 상한에 막혔으면 모인 만큼 먼저 내보낸다: 게이트 앞에서 하염없이 기다리지 않게 (남은 병력은 새 무리로)
      if (group && (g.remaining === 0 || (throttled && group.units.size > 0))) this.launch(world, group);
    }
    world.gates = world.gates.filter((g) => g.remaining > 0);
  }

  // ───────────────────────────── 지휘 ─────────────────────────────

  private order(world: World, units: Iterable<number>, order: Order): void {
    const unitIds = [...units];
    if (unitIds.length > 0) world.enqueue({ faction: this.faction, unitIds, order });
  }

  private alive(world: World, group: Group): Unit[] {
    const list: Unit[] = [];
    for (const id of group.units) {
      const u = world.getUnit(id);
      if (u) list.push(u);
      else group.units.delete(id);
    }
    return list;
  }

  /**
   * 무리 중심에서 가까운 아군(플레이어) 행성 순. 웨이브가 오를수록 모성까지의 거리를 줄여 보아
   * 후반에는 멀리 돌아서라도 모성을 노린다.
   */
  private rankTargets(world: World, from: { x: number; y: number }, wave: number): Planet[] {
    const bias = Math.min(DEFENSE.homeBiasMax, DEFENSE.homeBiasPerWave * (wave - 1));
    const cost = (p: Planet) => Math.hypot(p.x - from.x, p.y - from.y) * (p.isHome ? 1 - bias : 1);
    return world.planets.filter((p) => p.owner === PLAYER).sort((a, b) => cost(a) - cost(b));
  }

  /** 게이트에서 다 모인 무리를 출격시킨다 */
  private launch(world: World, group: Group): void {
    group.gateId = -1;
    // 목표를 못 정해도 gather 에서는 빼 둔다: think 가 다음 판단 때 다시 목표를 찾는다
    group.phase = 'assault';
    const units = this.alive(world, group);
    if (units.length === 0) return;
    const targets = this.rankTargets(world, centroid(units), group.wave);
    if (targets.length === 0) return;

    // 협공: 무리를 반으로 갈라 두 번째로 가까운 행성도 동시에 친다
    if (group.wave >= DEFENSE.pincerFrom && targets.length >= 2 && units.length >= DEFENSE.pincerMin) {
      const half: Group = { ...group, units: new Set() };
      units.forEach((u, i) => {
        if (i % 2 === 1) {
          group.units.delete(u.id);
          half.units.add(u.id);
        }
      });
      this.groups.push(half);
      this.engage(world, half, targets[1]);
    }
    this.engage(world, group, targets[0]);
  }

  /**
   * 목표 행성으로 출격. 포위를 배운 웨이브부터는 수비대가 두꺼우면 대기권 밖에 둘러서서 먼저 깎는다
   * (강하 중에는 병력을 쏘지 못하므로 두꺼운 수비대에 곧장 뛰어들면 일방적으로 맞기만 한다)
   */
  private engage(world: World, group: Group, target: Planet): void {
    const size = group.units.size;
    const defenders = this.defendersNear(world, target);
    const siege = group.wave >= DEFENSE.siegeFrom && defenders >= DEFENSE.siegeMinDefenders && defenders > size * 0.3;
    group.target = target.id;
    group.phase = siege ? 'stage' : 'assault';
    group.phaseAt = world.time;
    this.order(world, group.units, { kind: 'planet', planetId: target.id, formation: siege ? 'spread' : 'cluster' });
  }

  /** 목표 행성 주변(대기권 + 10)의 플레이어 병력 */
  private defendersNear(world: World, p: Planet): number {
    let n = 0;
    world.grid.forEachInRadius(p.x, p.y, p.atmosphereRadius + 10, (u) => {
      if (u.alive && u.faction === PLAYER) n++;
    });
    return n;
  }

  private think(world: World): void {
    this.groups = this.groups.filter((g) => this.alive(world, g).length > 0);

    for (const group of this.groups) {
      if (group.phase === 'gather') continue;
      const units = this.alive(world, group);
      const target = group.target >= 0 ? world.planets[group.target] : null;

      if (!target || target.owner !== PLAYER) {
        // 목표를 빼앗았으면 정원 일부를 수비대로 남기고, 나머지는 다음 아군 행성으로
        if (target?.owner === this.faction) {
          let keep = Math.ceil(target.capacity * DEFENSE.raidReserveRatio);
          for (const u of units) {
            if (keep <= 0) break;
            if (u.state === 'orbit' && u.planet === target.id) {
              group.units.delete(u.id);
              keep--;
            }
          }
        }
        if (group.units.size === 0) continue;
        const next = this.rankTargets(world, centroid(this.alive(world, group)), group.wave)[0];
        if (next) this.engage(world, group, next);
        continue;
      }

      if (group.phase === 'chase') {
        this.chase(world, group, units);
        continue;
      }

      const elapsed = world.time - group.phaseAt;
      if (group.phase === 'stage') {
        const defenders = this.defendersNear(world, target);
        let holding = 0;
        for (const u of units) if (u.state === 'hold') holding++;
        const thinned = holding > units.length * DEFENSE.siegeHoldRatio && defenders <= units.length * DEFENSE.siegeDefenderRatio;
        if (thinned || elapsed > DEFENSE.siegeTimeout) {
          group.phase = 'assault';
          group.phaseAt = world.time;
          this.order(world, group.units, { kind: 'planet', planetId: target.id, formation: 'cluster' });
        }
        continue;
      }

      // 돌파가 막혔다: 궤도를 같이 도는 수비대와 서로 닿지 않으면 영영 끝나지 않으므로,
      // 수비대에 비해 너무 적거나 오래 걸리면 가장 가까운 플레이어 병력에게 달려들어 끝장을 본다
      const hopeless = units.length * 3 < target.defense && units.length < this.defendersNear(world, target) * 0.5;
      const stalled = elapsed > DEFENSE.assaultTimeout || (elapsed > DEFENSE.hopelessAfter && hopeless);
      if (stalled) {
        group.phase = 'chase';
        group.phaseAt = world.time;
        this.chase(world, group, units);
        continue;
      }
      // 돌파 중 멈춰 선 병력(도착 후 위치 고수 등)은 다시 대기권으로 밀어 넣는다
      const idle = units.filter((u) => u.state === 'hold' || (u.state === 'orbit' && u.planet !== target.id));
      if (idle.length > 0) this.order(world, idle.map((u) => u.id), { kind: 'planet', planetId: target.id, formation: 'cluster' });
    }

    if (world.time >= this.nextRaid) {
      this.nextRaid = world.time + DEFENSE.raidInterval;
      this.raid(world);
    }
  }

  /** 무리 중심에서 가장 가까운 플레이어 병력 위치로 몰려간다 (매 판단마다 다시 겨눈다) */
  private chase(world: World, group: Group, units: Unit[]): void {
    const c = centroid(units);
    let best: Unit | null = null;
    let bestD = Infinity;
    for (const u of world.units) {
      if (u.faction !== PLAYER) continue;
      const d = (u.x - c.x) ** 2 + (u.y - c.y) ** 2;
      if (d < bestD) {
        bestD = d;
        best = u;
      }
    }
    if (best) this.order(world, group.units, { kind: 'move', x: best.x, y: best.y, formation: 'cluster' });
  }

  /** 빼앗은 행성의 궤도 병력 중 예비를 뺀 나머지를 가장 가까운 아군 행성으로 출격 */
  private raid(world: World): void {
    const busy = new Set<number>();
    for (const g of this.groups) for (const id of g.units) busy.add(id);
    for (const p of world.planets) {
      if (p.owner !== this.faction) continue;
      const free = world.units.filter((u) => u.faction === this.faction && u.state === 'orbit' && u.planet === p.id && !busy.has(u.id));
      const spare = free.length - Math.ceil(p.capacity * DEFENSE.raidReserveRatio);
      if (spare < DEFENSE.raidMin) continue;
      const target = this.rankTargets(world, p, this.wave)[0];
      if (!target) return;
      const group: Group = {
        units: new Set(free.slice(0, spare).map((u) => u.id)),
        wave: this.wave,
        phase: 'assault',
        target: -1,
        gateId: -1,
        phaseAt: world.time,
      };
      this.groups.push(group);
      this.engage(world, group, target);
    }
  }
}

function centroid(units: readonly { x: number; y: number }[]): { x: number; y: number } {
  let x = 0, y = 0;
  for (const u of units) {
    x += u.x;
    y += u.y;
  }
  return { x: x / units.length, y: y / units.length };
}
