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
  type WarpGate,
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

/**
 * 병력 하나의 운동 상태. 렌더러 · AI 가 알 필요 없는 시뮬레이션 내부 값이라 Unit 타입 밖(World.motion)에 둔다.
 * 위치 · 체력처럼 판의 상태이므로 저장 · 리플레이 검증을 붙일 때는 이것도 함께 직렬화해야 한다.
 */
interface Motion {
  /** 속도(px/s). 방향 = 함선이 향하는 쪽 */
  vx: number;
  vy: number;
  /** 같은 명령으로 함께 출발한 무리 (null = 혼자) */
  group: MoveGroup | null;
  /** 이번 틱의 목표 지점과 그 지점의 속도 (궤도는 도는 점과 접선 속도, 그 밖에는 tx/ty 와 0) */
  gx: number;
  gy: number;
  gvx: number;
  gvy: number;
}

/**
 * 한 명령으로 함께 출발한 무리. 남은 거리가 가장 긴 구성원이 최고 속도로 가고, 그보다 한참 먼저 닿을 구성원은
 * 남은 거리 비율만큼 느리게 가서 거의 함께 도착한다 (CONFIG.formation.arriveWindow · minPace, World.pace).
 */
interface MoveGroup {
  /** 직전 틱에 잰, 아직 이동 중인 구성원의 남은 거리 최댓값 */
  lead: number;
  /** 이번 틱에 재는 중인 최댓값 (다음 틱의 lead) */
  next: number;
  /** next 를 재기 시작한 틱 */
  tick: number;
}

/** 이만큼(px) 가까워지면 슬롯에 도착한 것으로 보고 슬롯에 정확히 세운다 (슬롯 고도 · 대기권 안팎 판정을 그대로 지키려고) */
const ARRIVE_EPS = 0.75;
/** 도착 감속에 쓰는 감속도 = 가속 한계 × 이 값. 한계보다 조금 낮아야 슬롯을 지나치지 않는다 */
const ARRIVE_BRAKE = 0.8;
/** 슬롯 바로 앞에서는 속도를 남은 거리에 비례해 줄인다(1/s): 한 틱에 남은 거리의 27% 만 가서 마지막 몇 px 를 지나치지 않는다 */
const ARRIVE_GAIN = 8;
/** 이보다 느리면(px/s) 함선이 제자리에서 방향을 바꾼다 */
const STOP_SPEED = 1;
/** 궤도 병력의 겹침을 풀 때 내려갈 수 있는 최저 고도(표면 기준) */
const MIN_ORBIT_ALT = 2;
/**
 * 겹침 풀기는 이 틱마다 한 번, 그만큼 크게 민다. 초당 몇 px 의 느린 이완이라 매 틱 할 까닭이 없고,
 * 촘촘한 궤도 · 대형에서 쌍 검사가 틱 시간의 15% 가까이 들었다 (방어전 1000기 이상)
 */
