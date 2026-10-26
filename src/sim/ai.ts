import { AI_PROFILES, AI_REINFORCE_RADIUS, type AIProfile, type Difficulty } from '../config';
import { NEUTRAL, type FactionId, type Order, type Planet, type Unit } from './types';
import type { World } from './world';

/**
 * 상대가 둘 이상이면 행성이 가장 적은 상대의 행성 가치에 곱하는 배율.
 * 고르게 강한 진영 셋 이상이 서로 행성을 주고받기만 하면 판이 끝나지 않으므로 약한 쪽부터 정리한다 (1:1 에선 영향 없음)
 */
const WEAKEST_RIVAL_BONUS = 3;

interface Operation {
  target: number;
  units: Set<number>;
  /** stage = 대기권 밖에서 포위 교전 중, assault = 돌파 중 */
  phase: 'stage' | 'assault';
  startedAt: number;
  initial: number;
}

/**
 * 규칙 기반 AI. 플레이어와 똑같이 Command 만으로 게임에 개입한다.
 * - 방어: 위협받는 행성에 가까운 행성의 여유 병력을 보낸다.
 * - 공격: (가치 / 필요 전력 / 거리) 점수가 가장 높은 행성을 고르고,
 *         수비대가 두꺼우면 포위로 수비대를 깎은 뒤 돌파한다.
 */
export class AIController {
  private ops: Operation[] = [];
  private nextThink: number;
  private readonly profile: AIProfile;

  constructor(
    readonly faction: FactionId,
    difficulty: Difficulty,
    firstThinkAt = 1,
  ) {
    this.profile = AI_PROFILES[difficulty];
    this.nextThink = firstThinkAt;
  }

  update(world: World): void {
    if (world.time < this.nextThink) return;
    this.nextThink = world.time + this.profile.thinkInterval;
    if (!world.factions[this.faction].alive) return;
    this.think(world);
  }

  private order(world: World, units: Unit[] | Set<number>, order: Order): void {
    const unitIds = Array.isArray(units) ? units.map((u) => u.id) : [...units];
    if (unitIds.length > 0) world.enqueue({ faction: this.faction, unitIds, order });
  }

  /** 행성 주변(대기권 + pad)의 적 병력 수 */
  private hostilesNear(world: World, p: Planet, pad: number, includeNeutral: boolean): number {
    let n = 0;
    world.grid.forEachInRadius(p.x, p.y, p.atmosphereRadius + pad, (u) => {
      if (u.alive && u.faction !== this.faction && (includeNeutral || u.faction !== NEUTRAL)) n++;
    });
    return n;
  }

  /** 다른 진영 행성 t 의 주인이 그 대기권 밖 가까이(AI_REINFORCE_RADIUS)에 둔 병력: 곧 증원으로 올 수 있다 */
  private reinforcementsNear(world: World, t: Planet): number {
    let n = 0;
    world.grid.forEachInRadius(t.x, t.y, AI_REINFORCE_RADIUS, (u) => {
      if (u.alive && u.faction === t.owner && u.inPlanet !== t.id) n++;
    });
    return n;
  }

