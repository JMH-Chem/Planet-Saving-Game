import { CONFIG, FACTION_COLORS, FACTION_NAMES, type PlanetSize } from '../config';
import { angleDiff, applyCommand } from './orders';
import { Rng } from './rng';
import { SpatialGrid } from './spatial';
import {
  NEUTRAL,
  type Command,
  type Faction,
  type FactionId,
  type GameEvent,
  type Planet,
  type Unit,
} from './types';

export interface PlanetInit {
  x: number;
  y: number;
  size: PlanetSize;
  owner: FactionId;
  isHome?: boolean;
  /** 시작 궤도 병력 수 (기본: 중립은 크기별 수비대, 진영 행성은 0) */
  garrison?: number;
}

export interface WorldInit {
  width: number;
  height: number;
  seed: number;
  /** 중립을 제외한 진영 수 (플레이어 포함) */
  factionCount: number;
  /** 진영별 AI 여부 (index = FactionId, 0 번은 무시) */
  aiFactions: boolean[];
  planets: PlanetInit[];
}

export class World {
  readonly width: number;
  readonly height: number;
  readonly rng: Rng;
  readonly factions: Faction[];
  readonly planets: Planet[];
  units: Unit[] = [];
  time = 0;
  tick = 0;
  /** 승자 (null = 진행 중) */
  winner: FactionId | null = null;
  /** 이번 틱에 발생한 이벤트. 렌더러/UI 가 읽고 비운다 */
  events: GameEvent[] = [];
  readonly grid: SpatialGrid;
  /** 진영별 행성 수 / 병력 수 (매 틱 갱신) */
  planetCount: number[];
  unitCount: number[];

  private nextUnitId = 1;
  private unitById = new Map<number, Unit>();
  private pending: Command[] = [];

  constructor(init: WorldInit) {
    this.width = init.width;
    this.height = init.height;
    this.rng = new Rng(init.seed);
    this.grid = new SpatialGrid(init.width, init.height, 32);

    const n = init.factionCount + 1;
    this.factions = Array.from({ length: n }, (_, id) => ({
      id,
      name: FACTION_NAMES[id] ?? `진영 ${id}`,
      color: FACTION_COLORS[id] ?? '#ffffff',
      isAI: id !== NEUTRAL && !!init.aiFactions[id],
      alive: true,
      stats: { produced: 0, lost: 0, kills: 0, planetsCaptured: 0 },
    }));
    this.planetCount = new Array(n).fill(0);
    this.unitCount = new Array(n).fill(0);

    this.planets = init.planets.map((p, id) => {
      const spec = CONFIG.planet[p.size];
      return {
        id,
        x: p.x,
        y: p.y,
        size: p.size,
        radius: spec.radius,
        atmosphereRadius: spec.radius + CONFIG.atmosphere,
        owner: p.owner,
        defense: spec.maxDefense,
        maxDefense: spec.maxDefense,
        production: spec.production,
        capacity: spec.capacity,
        prodProgress: 0,
        lastAssaultAt: -Infinity,
        lastAssaultBy: NEUTRAL,
        isHome: !!p.isHome,
        orbitCount: new Array(n).fill(0),
        presence: new Array(n).fill(0),
      };
    });

    init.planets.forEach((p, id) => {
      const count = p.garrison ?? (p.owner === NEUTRAL ? CONFIG.planet[p.size].neutralGarrison : 0);
      for (let i = 0; i < count; i++) this.spawnUnit(p.owner, this.planets[id], false);
    });
    this.refreshCounts();
  }

  getUnit(id: number): Unit | undefined {
    return this.unitById.get(id);
  }

  /** 명령은 다음 틱 시작 시 적용된다 (락스텝 멀티플레이 대비) */
  enqueue(cmd: Command): void {
    this.pending.push(cmd);
  }

  /** (x, y) 가 대기권 안에 들어가는 행성. pad 만큼 판정 여유를 준다 */
  planetAt(x: number, y: number, pad = 0): Planet | null {
    for (const p of this.planets) {
      const r = p.atmosphereRadius + pad;
      const dx = p.x - x, dy = p.y - y;
      if (dx * dx + dy * dy <= r * r) return p;
    }
    return null;
  }

  spawnUnit(faction: FactionId, planet: Planet, countAsProduced = true): Unit {
    const angle = this.rng.range(0, Math.PI * 2);
    const x = planet.x + Math.cos(angle) * planet.radius;
    const y = planet.y + Math.sin(angle) * planet.radius;
    const u: Unit = {
      id: this.nextUnitId++,
      faction,
      x,
      y,
      px: x,
      py: y,
      hp: CONFIG.unit.hp,
      cooldown: this.rng.range(0, CONFIG.unit.attackInterval),
      state: 'orbit',
      planet: planet.id,
      tx: x,
      ty: y,
      orbitAngle: angle,
      orbitAltitude: this.rng.range(CONFIG.orbitBand[0], CONFIG.orbitBand[1]),
      isolated: false,
      inPlanet: planet.id,
      alive: true,
    };
    this.units.push(u);
    this.unitById.set(u.id, u);
    if (countAsProduced) this.factions[faction].stats.produced++;
    return u;
  }