const SEPARATE_EVERY = 3;

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
  /** 방어전 워프 게이트 (정복전에서는 항상 비어 있음) */
  gates: WarpGate[] = [];
  /**
   * 승패 규칙 교체용 훅 (방어전 등). 매 틱 끝에 호출되며, 승자를 반환하면 게임이 끝난다.
   * null 이면 기본 규칙: 살아남은 (중립 제외) 진영이 하나뿐일 때 그 진영이 승리.
   */
  winRule: ((world: World) => FactionId | null) | null = null;
  /** 이번 틱에 발생한 이벤트. 렌더러/UI 가 읽고 비운다 */
  events: GameEvent[] = [];
  readonly grid: SpatialGrid;
  /** 진영별 행성 수 / 병력 수 (매 틱 갱신) */
  planetCount: number[];
  unitCount: number[];

  private nextUnitId = 1;
  private unitById = new Map<number, Unit>();
  private pending: Command[] = [];
  /** 병력별 운동 상태 (죽은 병력의 것은 저절로 사라지도록 WeakMap) */
  private motion = new WeakMap<Unit, Motion>();
  /** 이번 틱 units[i] 의 운동 상태 (WeakMap 조회를 틱마다 한 번으로 줄인다) */
  private mo: Motion[] = [];
  /** 이번 틱 units[i] 의 사격 자격: 틱을 살아서 시작했는가 (동시 판정, combat 참고) */
  private armed = new Uint8Array(0);
  private readonly pack: PackGrid;
  /** 이번 틱 steer 가 쓰는 cos(turnRate × dt) */
  private straightCos = 1;
  /** refreshCounts 의 대기권 판정용 행성 후보 격자 (행성 배치가 바뀌면 다시 만든다) */
  private lookup: PlanetLookup | null = null;

  constructor(init: WorldInit) {
    this.width = init.width;
    this.height = init.height;
    this.rng = new Rng(init.seed);
    this.grid = new SpatialGrid(init.width, init.height, 32);
    // 칸 = 겹침 반경 (이웃 3×3 칸이면 충분한 가장 작은 칸: 촘촘한 궤도 · 대형에서 살펴볼 쌍이 가장 적다)
    this.pack = new PackGrid(init.width, init.height, Math.max(2, CONFIG.formation.separation));

    const n = init.factionCount + 1;
    this.factions = Array.from({ length: n }, (_, id) => ({
      id,
      name: FACTION_NAMES[id] ?? `진영 ${id}`,
      color: FACTION_COLORS[id] ?? '#ffffff',
      isAI: id !== NEUTRAL && !!init.aiFactions[id],
      alive: true,
      invader: false,
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
    return this.register(u, countAsProduced);
  }

  /** 우주 공간 (x, y) 에 위치 고수 상태로 병력을 만든다 (방어전 워프 게이트 출현) */
  spawnAt(faction: FactionId, x: number, y: number, countAsProduced = true): Unit {
    const u: Unit = {
      id: this.nextUnitId++,
      faction,
      x,
      y,
      px: x,
      py: y,
      hp: CONFIG.unit.hp,
      cooldown: this.rng.range(0, CONFIG.unit.attackInterval),
      state: 'hold',
      planet: -1,
      tx: x,
      ty: y,
      orbitAngle: 0,
      orbitAltitude: this.rng.range(CONFIG.orbitBand[0], CONFIG.orbitBand[1]),
      isolated: false,
      inPlanet: -1,
      alive: true,
    };
    return this.register(u, countAsProduced);
  }

  private register(u: Unit, countAsProduced: boolean): Unit {
    this.units.push(u);
    this.unitById.set(u.id, u);
    this.motion.set(u, newMotion(u));
    if (countAsProduced) this.factions[u.faction].stats.produced++;
    return u;
  }

  step(dt = 1 / CONFIG.tickRate): void {
    if (this.winner !== null) return;

    for (const cmd of this.pending) for (const group of applyCommand(this, cmd)) this.formGroup(group);
    this.pending.length = 0;

    this.moveUnits(dt);
    this.refreshCounts();
    this.grid.rebuild(this.units);
    this.combat(dt);
    // 점령과 생산 정원은 이번 전투에서 살아남은 병력으로 판단한다.
    if (this.removeDead()) this.refreshCounts();
    this.resolveCaptures();
    this.updatePlanets(dt);
    this.refreshCounts();
    this.updateFactions();

    this.time += dt;
    this.tick++;
  }

  // ───────────────────────────── 이동 ─────────────────────────────

  private motionOf(u: Unit): Motion {
    let m = this.motion.get(u);
    if (!m) {
      // register 를 거치지 않고 만든 병력 (없어야 하지만, 있어도 멈춘 상태에서 시작하면 그만이다)
      m = newMotion(u);
      this.motion.set(u, m);
    }
    return m;
  }

  /** 한 명령으로 슬롯을 받은 무리를 묶는다. 첫 틱의 기준은 가장 먼 구성원의 (직선) 남은 거리 */
  private formGroup(units: readonly Unit[]): void {
    const g: MoveGroup = { lead: 0, next: 0, tick: this.tick };
    for (const u of units) {
      const dx = u.tx - u.x, dy = u.ty - u.y;
      g.lead = Math.max(g.lead, this.paceDistance(u, Math.sqrt(dx * dx + dy * dy)));
      this.motionOf(u).group = g;
    }
  }

  /**
   * 보폭을 맞출 때 재는 남은 거리. 0 이하 = 맞추지 않는다 (최고 속도로 슬롯까지).
   *  - 아군 행성 합류는 슬롯이 아니라 대기권 경계까지: 수비대로 세는 건 대기권에 들어선 순간부터이고, 안쪽 슬롯까지 남은
   *    길은 슬롯이 행성 어느 쪽이냐에 따라 제각각이라 그것까지 맞추면 앞줄이 대기권 밖에서 공연히 기다린다.
   *  - 돌파(남의 행성으로 강하)는 맞추지 않고 저마다 최고 속도로 들이친다. 다 같이 한순간에 들이치게 하면 강하 병력이
   *    처음부터 방어막 비율(공격측 / (공격측 + 수비측))을 다 받아 두꺼운 수비대도 뚫린다
   *    (헤드리스 측정: 100 대 70 돌파 성공 2/10 → 10/10, 60 대 30 돌파 손실 23 → 10기) — '두꺼우면 포위 후 돌파' 라는
   *    핵심 선택이 사라진다. 돌파 슬롯이 이미 진입 방향으로 뭉친 고리라 무리는 그것만으로 한 덩어리로 들어간다.
   */
  private paceDistance(u: Unit, remaining: number): number {
    if (u.planet < 0) return remaining;
    const p = this.planets[u.planet];
    if (p.owner !== u.faction) return 0;
    const dx = u.x - p.x, dy = u.y - p.y;
    return Math.sqrt(dx * dx + dy * dy) - p.atmosphereRadius;
  }

  /**
   * 이동 = 목표 정하기 → 겹친 자리 풀기 → 조향 · 적분. 세 단계 모두 units 배열 순서로 돌아 결정론적이다.
   * 겹침은 모든 병력의 목표를 정한 뒤 한꺼번에 푼다 (앞 병력이 움직인 결과가 뒤 병력의 판단에 섞이지 않게).
   */
  private moveUnits(dt: number): void {
    const units = this.units;
    const n = units.length;
    const mo = this.mo;
    mo.length = n;
    // 최고 속도에서 한 틱에 꺾을 수 있는 각도의 cos (더 느리면 더 크게 꺾을 수 있으므로 이 안이면 늘 통과)
    this.straightCos = Math.cos(CONFIG.unit.turnRate * dt);
    for (let i = 0; i < n; i++) {
      const u = units[i];
      u.px = u.x;
      u.py = u.y;
      const m = this.motionOf(u);
      mo[i] = m;
      if (u.state === 'orbit') {
        const p = this.planets[u.planet];
        u.orbitAngle += this.orbitRate(u, p) * dt;
        this.orbitGoal(u, m, p);
      } else {
        m.gx = u.tx;
        m.gy = u.ty;
        m.gvx = 0;
        m.gvy = 0;
      }
    }
    if (this.tick % SEPARATE_EVERY === 0) this.separate(dt * SEPARATE_EVERY);
    for (let i = 0; i < n; i++) this.steer(units[i], mo[i], dt);
  }

  /**
   * 궤도 각속도(rad/s). 소유자의 병력과 침입자는 서로 반대로 돈다 (CONFIG.intruderOrbitFactor).
   * 소유는 매 틱 다시 보므로 점령 직후 새 주인의 병력과 고립된 옛 수비대도 바로 방향이 바뀐다
   */
  private orbitRate(u: Unit, p: Planet): number {
    return CONFIG.orbitSpeed * (p.owner === u.faction ? 1 : CONFIG.intruderOrbitFactor);
  }

  /** 궤도 목표 = 지금 각도 · 고도의 점, 목표 속도 = 그 점의 접선 속도 (미리 따라 돌아서 궤도를 매끄럽게 탄다) */
  private orbitGoal(u: Unit, m: Motion, p: Planet): void {
    const w = this.orbitRate(u, p);
    const r = p.radius + u.orbitAltitude;
    const c = Math.cos(u.orbitAngle), s = Math.sin(u.orbitAngle);
    m.gx = p.x + c * r;
    m.gy = p.y + s * r;
    m.gvx = -s * r * w;
    m.gvy = c * r * w;
  }

  /**
   * 같은 진영끼리 한 점에 겹쳐 선 병력의 자리를 조금씩 밀어낸다 (CONFIG.formation.separation).
   * 속도가 아니라 자리(위치 고수 = tx/ty, 궤도 = 고도 · 각도)를 옮기므로 조향과 다투지 않고, 풀린 뒤엔 그대로 멈춘다.
   * 같은 상태끼리만 민다(궤도는 같은 행성끼리): 이동 중인 무리는 2-opt 배정과 보폭 맞추기로 서로 엇갈리지 않고,
   * 지나가는 무리가 세워 둔 대형을 흩뜨리거나 도는 궤도 병력이 멈춘 병력을 끌고 다니지 않게.
   */
  private separate(dt: number): void {
    const units = this.units;
    const mo = this.mo;
    const pk = this.pack;
    pk.build(units, mo);
    if (!pk.push(CONFIG.formation.separation)) return;
    const { pushX, pushY } = pk;

    const step = CONFIG.formation.separationRate * dt;
    for (let i = 0; i < units.length; i++) {
      const sx = pushX[i] * step, sy = pushY[i] * step;
      if (sx === 0 && sy === 0) continue;
      const u = units[i], m = mo[i];
      if (u.state === 'orbit') {
        const p = this.planets[u.planet];
        const c = Math.cos(u.orbitAngle), s = Math.sin(u.orbitAngle);
        const r = p.radius + u.orbitAltitude;
        // 대기권 안에 머물러야 수비대 · 강하 병력으로 센다
        u.orbitAltitude = Math.min(CONFIG.atmosphere - 1, Math.max(MIN_ORBIT_ALT, u.orbitAltitude + sx * c + sy * s));
        u.orbitAngle += (-sx * s + sy * c) / r;
        this.orbitGoal(u, m, p);
      } else {
        const x = Math.min(this.width, Math.max(0, u.tx + sx));
        const y = Math.min(this.height, Math.max(0, u.ty + sy));
        // 대기권 경계를 넘겨 밀지 않는다: 포위 대형이 밀려 들어가 강하가 되거나 대기권 위에 세운 병력이 밀려나지 않게
        if (this.planetAt(x, y) !== this.planetAt(u.tx, u.ty)) continue;
        u.tx = m.gx = x;
        u.ty = m.gy = y;
      }
    }
  }

  /**
   * 원하는 속도를 정하고, 가속 · 선회 한계 안에서 따라간다.
   *  - 이동: 슬롯(또는 우회 지점)으로. 무리의 보폭에 맞춘 속도, 슬롯 앞에서는 지나치지 않게 감속
   *  - 궤도 · 위치 고수: 목표 지점의 속도 + 남은 거리 보정 (도착 감속과 같은 곡선)
   * 함선은 한 틱에 정해진 각도만큼만 방향을 틀 수 있고(빠를수록 크게 돈다), 원하는 방향과 어긋난 만큼 감속한다
   * (직각이면 절반, 정반대면 거의 멈추며 돈다): 반대 방향 명령은 짧은 U 턴이 되고, 슬롯 둘레를 빙빙 돌지 않는다.
   */
  private steer(u: Unit, m: Motion, dt: number): void {
    const { speed, accel, turnRate } = CONFIG.unit;
    let dx: number, dy: number;
    let via: { x: number; y: number } | null = null;
    if (u.state === 'move') {
      via = this.detour(u);
      const ax = via ? via.x : u.tx, ay = via ? via.y : u.ty;
      const ex = ax - u.x, ey = ay - u.y;
      const d = Math.sqrt(ex * ex + ey * ey);
      let remaining = d;
      if (via) {
        const fx = u.tx - via.x, fy = u.ty - via.y;
        remaining += Math.sqrt(fx * fx + fy * fy);
      }
      const ahead = this.paceDistance(u, remaining);
      // 감속은 우회 지점이 아니라 슬롯까지 남은 길 기준: 슬롯 바로 앞까지 우회하던 함선도 제때 멈춘다
      const want = Math.min(ahead > 0 ? speed * this.pace(m.group, ahead) : speed, arriveSpeed(remaining));
      dx = d > 1e-9 ? (ex / d) * want : 0;
      dy = d > 1e-9 ? (ey / d) * want : 0;
    } else {
      const ex = m.gx - u.x, ey = m.gy - u.y;
      const d = Math.sqrt(ex * ex + ey * ey);
      const k = d > 1e-9 ? arriveSpeed(d) / d : 0;
      dx = m.gvx + ex * k;
      dy = m.gvy + ey * k;
      const s = Math.sqrt(dx * dx + dy * dy);
      if (s > speed) {
        dx *= speed / s;
        dy *= speed / s;
      }
    }

    // 선회 · 가감속 한계
    const want = Math.sqrt(dx * dx + dy * dy);
    const cur = Math.sqrt(m.vx * m.vx + m.vy * m.vy);
    let hx: number, hy: number, target: number;
    if (want < 1e-9) {
      // 멈추려는 중: 방향은 그대로 두고 감속만
      hx = cur > 1e-9 ? m.vx / cur : 0;
      hy = cur > 1e-9 ? m.vy / cur : 0;
      target = 0;
    } else {
      const wx = dx / want, wy = dy / want;
      if (cur < STOP_SPEED) {
        hx = wx;
        hy = wy;
      } else {
        const cx = m.vx / cur, cy = m.vy / cur;
        const dot = cx * wx + cy * wy;
        // 횡가속 한계(turnRate × speed): 느릴수록 빨리 돈다. 선회 반경 = 속도² / 한계 → 최고 속도 11px, 도착 직전엔 1px 미만
        const maxTurn = Math.min(Math.PI, ((turnRate * speed) / cur) * dt);
        // 대부분(궤도 · 직진)은 최고 속도에서도 한 틱에 꺾을 수 있는 각도 안이라 삼각함수 없이 바로 통과
        if (dot >= this.straightCos || dot >= Math.cos(maxTurn)) {
          hx = wx;
          hy = wy;
        } else {
          // 원하는 방향 쪽으로 maxTurn 만큼만 돌린다
          const sin = cx * wy - cy * wx >= 0 ? Math.sin(maxTurn) : -Math.sin(maxTurn);
          const cos = Math.cos(maxTurn);
          hx = cx * cos - cy * sin;
          hy = cx * sin + cy * cos;
        }
      }
      // 아직 어긋난 만큼 감속: (1 + cos) / 2 → 같은 방향 1, 직각 0.5, 정반대 0
      target = (want * (1 + hx * wx + hy * wy)) / 2;
    }
    const dv = accel * dt;
    const v = target > cur ? Math.min(target, cur + dv) : Math.max(target, cur - dv);
    m.vx = hx * v;
    m.vy = hy * v;
    u.x += m.vx * dt;
    u.y += m.vy * dt;
    if (u.state !== 'orbit') this.keepOut(u, m);
    u.x = Math.min(this.width, Math.max(0, u.x));
    u.y = Math.min(this.height, Math.max(0, u.y));

    if (u.state === 'move' && !via) {
      const ex = u.tx - u.x, ey = u.ty - u.y;
      if (ex * ex + ey * ey <= ARRIVE_EPS * ARRIVE_EPS) {
        // 여기선 이미 6px/s 남짓(ARRIVE_GAIN × ARRIVE_EPS)이라 멈춰 세워도 튀지 않는다. 남겨 두면 슬롯을 0.3px 지나쳤다 돌아온다
        u.x = u.tx;
        u.y = u.ty;
        m.vx = 0;
        m.vy = 0;
        this.arrive(u);
      }
    }
  }

  /**
   * 무리의 보폭(최고 속도 대비). 가장 멀리 남은 병력이 도착하기 arriveWindow 초 전보다 일찍 닿을 병력만
   * 남은 거리 비율로 늦춘다: 그 비율로 가면 무리가 출발 모양에서 슬롯 모양으로 고르게 바뀌며 함께 도착한다.
   * 이미 뭉쳐 가는 무리(남은 거리 차가 여유 안)는 다 같이 최고 속도라, 자주 다시 내리는 추격 명령에도 굼뜨지 않다.
   * 가장 긴 남은 거리는 직전 틱에 잰 것이라 그 사이 그 병력이 간 거리(최고 속도 1틱)만큼 빼서 쓴다.
   */
  private pace(g: MoveGroup | null, remaining: number): number {
    if (!g) return 1;
    if (g.tick !== this.tick) {
      if (g.next > 0) g.lead = g.next;
      g.next = 0;
      g.tick = this.tick;
    }
    if (remaining > g.next) g.next = remaining;
    const { speed } = CONFIG.unit;
    const { arriveWindow, minPace } = CONFIG.formation;
    const due = g.lead - speed / CONFIG.tickRate - speed * arriveWindow;
    if (remaining >= due) return 1;
    return Math.max(minPace, remaining / due);
  }

  /**
   * 의도하지 않은 강하 막기: 이번 틱에 새로 들어선 남의 행성 대기권이 목적지를 품고 있지 않으면 경계 밖으로 되돌리고
   * 안쪽으로 향하던 속도를 지운다 (경계를 따라 미끄러진다). 우회(detour)가 경로를 미리 돌리고, 이것은 선회 반경 때문에
   * 우회 지점의 모서리를 안쪽으로 깎는 경우까지 막는다. 돌파 · 대기권 위에 그은 선은 목적지가 안쪽이라 그대로 들어간다.
   */
  private keepOut(u: Unit, m: Motion): void {
    for (const p of this.planets) {
      if (p.owner === u.faction || p.id === u.inPlanet) continue;
      const ra = p.atmosphereRadius;
      const dx = u.x - p.x, dy = u.y - p.y;
      const d2 = dx * dx + dy * dy;
      if (d2 > ra * ra) continue;
      const tx = u.tx - p.x, ty = u.ty - p.y;
      if (tx * tx + ty * ty <= ra * ra) continue;
      const d = Math.sqrt(d2);
      if (d < 1e-9) continue;
      const nx = dx / d, ny = dy / d;
      u.x = p.x + nx * (ra + 0.01);
      u.y = p.y + ny * (ra + 0.01);
      const vn = m.vx * nx + m.vy * ny;
      if (vn < 0) {
        m.vx -= vn * nx;
        m.vy -= vn * ny;
      }
    }
  }

  /**
   * 목적지가 그 안쪽이 아니라면 적 행성 대기권을 가로지르지 않고 접선 방향으로 돌아간다.
   * (이동/포위 명령이 의도치 않게 강하가 되는 것을 막는다. 돌파는 목적지가 대기권 안이라 그대로 직진)
   */
  private detour(u: Unit): { x: number; y: number } | null {
    let best: Planet | null = null;
    let bestT = Infinity;
    // 빠른 배제: 길(선분)의 가장 가까운 점은 선분의 경계 상자 안에 있으므로, 행성 중심이 상자에서 (ra + 1) 넘게
    // 떨어져 있으면 아래 판정(가장 가까운 점까지 < clear ≤ ra)을 통과할 수 없다. 1px 은 반올림 여유.
    // 좌표가 NaN 이면 비교가 모두 거짓이라 배제하지 않고 원래 판정으로 넘어간다
    const bx0 = Math.min(u.x, u.tx), bx1 = Math.max(u.x, u.tx);
    const by0 = Math.min(u.y, u.ty), by1 = Math.max(u.y, u.ty);
    for (const p of this.planets) {
      if (p.owner === u.faction) continue;
      const atm = p.atmosphereRadius;
      const ra = atm + 3;
      const reach = ra + 1;
      if (p.x < bx0 - reach || p.x > bx1 + reach || p.y < by0 - reach || p.y > by1 + reach) continue;
      const ux = u.x - p.x, uy = u.y - p.y;
      const tx = u.tx - p.x, ty = u.ty - p.y;
      const ru2 = ux * ux + uy * uy, rt2 = tx * tx + ty * ty;
      if (ru2 < atm * atm || rt2 < atm * atm) continue;
      // 보통은 경계에서 3px 여유를 두고 비켜 간다. 출발점이나 목적지가 이미 그 여유 띠 안이면(포위 슬롯이 경계 3px 밖)
      // 대기권 자체만 피한다: 띠 안의 짧은 길까지 돌게 하면 함선이 슬롯 앞에서 우회 지점만 쫓으며 맴돈다
      // 이때 여유는 두 끝점 반경보다 조금 안쪽으로 잡는다: 경계 0~0.5px 바깥 슬롯은 끝점 자체가 여유 안이라
      // 매 틱 우회가 걸려 영영 도착하지 못했다. 끝점이 아닌 길 중간이 대기권 쪽으로 파고들 때만 비켜 간다
      const clear = ru2 >= ra * ra && rt2 >= ra * ra ? ra : Math.min(atm + 0.5, Math.sqrt(Math.min(ru2, rt2)) - 1e-3);
      const sx = tx - ux, sy = ty - uy;
      const len2 = sx * sx + sy * sy || 1;
      const t = Math.max(0, Math.min(1, -(ux * sx + uy * sy) / len2));
      const cx = ux + sx * t, cy = uy + sy * t;
      if (cx * cx + cy * cy < clear * clear && t < bestT) {
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

  /**
   * 사격은 한 틱 안에서 동시에 일어난 것으로 본다.
   *  - 이번 틱을 살아서 시작한 병력은 모두 쏜다. 같은 틱에 먼저 처리된 적에게 맞아 죽을 병력도 이미 쏜 것으로 친다
   *    (예전에는 units 배열 앞쪽 = 먼저 만들어진 병력이 같은 틱의 맞대결에서 늘 먼저 쏘았다).
   *  - 맞은 피해는 바로 체력에 쌓아(이번 틱에 이미 예약된 피해) 뒤에 쏘는 병력이 그것까지 셈한다:
   *    이미 죽을 만큼 맞은 표적은 건너뛰고 그다음 가까운 적을 쏜다 (헛사격 없음). 시체 정리는 removeDead.
   */
  private combat(dt: number): void {
    const { unit, isolation } = CONFIG;
    const units = this.units;
    const n = units.length;
    if (this.armed.length < n) this.armed = new Uint8Array(Math.max(n, this.armed.length * 2, 256));
    const armed = this.armed;
    for (let i = 0; i < n; i++) {
      const u = units[i];
      if (u.isolated) u.hp -= isolation.hpLossPerSec * dt;
      armed[i] = u.hp > 0 ? 1 : 0;
    }
    for (let i = 0; i < n; i++) {
      if (!armed[i]) continue;
      const u = units[i];
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

      // 그 외: 사거리 안 가장 가까운 적 병력과 교전. hp > 0 = 이번 틱에 예약된 피해를 빼고도 살아 있는 적
      const target = this.grid.nearestEnemy(u.x, u.y, unit.range, u.faction);
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

  private removeDead(): boolean {
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
    const changed = this.units.length !== w;
    this.units.length = w;
    return changed;
  }

  // ───────────────────────────── 행성 ─────────────────────────────

  private resolveCaptures(): void {
    for (const p of this.planets) {
      if (p.defense > 0) continue;
      // 대기권 안 병력이 가장 많은 (소유자가 아닌) 진영이 차지한다.
      // 마지막 사격 진영이 전멸했다면 점령권을 주지 않는다.
      let to = p.owner;
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
        // 회복량은 크기별 기본 최대치 기준: 방어전 모성처럼 최대치만 키운 행성이 터무니없이 빨리 차오르지 않게
        const regen = CONFIG.planet[p.size].maxDefense * CONFIG.regenRate * dt;
        p.defense = Math.min(p.maxDefense, p.defense + regen);
      }
      if (p.owner === NEUTRAL || p.orbitCount[p.owner] >= p.capacity) continue;
      p.prodProgress += p.production * dt;
      while (p.prodProgress >= 1) {
        p.prodProgress -= 1;
        const u = this.spawnUnit(p.owner, p);
        p.orbitCount[p.owner]++;
        this.events.push({ type: 'spawn', x: u.x, y: u.y, faction: u.faction, planetId: p.id });
      }
    }
  }

  // ───────────────────────────── 집계 ─────────────────────────────

  private refreshCounts(): void {
    const planets = this.planets;
    for (const p of planets) {
      p.orbitCount.fill(0);
      p.presence.fill(0);
    }
    this.planetCount.fill(0);
    this.unitCount.fill(0);
    for (const p of planets) this.planetCount[p.owner]++;

    // 대기권 판정은 병력이 든 칸의 후보 행성만 본다 (후보는 번호 순이라 '가장 작은 번호의 행성' 이 그대로 뽑힌다)
    const look = this.planetLookup();
    const { start, list } = look;
    for (const u of this.units) {
      this.unitCount[u.faction]++;
      u.inPlanet = -1;
      const ux = u.x, uy = u.y;
      const c = look.cell(ux, uy);
      if (c >= 0) {
        for (let k = start[c], end = start[c + 1]; k < end; k++) {
          const p = planets[list[k]];
          const dx = p.x - ux, dy = p.y - uy;
          if (dx * dx + dy * dy <= p.atmosphereRadius * p.atmosphereRadius) {
            u.inPlanet = p.id;
            p.presence[u.faction]++;
            if (u.isolated && p.owner === u.faction) u.isolated = false;
            break;
          }
        }
      } else {
        // 좌표가 NaN 인 병력: 어느 대기권에도 들지 않는다 (예전 전수 검사와 같은 결과)
        for (const p of planets) {
          const dx = p.x - ux, dy = p.y - uy;
          if (dx * dx + dy * dy <= p.atmosphereRadius * p.atmosphereRadius) {
            u.inPlanet = p.id;
            p.presence[u.faction]++;
            if (u.isolated && p.owner === u.faction) u.isolated = false;
            break;
          }
        }
      }
      if (u.state === 'orbit') planets[u.planet].orbitCount[u.faction]++;
      // 행성을 모두 잃은 진영의 병력은 전원 고립.
      if (this.planetCount[u.faction] === 0 && !this.factions[u.faction].invader) u.isolated = true;
    }
  }

  /** 행성 배치(위치 · 대기권 반경 · 수)가 바뀌었을 때만 다시 만든다 */
  private planetLookup(): PlanetLookup {
    const look = this.lookup;
    if (look && look.matches(this.planets)) return look;
    return (this.lookup = new PlanetLookup(this.width, this.height, this.planets));
  }

  private updateFactions(): void {
    let aliveCount = 0;
    let last: FactionId = NEUTRAL;
    for (const f of this.factions) {
      if (f.id === NEUTRAL || !f.alive) continue;
      // 침공군은 행성도 병력도 없는 상태로 시작하므로 자동 탈락시키지 않는다 (winRule 이 판정)
      if (!f.invader && this.planetCount[f.id] === 0 && this.unitCount[f.id] === 0) {
        f.alive = false;
        this.events.push({ type: 'eliminated', faction: f.id });
        continue;
      }
      aliveCount++;
      last = f.id;
    }
    if (this.winRule) this.winner = this.winRule(this);
    else if (aliveCount <= 1) this.winner = last;
  }
}

function newMotion(u: Unit): Motion {
  return { vx: 0, vy: 0, group: null, gx: u.x, gy: u.y, gvx: 0, gvy: 0 };
}

/** 남은 거리 d 에서 지나치지 않고 멈출 수 있는 최고 속도 (가속 한계 안의 감속 곡선, 마지막 몇 px 는 거리에 비례) */
function arriveSpeed(d: number): number {
  const { speed, accel } = CONFIG.unit;
  return Math.min(speed, Math.sqrt(2 * accel * ARRIVE_BRAKE * d), ARRIVE_GAIN * d);
}

/**
 * 겹침 풀기용 촘촘한 격자. 칸 크기 ≥ 겹침 반경이라 주변 3×3 칸만 보면 된다.
 * 칸마다 연결 리스트(head → next)로 담고 쓴 칸만 되돌려 놓아서, 틱마다 드는 비용이 칸 수가 아니라 병력 수에 비례한다
 * (맵 전체 칸을 비우고 훑던 계수 정렬판은 1440기 행군에서 틱 시간의 28% 를 썼다). 쌍 검사에 쓰는 값은 typed array 에 모아 둔다.
 * 리스트는 큰 번호부터 이어져 있어 i < j 인 쌍만 훑고 멈출 수 있고, 순서가 units 배열로 정해져 결정론적이다.
 * 멈춘 병력(위치 고수 · 궤도)만 넣는다: 이동 중인 병력은 겹침 풀기 대상이 아니다.
 */
class PackGrid {
  /** units[i] 의 자리를 밀어낼 방향 · 세기의 합 (push 가 채운다) */
  pushX = new Float64Array(0);
  pushY = new Float64Array(0);
  private readonly cols: number;
  private readonly rows: number;
  private readonly size: number;
  /** 칸마다 마지막(가장 큰 번호)으로 넣은 항목, 비었으면 -1 */
  private readonly head: Int32Array;
  /** 같은 칸의 다음(더 작은 번호) 항목 */
  private next = new Int32Array(0);
  /** units[i] 가 든 칸 (-1 = 넣지 않음) */
  private cell = new Int32Array(0);
  /** 서로 밀어낼 수 있는 사이면 같은 값: 같은 진영 · 같은 상태 (궤도는 같은 행성까지) */
  private kind = new Int32Array(0);
  private id = new Int32Array(0);
  private gx = new Float64Array(0);
  private gy = new Float64Array(0);
  private n = 0;

  constructor(width: number, height: number, size: number) {
    this.size = size;
    this.cols = Math.max(1, Math.ceil(width / size));
    this.rows = Math.max(1, Math.ceil(height / size));
    this.head = new Int32Array(this.cols * this.rows).fill(-1);
  }

  build(units: readonly Unit[], mo: readonly Motion[]): void {
    const { head, cols, rows, size } = this;
    // 지난 틱에 쓴 칸만 비운다
    for (let i = 0; i < this.n; i++) if (this.cell[i] >= 0) head[this.cell[i]] = -1;
    const n = units.length;
    if (this.cell.length < n) {
      const cap = Math.max(n, this.cell.length * 2, 256);
      this.next = new Int32Array(cap);
      this.cell = new Int32Array(cap);
      this.kind = new Int32Array(cap);
      this.id = new Int32Array(cap);
      this.gx = new Float64Array(cap);
      this.gy = new Float64Array(cap);
      this.pushX = new Float64Array(cap);
      this.pushY = new Float64Array(cap);
    }
    const { next, cell } = this;
    for (let i = 0; i < n; i++) {
      const u = units[i];
      if (u.state === 'move') {
        cell[i] = -1;
        continue;
      }
      const m = mo[i];
      const cx = Math.min(cols - 1, Math.max(0, Math.floor(m.gx / size)));
      const cy = Math.min(rows - 1, Math.max(0, Math.floor(m.gy / size)));
      const c = cy * cols + cx;
      cell[i] = c;
      next[i] = head[c];
      head[c] = i;
      // 위치 고수 = 진영만, 궤도 = 진영 + 행성(1 부터) 으로 구분
      this.kind[i] = (u.faction << 16) | (u.state === 'orbit' ? u.planet + 1 : 0);
      this.id[i] = u.id;
      this.gx[i] = m.gx;
      this.gy[i] = m.gy;
    }
    this.n = n;
  }

  /** 반경 R 안으로 겹친 같은 무리끼리의 밀어낼 양을 pushX/Y 에 모은다. 겹친 쌍이 하나도 없으면 false */
  push(R: number): boolean {
    const { cols, rows, head, next, cell, kind, gx, gy, pushX, pushY } = this;
    pushX.fill(0, 0, this.n);
    pushY.fill(0, 0, this.n);
    let any = false;
    for (let i = 0; i < this.n; i++) {
      const c = cell[i];
      if (c < 0) continue;
      const cx = c % cols, cy = (c - cx) / cols;
      const gx0 = Math.max(0, cx - 1), gx1 = Math.min(cols - 1, cx + 1);
      const gy0 = Math.max(0, cy - 1), gy1 = Math.min(rows - 1, cy + 1);
      for (let ry = gy0; ry <= gy1; ry++) {
        for (let rx = gx0; rx <= gx1; rx++) {
          // 큰 번호부터 이어져 있으니 i 이하가 나오면 이 칸은 끝
          for (let j = head[ry * cols + rx]; j > i; j = next[j]) {
            if (kind[j] !== kind[i]) continue;
            let dx = gx[i] - gx[j], dy = gy[i] - gy[j];
            const d2 = dx * dx + dy * dy;
            if (d2 >= R * R) continue;
            const d = Math.sqrt(d2);
            if (d < 1e-6) {
              // 정확히 겹친 쌍: id 로 정한 방향으로 갈라선다 (결정론)
              const ang = ((this.id[i] * 0.618034 + this.id[j] * 0.381966) % 1) * Math.PI * 2;
              dx = Math.cos(ang);
              dy = Math.sin(ang);
            } else {
              dx /= d;
              dy /= d;
            }
            // 많이 겹칠수록 세게 (완전히 겹치면 1)
            const k = (R - d) / R;
            pushX[i] += dx * k;
            pushY[i] += dy * k;
            pushX[j] -= dx * k;
            pushY[j] -= dy * k;
            any = true;
          }
        }
      }
    }
    return any;
  }
}

/**
 * 대기권 판정용 거친 격자: 칸마다 그 칸(경계 칸은 맵 밖까지 늘린 영역)에 대기권이 조금이라도 걸칠 수 있는 행성 번호를
 * 작은 번호부터 담는다 (CSR: start[c] ~ start[c+1]). 병력마다 모든 행성을 훑던 O(병력 × 행성) 판정을 칸의 후보 몇 개로 줄인다.
 * 판정식 자체는 그대로이고 후보가 번호 순이라, 첫 번째로 걸리는 행성은 전수 검사와 같다.
 * 걸칠 수 있는지는 여유 MARGIN 을 두고 넉넉하게 본다 (칸 경계의 반올림 · 판정식의 반올림을 덮는다).
 */
class PlanetLookup {
  private static readonly MARGIN = 2;
  readonly start: Int32Array;
  readonly list: Int32Array;
  private readonly cols: number;
  private readonly rows: number;
  private readonly size: number;
  /** 만들 때의 행성 배치 (x, y, atmosphereRadius) */
  private readonly sig: Float64Array;

  constructor(width: number, height: number, planets: readonly Planet[]) {
    const size = 64;
    this.size = size;
    this.cols = Math.max(1, Math.ceil(width / size));
    this.rows = Math.max(1, Math.ceil(height / size));
    const { cols, rows } = this;
    this.sig = new Float64Array(planets.length * 3);
    planets.forEach((p, i) => {
      this.sig[i * 3] = p.x;
      this.sig[i * 3 + 1] = p.y;
      this.sig[i * 3 + 2] = p.atmosphereRadius;
    });
    const cells: number[][] = Array.from({ length: cols * rows }, () => []);
    planets.forEach((p, i) => {
      const r = p.atmosphereRadius + PlanetLookup.MARGIN;
      for (let cy = 0; cy < rows; cy++) {
        const y0 = cy === 0 ? -Infinity : cy * size;
        const y1 = cy === rows - 1 ? Infinity : (cy + 1) * size;
        const ny = Math.max(y0, Math.min(y1, p.y));
        const ddy = ny - p.y;
        for (let cx = 0; cx < cols; cx++) {
          const x0 = cx === 0 ? -Infinity : cx * size;
          const x1 = cx === cols - 1 ? Infinity : (cx + 1) * size;
          const nx = Math.max(x0, Math.min(x1, p.x));
          const ddx = nx - p.x;
          // 판정식이 비교하는 값이 유한하지 않은 행성(좌표 · 반경이 NaN 등)은 어느 칸에든 넣어 전수 검사와 같게 둔다
          if (!(ddx * ddx + ddy * ddy <= r * r) && Number.isFinite(r) && Number.isFinite(p.x) && Number.isFinite(p.y)) continue;
          cells[cy * cols + cx].push(i);
        }
      }
    });
    this.start = new Int32Array(cols * rows + 1);
    let total = 0;
    for (let c = 0; c < cells.length; c++) {
      this.start[c] = total;
      total += cells[c].length;
    }
    this.start[cells.length] = total;
    this.list = new Int32Array(total);
    let k = 0;
    for (const c of cells) for (const i of c) this.list[k++] = i;
  }

  /** (x, y) 가 드는 칸. 좌표가 NaN 이면 -1 */
  cell(x: number, y: number): number {
    const cx = Math.min(this.cols - 1, Math.max(0, Math.floor(x / this.size)));
    const cy = Math.min(this.rows - 1, Math.max(0, Math.floor(y / this.size)));
    const c = cy * this.cols + cx;
    return c >= 0 ? c : -1;
  }

  matches(planets: readonly Planet[]): boolean {
    const sig = this.sig;
    if (sig.length !== planets.length * 3) return false;
    for (let i = 0; i < planets.length; i++) {
      const p = planets[i];
      if (sig[i * 3] !== p.x || sig[i * 3 + 1] !== p.y || sig[i * 3 + 2] !== p.atmosphereRadius) return false;
    }
    return true;
  }
}