  private think(world: World): void {
    const me = this.faction;
    const assigned = new Set<number>();
    for (const op of this.ops) {
      for (const id of op.units) {
        if (world.getUnit(id)) assigned.add(id);
        else op.units.delete(id);
      }
    }
    this.updateOps(world);

    const myPlanets = world.planets.filter((p) => p.owner === me);
    const myUnits = world.units.filter((u) => u.faction === me);

    if (myPlanets.length === 0) {
      // 행성을 전부 잃었다: 남은 병력 전원으로 가장 가까운 행성에 돌파.
      if (myUnits.length === 0) return;
      const c = myUnits[0];
      const target = [...world.planets].sort((a, b) => dist(a, c) - dist(b, c))[0];
      this.order(world, myUnits, { kind: 'planet', planetId: target.id, formation: 'cluster' });
      return;
    }

    // 놀고 있는 병력 분류
    const free = new Map<Planet, Unit[]>(myPlanets.map((p) => [p, []]));
    const stragglers: Unit[] = [];
    const isolatedAt = new Map<number, Unit[]>();
    for (const u of myUnits) {
      if (assigned.has(u.id) || u.state === 'move') continue;
      if (u.isolated) {
        const list = isolatedAt.get(u.inPlanet) ?? [];
        list.push(u);
        isolatedAt.set(u.inPlanet, list);
      } else if (u.state === 'orbit' && world.planets[u.planet].owner === me) {
        free.get(world.planets[u.planet])!.push(u);
      } else {
        stragglers.push(u);
      }
    }
    this.order(world, stragglers, { kind: 'return' });

    // 고립된 병력: 행성을 되찾을 수 있을 것 같으면 버티고, 아니면 퇴각
    for (const [planetId, list] of isolatedAt) {
      const p = planetId >= 0 ? world.planets[planetId] : null;
      if (!p || p.owner === me || p.defense > list.length * 3) this.order(world, list, { kind: 'return' });
    }

    const reserveOf = (p: Planet) => Math.ceil(p.capacity * this.profile.reserveRatio);
    const spare = (p: Planet) => Math.max(0, free.get(p)!.length - reserveOf(p));
    const take = (p: Planet, count: number) => free.get(p)!.splice(free.get(p)!.length - count, count);

    // ── 방어 ──
    for (const p of myPlanets) {
      const threat = this.hostilesNear(world, p, 60, false);
      if (threat === 0) continue;
      const garrison = p.orbitCount[me];
      let need = Math.ceil(threat * 1.3 - garrison);
      if (need <= 0) continue;
      const helpers = myPlanets.filter((q) => q !== p && dist(q, p) < 750).sort((a, b) => dist(a, p) - dist(b, p));
      for (const q of helpers) {
        if (need <= 0) break;
        const n = Math.min(spare(q), need);
        if (n <= 0) continue;
        this.order(world, take(q, n), { kind: 'planet', planetId: p.id, formation: 'cluster' });
        need -= n;
      }
    }

    // ── 공격 ──
    const sources = myPlanets.filter((p) => spare(p) > 0);
    const total = sources.reduce((s, p) => s + spare(p), 0);
    if (total < 6) return;

    const targeted = new Set(this.ops.map((o) => o.target));
    const rivals = world.factions.filter((f) => f.id !== NEUTRAL && f.id !== me && world.planetCount[f.id] > 0);
    const weakest = rivals.length >= 2 ? rivals.reduce((a, b) => (world.planetCount[b.id] < world.planetCount[a.id] ? b : a)).id : -1;
    const candidates = world.planets
      .filter((t) => t.owner !== me && !targeted.has(t.id))
      .map((t) => {
        const defenders = this.hostilesNear(world, t, 10, true);
        // 중립은 증원이 없어 수비대만 넘으면 된다: 돌파 병력은 행성만 치고 수비대는 그동안 돌파 병력을 쏘므로
        // 수비대 × 방어도에 비례해 손실이 커진다 (sqrt 항). 수비대가 다 죽은 중립에 몇 기만 보내 시간 초과로 끝나지 않게 하한도 둔다.
        // 다른 진영 행성은 재생산과 증원이 있으므로 방어도를 그대로 반영하고, 성향에 따라 이웃의 증원 병력도 센다
        const { reinforceWeight } = this.profile;
        const need =
          t.owner === NEUTRAL
            ? Math.max(defenders * 1.6 + 4, Math.sqrt((defenders * t.defense) / 2) + 2)
            : (defenders + (reinforceWeight > 0 ? reinforceWeight * this.reinforcementsNear(world, t) : 0)) * 1.4 +
              t.defense / 6 +
              2;
        const d = Math.min(...sources.map((s) => dist(s, t)));
        const value =
          t.owner === NEUTRAL
            ? t.production * 10
            : (t.production * 10 + 2 + (t.isHome ? 3 : 0)) *
              this.profile.enemyPressure *
              (t.owner === weakest ? WEAKEST_RIVAL_BONUS : 1);
        return { t, defenders, need, score: value / (need + 4) / (1 + d / 400) };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, 3);

    let launched = 0;
    for (const c of candidates) {
      const wanted = Math.ceil(c.need * this.profile.attackMargin);
      const near = sources.filter((s) => dist(s, c.t) < 900).sort((a, b) => dist(a, c.t) - dist(b, c.t));
      if (near.reduce((s, p) => s + spare(p), 0) < wanted) continue;

      const force: Unit[] = [];
      for (const s of near) {
        if (force.length >= wanted) break;
        force.push(...take(s, Math.min(spare(s), wanted - force.length)));
      }
      const stage = this.profile.usesStaging && c.defenders >= 8 && c.defenders > force.length * 0.3;
      this.order(world, force, { kind: 'planet', planetId: c.t.id, formation: stage ? 'spread' : 'cluster' });
      this.ops.push({
        target: c.t.id,
        units: new Set(force.map((u) => u.id)),
        phase: stage ? 'stage' : 'assault',
        startedAt: world.time,
        initial: force.length,
      });
      // 한 번 판단에 시작하는 공격 수는 성향마다 다르다 (어려움은 두 곳을 동시에 친다)
      if (++launched >= this.profile.launchesPerThink) break;
    }
  }

  private updateOps(world: World): void {
    this.ops = this.ops.filter((op) => {
      const t = world.planets[op.target];
      const alive = op.units.size;
      if (alive === 0 || t.owner === this.faction) return false;
      const elapsed = world.time - op.startedAt;

      if (op.phase === 'stage') {
        const defenders = this.hostilesNear(world, t, 10, true);
        let holding = 0;
        for (const id of op.units) if (world.getUnit(id)?.state === 'hold') holding++;
        if (alive < defenders * 0.7) {
          this.order(world, op.units, { kind: 'return' });
          return false;
        }
        if ((holding > alive * 0.7 && defenders <= alive * 0.35) || elapsed > 30) {
          this.order(world, op.units, { kind: 'planet', planetId: t.id, formation: 'cluster' });
          op.phase = 'assault';
          op.startedAt = world.time;
        }
        return true;
      }

      const failing = alive < op.initial * 0.25 && t.defense > alive * 3;
      if (failing || elapsed > 60) {
        this.order(world, op.units, { kind: 'return' });
        return false;
      }
      return true;
    });
  }
}

function dist(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}