  step(dt = 1 / CONFIG.tickRate): void {
    if (this.winner !== null) return;

    for (const cmd of this.pending) applyCommand(this, cmd);
    this.pending.length = 0;

    for (const u of this.units) this.moveUnit(u, dt);
    this.refreshCounts();
    this.grid.rebuild(this.units);
    this.combat(dt);
    this.removeDead();
    this.resolveCaptures();
    this.updatePlanets(dt);
    this.refreshCounts();
    this.updateFactions();

    this.time += dt;
    this.tick++;
  }

  // ───────────────────────────── 이동 ─────────────────────────────

  private moveUnit(u: Unit, dt: number): void {
    u.px = u.x;
    u.py = u.y;
    let gx: number, gy: number;
    if (u.state === 'orbit') {
      const p = this.planets[u.planet];
      u.orbitAngle += CONFIG.orbitSpeed * dt;
      const r = p.radius + u.orbitAltitude;
      gx = p.x + Math.cos(u.orbitAngle) * r;
      gy = p.y + Math.sin(u.orbitAngle) * r;
    } else {
      gx = u.tx;
      gy = u.ty;
    }
    const step = CONFIG.unit.speed * dt;
    const via = u.state === 'move' ? this.detour(u) : null;
    if (via) {
      const vx = via.x - u.x, vy = via.y - u.y;
      const vd = Math.hypot(vx, vy) || 1;
      u.x += (vx / vd) * Math.min(step, vd);
      u.y += (vy / vd) * Math.min(step, vd);
      return;
    }
    const dx = gx - u.x, dy = gy - u.y;
    const d = Math.hypot(dx, dy);
    if (d <= step) {
      u.x = gx;
      u.y = gy;
      if (u.state === 'move') this.arrive(u);
    } else {
      u.x += (dx / d) * step;
      u.y += (dy / d) * step;
    }
  }

  /**
   * 목적지가 그 안쪽이 아니라면 적 행성 대기권을 가로지르지 않고 접선 방향으로 돌아간다.
   * (이동/포위 명령이 의도치 않게 강하가 되는 것을 막는다. 돌파는 목적지가 대기권 안이라 그대로 직진)
   */
  private detour(u: Unit): { x: number; y: number } | null {
    let best: Planet | null = null;
    let bestT = Infinity;
    for (const p of this.planets) {
      if (p.owner === u.faction) continue;
      const ra = p.atmosphereRadius + 3;
      const ux = u.x - p.x, uy = u.y - p.y;
      const tx = u.tx - p.x, ty = u.ty - p.y;
      if (ux * ux + uy * uy < p.atmosphereRadius ** 2 || tx * tx + ty * ty < ra * ra) continue;
      const sx = tx - ux, sy = ty - uy;
      const len2 = sx * sx + sy * sy || 1;
      const t = Math.max(0, Math.min(1, -(ux * sx + uy * sy) / len2));
      const cx = ux + sx * t, cy = uy + sy * t;
      if (cx * cx + cy * cy < ra * ra && t < bestT) {
        bestT = t;
        best = p;
      }
    }
    if (!best) return null;
    const ra = best.atmosphereRadius + 3;
    const au = Math.atan2(u.y - best.y, u.x - best.x);
    const at = Math.atan2(u.ty - best.y, u.tx - best.x);
    const sign = angleDiff(at, au) >= 0 ? 1 : -1;
    const du = Math.hypot(u.x - best.x, u.y - best.y);
    const a = au + sign * (Math.acos(Math.min(1, ra / Math.max(du, ra))) + 0.25);
    return { x: best.x + Math.cos(a) * (ra + 2), y: best.y + Math.sin(a) * (ra + 2) };
  }

  private arrive(u: Unit): void {
    if (u.planet >= 0) {
      const p = this.planets[u.planet];
      u.state = 'orbit';
      u.orbitAngle = Math.atan2(u.y - p.y, u.x - p.x);
      u.orbitAltitude = Math.hypot(u.x - p.x, u.y - p.y) - p.radius;
    } else {
      u.state = 'hold';
    }
  }

  // ───────────────────────────── 전투 ─────────────────────────────

  private combat(dt: number): void {
    const { unit, isolation } = CONFIG;
    for (const u of this.units) {
      if (u.isolated) u.hp -= isolation.hpLossPerSec * dt;
      if (u.hp <= 0) continue;
      u.cooldown -= dt;
      if (u.cooldown > 0) continue;

      const mult = u.isolated ? isolation.damageMult : 1;
      const nextCooldown = unit.attackInterval * (1 + this.rng.range(-unit.attackJitter, unit.attackJitter));

      // 위치 규칙: 적(또는 중립) 행성 대기권 안이면 행성 표면을 직접 공격한다 (강하).
      // 행성 방어막은 궤도 수비대가 유지한다: 피해 = 기본 × 공격측 / (공격측 + 수비측).
      if (u.inPlanet >= 0) {
        const p = this.planets[u.inPlanet];
        if (p.owner !== u.faction) {
          const atk = p.presence[u.faction];
          const control = atk / (atk + p.presence[p.owner]);
          p.defense -= unit.damage * unit.planetDamageMult * mult * control;
          p.lastAssaultAt = this.time;
          p.lastAssaultBy = u.faction;
          const a = Math.atan2(u.y - p.y, u.x - p.x);
          this.events.push({
            type: 'shot', x1: u.x, y1: u.y,
            x2: p.x + Math.cos(a) * p.radius, y2: p.y + Math.sin(a) * p.radius,
            faction: u.faction, planet: true,
          });
          u.cooldown = nextCooldown;
          continue;
        }
      }

      // 그 외: 사거리 안 가장 가까운 적 병력과 교전.
      const target = this.grid.nearest(u.x, u.y, unit.range, (v) => v.faction !== u.faction && v.hp > 0);
      if (!target) {
        u.cooldown = 0.2;
        continue;
      }
      target.hp -= unit.damage * mult;
      if (target.hp <= 0) this.factions[u.faction].stats.kills++;
      this.events.push({ type: 'shot', x1: u.x, y1: u.y, x2: target.x, y2: target.y, faction: u.faction, planet: false });
      u.cooldown = nextCooldown;
    }
  }

  private removeDead(): void {
    let w = 0;
    for (const u of this.units) {
      if (u.hp > 0) {
        this.units[w++] = u;
      } else {
        u.alive = false;
        this.unitById.delete(u.id);
        this.factions[u.faction].stats.lost++;
        this.events.push({ type: 'death', x: u.x, y: u.y, faction: u.faction });
      }
    }
    this.units.length = w;
  }

  // ───────────────────────────── 행성 ─────────────────────────────

  private resolveCaptures(): void {
    for (const p of this.planets) {
      if (p.defense > 0) continue;
      // 대기권 안 병력이 가장 많은 (소유자가 아닌) 진영이 차지한다.
      let to = p.lastAssaultBy;
      let best = 0;
      p.presence.forEach((count, f) => {
        if (f !== p.owner && count > best) {
          best = count;
          to = f;
        }
      });
      if (to === p.owner) {
        p.defense = 1;
        continue;
      }
      this.capture(p, to);
    }
  }

  capture(p: Planet, to: FactionId): void {
    const from = p.owner;
    p.owner = to;
    p.defense = p.maxDefense * CONFIG.captureDefense;
    p.prodProgress = 0;
    p.lastAssaultAt = this.time;
    // 그 행성 궤도를 지키던 병력은 보급이 끊겨 고립된다.
    for (const u of this.units) {
      if (u.faction === from && u.state === 'orbit' && u.planet === p.id) u.isolated = true;
    }
    this.factions[to].stats.planetsCaptured++;
    this.events.push({ type: 'capture', planetId: p.id, from, to });
  }

  private updatePlanets(dt: number): void {
    for (const p of this.planets) {
      if (this.time - p.lastAssaultAt > CONFIG.regenDelay) {
        p.defense = Math.min(p.maxDefense, p.defense + p.maxDefense * CONFIG.regenRate * dt);
      }
      if (p.owner === NEUTRAL || p.orbitCount[p.owner] >= p.capacity) continue;
      p.prodProgress += p.production * dt;
      while (p.prodProgress >= 1) {
        p.prodProgress -= 1;
        this.spawnUnit(p.owner, p);
        p.orbitCount[p.owner]++;
      }
    }
  }

  // ───────────────────────────── 집계 ─────────────────────────────

  private refreshCounts(): void {
    for (const p of this.planets) {
      p.orbitCount.fill(0);
      p.presence.fill(0);
    }
    this.planetCount.fill(0);
    this.unitCount.fill(0);
    for (const p of this.planets) this.planetCount[p.owner]++;

    for (const u of this.units) {
      this.unitCount[u.faction]++;
      u.inPlanet = -1;
      for (const p of this.planets) {
        const dx = p.x - u.x, dy = p.y - u.y;
        if (dx * dx + dy * dy <= p.atmosphereRadius * p.atmosphereRadius) {
          u.inPlanet = p.id;
          p.presence[u.faction]++;
          if (u.isolated && p.owner === u.faction) u.isolated = false;
          break;
        }
      }
      if (u.state === 'orbit') this.planets[u.planet].orbitCount[u.faction]++;
      // 행성을 모두 잃은 진영의 병력은 전원 고립.
      if (this.planetCount[u.faction] === 0) u.isolated = true;
    }
  }

  private updateFactions(): void {
    let aliveCount = 0;
    let last: FactionId = NEUTRAL;
    for (const f of this.factions) {
      if (f.id === NEUTRAL || !f.alive) continue;
      if (this.planetCount[f.id] === 0 && this.unitCount[f.id] === 0) {
        f.alive = false;
        this.events.push({ type: 'eliminated', faction: f.id });
        continue;
      }
      aliveCount++;
      last = f.id;
    }
    if (aliveCount <= 1) this.winner = last;
  }
}
