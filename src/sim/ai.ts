import { AI_PROFILES, AI_REINFORCE_RADIUS, CONFIG, type AIProfile, type Difficulty } from '../config';
import { Rng } from './rng';
import { NEUTRAL, type FactionId, type Order, type Planet, type Unit } from './types';
import type { World } from './world';

/**
 * 상대가 둘 이상이면 행성이 가장 적은 상대의 행성 가치에 곱하는 배율.
 * 고르게 강한 진영 셋 이상이 서로 행성을 주고받기만 하면 판이 끝나지 않으므로 약한 쪽부터 정리한다 (1:1 에선 영향 없음)
 */
const WEAKEST_RIVAL_BONUS = 3;

// ───────────────────────────── 전투 추정 ─────────────────────────────

export type Tactic = 'dive' | 'siege';

/** 수비측 증원: 지금부터 eta 초 뒤에 count 기가 목표 행성 궤도에 합류한다 */
export interface Reinforcement {
  count: number;
  eta: number;
}

/** 행성 하나를 두고 벌이는 공방의 입력. 수는 모두 '기' 단위, 시간은 초 */
export interface BattleInput {
  attackers: number;
  /** 목표 대기권 안의 수비 병력 (궤도 수비대) */
  defenders: number;
  radius: number;
  defense: number;
  maxDefense: number;
  /** 공격받지 않을 때 초당 방어도 회복 */
  regen: number;
  /** 수비측 초당 생산 (중립은 0) */
  production: number;
  /** 궤도 정원: 수비대가 이만큼이면 생산이 멈춘다 */
  capacity: number;
  /** 공격 병력이 대기권에 닿기까지(초). 그동안 수비측은 생산 · 회복한다 */
  travel: number;
  reinforcements?: readonly Reinforcement[];
  /** 이미 붙어 싸우는 중: 들어가며 주고받는 접근 교전과 포위 고리를 펼치는 시간을 건너뛴다 (진행 중인 작전 재평가용) */
  engaged?: boolean;
}

export interface BattleEstimate {
  tactic: Tactic;
  success: boolean;
  /** 지금부터 점령까지(초). 실패면 전멸하거나 시간이 다 된 시각 */
  time: number;
  /** 공격측 예상 손실 (실패면 전원) */
  losses: number;
  survivors: number;
  /** 끝났을 때 남은 수비대 */
  defendersLeft: number;
}

/**
 * 전투 추정 모델 계수. 실제 시뮬레이션 3160 판(크기 3 × 중립/적 × 공격 6~130 × 수비 0~70 × 방어도 100/40% × 돌파/포위,
 * 거리 140 · 240)에 맞춰 좌표 하강으로 고른 값: 점령 성패 97.5%, 전술(돌파/포위/대기) 85.5%, 실측 비용이 3 이상 갈리는 판은
 * 91.9% 일치, 손실 오차 평균 2.1기 · 시간 오차 평균 1.1초. 다시 재려면 tests/balance.harness.test.ts 의 estimator 묶음
 */
export const BATTLE_MODEL = {
  /** 적분 간격(초) */
  dt: 0.25,
  /** 강하 단계 상한(초): 이 안에 방어도를 못 깎으면 실패로 본다 */
  diveLimit: 75,
  /**
   * 돌파: 강하 병력을 사거리에 둔 수비대 비율 = base + defenders·G/C (C = 돌파 고리 정원).
   * 수비대는 강하 병력과 엇갈려 돌며 스칠 때만 쏘므로 1 보다 한참 작고, 수비대가 촘촘할수록 커진다
   */
  diveBase: 0.22,
  diveDefenders: 0.6,
  /**
   * 접근 교전: 대기권 밖 사격 띠(수비대 궤도 + 사거리)를 지나며 주고받는 피해. x = A·G/(A+G) 일 때
   * 수비대 −approachKill·x, 공격측 −approachLoss·x (아직 강하 전이라 공격측도 병력을 쏜다)
   */
  approachKill: 0.25,
  approachLoss: 0.1,
  /**
   * 포위: 고리를 a 만큼(1열 정원 대비) 덮으면 수비대 중 exposure·a^arcPow 가 사거리 안에 든다.
   * 사거리 안의 수비대 하나는 초당 한 발을 쏘고 focus 발을 맞는다(그 이상 몰리면 남는 사수는 논다). 1열에 못 선 병력은 ring2 만큼만 거든다.
   * 맞춰 보니 arcPow 가 0 에 가깝다: 수비대가 궤도를 돌며 결국 고리 밑을 지나므로, 얼마나 덮느냐보다 몇 발이 몰리느냐가 속도를 정한다
   */
  siegeExposure: 1,
  siegeArcPow: 0.15,
  siegeFocus: 2,
  siegeRing2: 0.15,
  /** 포위 도착 때 뭉친 채 수비대와 스치며 주고받는 피해 (접근 교전과 같은 꼴) */
  siegeContactKill: 0.25,
  siegeContactLoss: 0.1,
  /** 포위 고리가 다 서기까지 걸리는 시간 배율 (가장 먼 슬롯까지 걷는 시간 대비) */
  siegeSettle: 0.28,
  /** 포위 → 돌파 전환: 수비대가 max(2, 공격측 × siegeSwitch) 이하가 되거나 siegeLimit 초가 지나면 */
  siegeSwitch: 0.12,
  siegeLimit: 30,
} as const;

/**
 * 공방 결과를 빠르게 추정한다 (순수 함수, 0.25초 간격 적분).
 * - 이동: 그동안 수비측은 생산하고 방어도를 회복한다. 증원은 eta 에 수비대로 합류한다.
 * - 포위(siege): 대기권 밖 고리에서 서로 쏘는 란체스터 제곱 법칙. 고리 1열만 온전히 쏘고, 수비대가 성기면 빈손이 는다.
 * - 돌파(dive): 공격측은 행성만 쏜다 → 방어도 피해 = 0.6 × A × A/(A+G) (방어막 = 수비대 비율),
 *   수비대는 엇갈려 지나가는 강하 병력을 쏜다 (사거리 안 비율은 BATTLE_MODEL.dive*).
 * - 점령 뒤: 고립된 옛 수비대가 40% 방어도를 되칠 수 있으면 실패로 본다.
 */
export function estimateBattle(inp: BattleInput, tactic: Tactic): BattleEstimate {
  const M = BATTLE_MODEL;
  const { dt } = M;
  const { hp, planetDamageMult, speed } = CONFIG.unit;
  const r = inp.radius;
  let A = inp.attackers;
  let G = inp.defenders;
  let D = inp.defense;
  const reinf = inp.reinforcements ? [...inp.reinforcements].sort((a, b) => a.eta - b.eta) : [];
  let ri = 0;
  let t = 0;
  const fail = (): BattleEstimate => ({ tactic, success: false, time: t, losses: inp.attackers, survivors: 0, defendersLeft: G });
  /** dur 초 경과: 생산(정원까지) · 회복(공격받지 않을 때만) · 도착한 증원 합류 */
  const pass = (dur: number, assaulted: boolean) => {
    t += dur;
    if (inp.production > 0 && G < inp.capacity) G = Math.min(inp.capacity, G + inp.production * dur);
    if (!assaulted) D = Math.min(inp.maxDefense, D + inp.regen * dur);
    while (ri < reinf.length && reinf[ri].eta <= t) G += reinf[ri++].count;
  };
  pass(Math.max(0, inp.travel), false);
  if (A <= 0.5) return fail();

  if (tactic === 'siege') {
    const ringR = r + CONFIG.surroundAltitude;
    const ring1 = Math.floor((2 * Math.PI * ringR) / CONFIG.formation.lineSpacing);
    // 진입 방향에서 좌우로 펼쳐지는 데 걸리는 시간: 1열이 다 서려면 가장 먼 슬롯까지 (최대 반 바퀴)
    const spread = inp.engaged ? 0 : (M.siegeSettle * Math.min(Math.PI * ringR, (Math.min(A, ring1) * CONFIG.formation.lineSpacing) / 2)) / speed;
    if (!inp.engaged) {
      const x = (A * G) / Math.max(1, A + G);
      G -= Math.min(G * 0.5, M.siegeContactKill * x);
      A -= Math.min(A, M.siegeContactLoss * x);
    }
    const start = t;
    while (t - start < M.siegeLimit && A > 0.5) {
      const settled = Math.min(1, (t - start + dt) / Math.max(dt, spread));
      const arc = (Math.min(A, ring1) * settled) / ring1;
      const exposed = G * M.siegeExposure * Math.pow(arc, M.siegeArcPow);
      const front = Math.min(A, ring1) + M.siegeRing2 * Math.max(0, A - ring1);
      A -= (exposed / hp) * dt;
      G = Math.max(0, G - (Math.min(front, M.siegeFocus * exposed) / hp) * dt);
      pass(dt, false);
      if (t - start >= spread && G <= Math.max(2, A * M.siegeSwitch)) break;
    }
    if (A <= 0.5) return fail();
  }

  if (!inp.engaged) {
    const x = (A * G) / Math.max(1, A + G);
    G -= Math.min(G * 0.5, M.approachKill * x);
    A -= Math.min(A, M.approachLoss * x);
  }

  const [lo, hi] = CONFIG.orbitBand;
  const ringCap = ((2 * Math.PI) / CONFIG.formation.clusterSpacing) * (3 * r + (lo + 2) + (lo + hi) / 2 + (hi - 2));
  const diveStart = t;
  while (D > 0 && A > 0.5 && t - diveStart < M.diveLimit) {
    // 강하 병력은 병력을 쏘지 않으니 수비대는 줄지 않고 공격측은 늘지 않는다 → 피해 속도는 떨어지기만 한다.
    // 지금 속도로도 남은 시간 안에 못 깎으면 끝까지 돌려 볼 것 없이 실패 (판단 시간의 대부분을 아낀다)
    const rate = planetDamageMult * A * (A / (A + G));
    if (rate * (M.diveLimit - (t - diveStart)) < D) return fail();
    const exposed = Math.min(1, M.diveBase + (M.diveDefenders * G) / ringCap);
    D -= rate * dt;
    A -= ((G * exposed) / hp) * dt;
    pass(dt, true);
  }
  if (D > 0 || A <= 0.5) return fail();

  // 점령 직후 방어도는 40%. 고립된 옛 수비대(공격력 ½)가 생존 병력에게 정리되기 전에 그만큼 깎으면 되찾긴다
  if (G > 0.5) {
    let d = inp.maxDefense * CONFIG.captureDefense;
    let g = G;
    for (let s = 0; s < 1 / (CONFIG.isolation.hpLossPerSec / hp) && g > 0.5; s += dt) {
      d -= planetDamageMult * CONFIG.isolation.damageMult * g * (g / (g + A)) * dt;
      g -= (A / hp) * dt;
      if (d <= 0) return fail();
    }
  }
  return { tactic, success: true, time: t, losses: inp.attackers - A, survivors: A, defendersLeft: G };
}

export interface TacticChoice {
  /** wait = 어느 전술로도 점령하지 못한다 (병력을 더 모으거나 다른 곳을 친다) */
  tactic: Tactic | 'wait';
  estimate: BattleEstimate | null;
}

/**
 * 돌파 / 포위→돌파 / 대기 중 고른다. 비용 = 예상 손실 + timeWeight × 걸리는 시간 (기 / 초):
 * 고정 문턱(수비대 8 이상이면 포위 등) 대신, 같은 병력으로 무엇이 더 싸게 먹히는지로 정한다
 */
export function chooseTactic(inp: BattleInput, allowSiege = true, timeWeight = 0.3): TacticChoice {
  const dive = estimateBattle(inp, 'dive');
  const siege = allowSiege ? estimateBattle(inp, 'siege') : null;
  const cost = (e: BattleEstimate | null) => (e?.success ? e.losses + timeWeight * e.time : Infinity);
  const cd = cost(dive), cs = cost(siege);
  if (cd === Infinity && cs === Infinity) return { tactic: 'wait', estimate: null };
  return cd <= cs ? { tactic: 'dive', estimate: dive } : { tactic: 'siege', estimate: siege };
}

/** 실제 행성 p 를 attackers 기로 칠 때의 추정 입력 (수비측 = p 의 현재 주인) */
export function planetBattle(
  p: Planet,
  attackers: number,
  defenders: number,
  travel: number,
  reinforcements?: readonly Reinforcement[],
): BattleInput {
  return {
    attackers,
    defenders,
    radius: p.radius,
    defense: p.defense,
    maxDefense: p.maxDefense,
    // 회복량은 크기별 기본 최대치 기준 (World.updatePlanets 와 같게)
    regen: CONFIG.planet[p.size].maxDefense * CONFIG.regenRate,
    production: p.owner === NEUTRAL ? 0 : p.production,
    capacity: p.capacity,
    travel,
    reinforcements,
  };
}

// ───────────────────────────── 군대 추적 ─────────────────────────────

/** 가까이 붙어 움직이는 적 병력 무리 */
export interface Army {
  faction: FactionId;
  count: number;
  /** 무게중심 */
  x: number;
  y: number;
  /** 평균 속도 (px/초): 직전 틱 위치와의 차이로 본다 (목적지를 몰래 읽지 않는다) */
  vx: number;
  vy: number;
  ids: number[];
}

/** 무리를 묶는 격자 칸 크기: 사거리(24)의 두 배 남짓이면 한 대형이 한 무리로 묶인다 */
const ARMY_CELL = 64;

/**
 * viewer 가 아닌 진영(중립 제외)의 '나와 있는' 병력을 가까운 것끼리 묶는다.
 * 자기 행성 궤도를 지키는 수비대는 빼고 이동 · 위치 고수 · 남의 행성 공격 중인 병력만 센다.
 * 격자 칸에 담은 뒤 이웃 칸을 이어 붙이므로 1500 기에서도 한 번 훑기로 끝난다
 */
export function trackArmies(world: World, viewer: FactionId): Army[] {
  const cols = Math.ceil(world.width / ARMY_CELL) + 2;
  const rows = Math.ceil(world.height / ARMY_CELL) + 2;
  const cells = new Map<number, Unit[]>();
  for (const u of world.units) {
    if (u.faction === viewer || u.faction === NEUTRAL) continue;
    if (u.state === 'orbit' && world.planets[u.planet].owner === u.faction) continue;
    // 테두리 한 칸씩 비워 두어 이웃 칸 계산이 줄을 넘어 이어지지 않게 한다
    const cx = Math.min(cols - 2, Math.max(1, Math.floor(u.x / ARMY_CELL) + 1));
    const cy = Math.min(rows - 2, Math.max(1, Math.floor(u.y / ARMY_CELL) + 1));
    const key = u.faction * cols * rows + cy * cols + cx;
    const cell = cells.get(key);
    if (cell) cell.push(u);
    else cells.set(key, [u]);
  }
  const armies: Army[] = [];
  const seen = new Set<number>();
  const around = [-cols - 1, -cols, -cols + 1, -1, 1, cols - 1, cols, cols + 1];
  for (const start of cells.keys()) {
    if (seen.has(start)) continue;
    seen.add(start);
    const stack = [start];
    const members: Unit[] = [];
    while (stack.length > 0) {
      const key = stack.pop()!;
      members.push(...cells.get(key)!);
      for (const o of around) {
        const k = key + o;
        if (!seen.has(k) && cells.has(k)) {
          seen.add(k);
          stack.push(k);
        }
      }
    }
    let x = 0, y = 0, vx = 0, vy = 0;
    for (const u of members) {
      x += u.x;
      y += u.y;
      vx += u.x - u.px;
      vy += u.y - u.py;
    }
    const n = members.length;
    armies.push({
      faction: members[0].faction,
      count: n,
      x: x / n,
      y: y / n,
      vx: (vx / n) * CONFIG.tickRate,
      vy: (vy / n) * CONFIG.tickRate,
      ids: members.map((u) => u.id),
    });
  }
  return armies;
}

/** 이 거리(대기권 바깥) 안에 들어온 무리는 이미 붙은 위협으로 본다 */
const CONTACT_GAP = 60;
/** 이보다 느린 무리(px/초)는 방향을 읽지 않는다 (궤도를 도는 무리의 평균 속도는 0 에 가깝다) */
const MOVING_SPEED = 15;

/**
 * 무리가 planets 중 어디로 향하는지 진행 방향 · 속도로 내다본다.
 * 진행 방향 반직선이 대기권(+40)을 스치는 행성 중 가장 먼저 닿을 곳, 또는 이미 붙어 있는 곳. 지평 밖이면 null
 */
export function projectArmy(army: Army, planets: readonly Planet[], horizon: number): { planet: Planet; eta: number } | null {
  const speed = Math.hypot(army.vx, army.vy);
  let best: Planet | null = null;
  let bestEta = Infinity;
  for (const p of planets) {
    const dx = p.x - army.x, dy = p.y - army.y;
    const d = Math.hypot(dx, dy);
    const gap = d - p.atmosphereRadius;
    let eta: number;
    if (gap < CONTACT_GAP) {
      eta = 0;
    } else {
      if (speed < MOVING_SPEED) continue;
      const along = (dx * army.vx + dy * army.vy) / speed;
      if (along <= 0) continue;
      const side = Math.sqrt(Math.max(0, d * d - along * along));
      if (side > p.atmosphereRadius + 40) continue;
      eta = gap / CONFIG.unit.speed;
    }
    if (eta <= horizon && eta < bestEta) {
      bestEta = eta;
      best = p;
    }
  }
  return best ? { planet: best, eta: bestEta } : null;
}

// ───────────────────────────── AI ─────────────────────────────

interface Operation {
  /** attack = 행성 공략, feint = 본대 전 견제 포위, hunt = 우주 공간의 적 무리 사냥 */
  kind: 'attack' | 'feint' | 'hunt';
  /** 목표 행성 (hunt 는 −1) */
  target: number;
  units: Set<number>;
  /** stage = 대기권 밖에서 포위 교전 중, assault = 돌파 중 (hunt 는 무시) */
  phase: 'stage' | 'assault';
  startedAt: number;
  initial: number;
  /** 동시 도착: 아직 출발하지 않은 무리. at 이 되면 같은 명령으로 출발한다 */
  pending: { ids: number[]; at: number }[];
  /** hunt: 쫓는 적 병력 */
  prey: number[];
  /** feint ↔ 본대 */
  partner: Operation | null;
  /** 연속으로 '진다'고 추정한 판단 수 (한 번 흔들린 추정으로 물러나지 않게) */
  doubt: number;
  done: boolean;
}

/** 판단 한 번 동안 공유하는 놀고 있는 병력 */
interface Pool {
  /** 행성 id → 궤도에서 놀고 있는 아군 병력 */
  free: Map<number, Unit[]>;
  /** 행성 id → 남겨 둘 예비 병력 수 */
  reserve: Map<number, number>;
}

/** 모성 경비: 이 반경 안의 적 병력 × HOME_GUARD_SHARE 만큼 남긴다 (성향의 homeGuard 가 상한) */
const HOME_ALERT = 600;
const HOME_GUARD_SHARE = 0.5;
/** 상대가 공격을 알아채는 시점(우리가 닿기 몇 초 전), 알아챈 뒤 증원을 내보내기까지(초), 이웃 행성이 남겨 두는 수비대 비율 */
const ENEMY_NOTICE = 4;
const ENEMY_REACTION = 2;
const REINFORCE_KEEP = 0.4;
/** 공격 비용 = 예상 손실 + TIME_WEIGHT × 걸리는 시간(초) + UNIT_WEIGHT × 묶이는 병력 (단위: 기) */
const TIME_WEIGHT = 0.3;
const UNIT_WEIGHT = 0.15;
/** 공격 규모 후보: 최소 병력(안전 배율 포함)의 몇 배까지 견주어 볼지 */
const FORCE_STEPS = [1, 1.3, 1.7, 2.2, 3];
/** '기다렸다 보내기' 후보(초): 그동안 생산된 병력을 더해 지금 보내는 것과 비교한다 */
const WAIT_STEPS = [4, 8, 14];
/** 한 판단에 추정기로 자세히 따져 보는 공격 후보 수 */
const PLAN_CANDIDATES = 6;
/** 진행 중인 작전을 '지는 싸움'으로 볼 때 몇 번 연속으로 그렇게 추정돼야 물리는지 */
const DOUBT_LIMIT = 2;
/** 재평가 여유: 지금 병력이 이 배였어도 진다고 나와야 물린다 (출발 때의 추정을 한 번의 흔들림으로 뒤집지 않게) */
const RETREAT_SLACK = 1.25;
/** 작전 시간 제한(초): 이만큼 지나도 못 먹으면 귀환 */
const ASSAULT_TIMEOUT = 60;
/** 견제: 본대보다 먼저 도착하는 시간(초), 크기(본대 대비) · 하한 · 상한, 지속 시간 */
const FEINT_LEAD = 3;
const FEINT_SHARE = 0.25;
const FEINT_RANGE = 450;
const FEINT_DURATION = 25;
/** 사냥: 상대 무리의 이 배수 이상 모일 때만, 이 반경 안의 행성에서, 이 시간 안에 */
const HUNT_RATIO = 1.7;
const HUNT_RANGE = 380;
const HUNT_MAX = 30;
const HUNT_TIMEOUT = 18;
/** 우세: 병력이 가장 센 상대의 이 배를 넘으면 동시 작전을 이만큼 더 벌인다 */
const DOMINANT_RATIO = 2;
const DOMINANT_EXTRA_OPS = 2;
/** 반격: 이 수 이상 몰려왔다가 4분의 1 이하로 줄면 '막아 냈다'로 보고 그 진영 행성 가치를 올린다 */
const COUNTER_MIN = 8;
const COUNTER_WINDOW = 25;
const COUNTER_BONUS = 2;

/**
 * AI. 플레이어와 똑같이 Command 만으로 게임에 개입한다 (상대 병력의 목적지 등 숨은 정보는 읽지 않고 위치 · 움직임만 본다).
 * - 추정: 공격 전에 estimateBattle 로 돌파 / 포위 / 대기를 손실 · 시간으로 비교하고 필요한 최소 병력을 구한다.
 * - 방어: 다가오는 적 무리의 방향 · 속도로 도착을 내다보고, 막을 만큼만 미리 증원한다. 모성은 비우지 않는다.
 * - 기회: 막아 낸 직후 공격자 행성 반격, 우주에 떨어진 작은 무리 사냥, 증원이 멀리 있는 얇은 행성 우선.
 * - 협동(어려움): 여러 행성 병력의 도착 시각 맞추기, 본대 전에 이웃 행성 견제.
 * - 진행 중인 작전은 매 판단 다시 추정해 질 싸움이면 일찍 물린다.
 * 난이도는 AIProfile 의 반응 속도 · 추정 착시/잡음 · 켜는 행동으로 나뉜다.
 */
export class AIController {
  private ops: Operation[] = [];
  private nextThink: number;
  private readonly profile: AIProfile;
  /** 추정 잡음 전용 난수: world.rng 를 건드리지 않아 AI 판단이 전투 난수열을 바꾸지 않는다 (첫 판단 때 맵으로 시드) */
  private rng: Rng | null = null;
  /** 진영별 최근 위협 최고치 (반격 판단용) */
  private threatPeak = new Map<FactionId, { count: number; at: number; planets: number }>();
  /** 진영별 반격 가산이 끝나는 시각 */
  private counterUntil = new Map<FactionId, number>();

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

  private order(world: World, units: Iterable<number> | Unit[], order: Order): void {
    const unitIds: number[] = [];
    for (const u of units) unitIds.push(typeof u === 'number' ? u : u.id);
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

  /** 추정에 쓰는 '보이는' 수: 성향의 착시(bias)와 판단마다의 잡음 */
  private perceive(n: number): number {
    const { estimateBias, estimateNoise } = this.profile;
    let k = estimateBias;
    if (estimateNoise > 0 && this.rng) k *= 1 + estimateNoise * (this.rng.next() * 2 - 1);
    return n * k;
  }

  private think(world: World): void {
    const me = this.faction;
    if (!this.rng && this.profile.estimateNoise > 0) this.rng = new Rng(mapSeed(world, me));
    const assigned = new Set<number>();
    for (const op of this.ops) {
      for (const id of op.units) {
        if (world.getUnit(id)) assigned.add(id);
        else op.units.delete(id);
      }
    }
    const armies = trackArmies(world, me);
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
    const pool: Pool = { free: new Map(myPlanets.map((p) => [p.id, []])), reserve: new Map() };
    const stragglers: Unit[] = [];
    const isolatedAt = new Map<number, Unit[]>();
    /** 행성 id → 그리로 이동 중인 아군 (증원이 이미 오는 중인지) */
    const inbound = new Map<number, number>();
    for (const u of myUnits) {
      if (u.state === 'move' && u.planet >= 0) inbound.set(u.planet, (inbound.get(u.planet) ?? 0) + 1);
      if (assigned.has(u.id) || u.state === 'move') continue;
      if (u.isolated) {
        const list = isolatedAt.get(u.inPlanet) ?? [];
        list.push(u);
        isolatedAt.set(u.inPlanet, list);
      } else if (u.state === 'orbit' && world.planets[u.planet].owner === me) {
        pool.free.get(u.planet)!.push(u);
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

    const { reserveRatio, homeGuard } = this.profile;
    for (const p of myPlanets) {
      const base = Math.ceil(p.capacity * reserveRatio);
      // 모성 경비: 상대가 가까이(HOME_ALERT) 둔 병력에 비례해 남긴다 (상한 homeGuard).
      // 상대가 멀리 있는 초반엔 첫 확장을 늦추지 않고, 적이 다가올수록 모성을 비우지 않는다
      const guard = p.isHome ? Math.min(Math.ceil(p.capacity * homeGuard), Math.ceil(this.enemyNear(world, p, armies) * HOME_GUARD_SHARE)) : 0;
      pool.reserve.set(p.id, Math.max(base, guard));
    }

    this.defend(world, myPlanets, pool, armies, inbound);
    if (this.profile.snipes) this.hunt(world, myPlanets, pool, armies);
    this.attack(world, myPlanets, pool, armies);
  }

  /** p 에서 HOME_ALERT 안의 적 병력: 나와 있는 무리 + 적 행성 궤도 수비대 */
  private enemyNear(world: World, p: Planet, armies: Army[]): number {
    let n = 0;
    for (const a of armies) if (dist(a, p) < HOME_ALERT) n += a.count;
    for (const q of world.planets) {
      if (q.owner !== NEUTRAL && q.owner !== this.faction && dist(q, p) < HOME_ALERT) n += q.orbitCount[q.owner];
    }
    return n;
  }

  private spare(pool: Pool, p: Planet): number {
    return Math.max(0, pool.free.get(p.id)!.length - pool.reserve.get(p.id)!);
  }

  private take(pool: Pool, p: Planet, count: number): Unit[] {
    const list = pool.free.get(p.id)!;
    return list.splice(list.length - count, count);
  }

  // ───────────── 방어 ─────────────

  /**
   * 위협받는 행성에 증원을 보낸다.
   * projectThreats: 다가오는 무리를 방향 · 속도로 내다보고, 그 무리가 이 행성을 먹을 수 있는지 추정해
   *                 막을 만큼만 '도착 전에' 보낸다. 위협받는 행성의 병력은 다른 데 쓰지 않는다.
   * 아니면: 이미 붙은 적 × 1.3 이 궤도 병력보다 많을 때만 (반응이 늦다)
   */
  private defend(world: World, myPlanets: Planet[], pool: Pool, armies: Army[], inbound: Map<number, number>): void {
    const me = this.faction;
    const prof = this.profile;
    // 행성마다 다가오는 무리 (가장 먼저 닿을 행성 하나에만 센다). 내다보지 않는 성향은 이미 붙은 무리만 본다
    const incoming = new Map<number, { count: number; eta: number }>();
    const threatBy = new Map<FactionId, number>();
    for (const a of armies) {
      const hit = projectArmy(a, myPlanets, prof.projectThreats ? prof.threatHorizon : 0);
      if (!hit) continue;
      const cur = incoming.get(hit.planet.id) ?? { count: 0, eta: Infinity };
      cur.count += a.count;
      cur.eta = Math.min(cur.eta, hit.eta);
      incoming.set(hit.planet.id, cur);
      threatBy.set(a.faction, (threatBy.get(a.faction) ?? 0) + a.count);
    }
    if (prof.opportunism) this.watchCounter(world, myPlanets.length, threatBy);

    if (!prof.projectThreats) {
      // 예전 규칙: 이미 붙은 적 × 1.3 이 궤도 병력보다 많을 때만 이웃의 여유 병력을 부른다
      for (const p of myPlanets) {
        const threat = this.hostilesNear(world, p, 60, false);
        if (threat === 0) continue;
        let need = Math.ceil(this.perceive(threat) * 1.3 - p.orbitCount[me]);
        if (need <= 0) continue;
        for (const q of this.helpers(myPlanets, p, 750)) {
          if (need <= 0) break;
          const n = Math.min(this.spare(pool, q), need);
          if (n <= 0) continue;
          this.order(world, this.take(pool, q, n), { kind: 'planet', planetId: p.id, formation: 'cluster' });
          need -= n;
        }
      }
      return;
    }

    // 먼저 닿는 위협부터. 각 행성은 버티는 데 필요한 만큼을 예비로 묶고(공격 · 사냥에 안 쓴다), 모자라면 이웃에서 부른다
    const threats = [...incoming.entries()].map(([pid, th]) => ({ p: world.planets[pid], ...th })).sort((a, b) => a.eta - b.eta);
    const plans = threats.map(({ p, count, eta }) => {
      const enemy = this.perceive(count);
      const coming = inbound.get(p.id) ?? 0;
      const holds = (defenders: number) => {
        const inp = planetBattle(p, enemy, defenders, eta);
        return !estimateBattle(inp, 'dive').success && !estimateBattle(inp, 'siege').success;
      };
      const garrison = p.orbitCount[me];
      if (holds(garrison + coming)) {
        // 버틸 수 있다: 버티는 데 드는 최소 수비대만 남기고 나머지는 계속 쓸 수 있다
        const keep = lowestPassing(0, garrison, (k) => holds(k + coming));
        pool.reserve.set(p.id, Math.max(pool.reserve.get(p.id)!, keep + 2));
        return { p, need: 0, deadline: 0 };
      }
      pool.reserve.set(p.id, Number.MAX_SAFE_INTEGER);
      // 막는 데 필요한 최소 증원. 그래도 못 막을 만큼 크면 보낼 수 있는 만큼 보낸다
      const most = Math.ceil(enemy * 2) + 4;
      const need = holds(garrison + coming + most) ? lowestPassing(0, most, (x) => holds(garrison + coming + x)) : most;
      // 상대가 먹는 데 걸리는 시간 안에 닿는 행성에서만 (늦게 도착하는 증원은 각개 격파당한다)
      const assault = estimateBattle(planetBattle(p, enemy, garrison + coming, eta), 'dive');
      return { p, need, deadline: Math.max(eta, assault.time) + 2 };
    });
    for (const { p, need: total, deadline } of plans) {
      let need = total;
      for (const q of this.helpers(myPlanets, p, 900)) {
        if (need <= 0) break;
        if ((dist(q, p) - p.atmosphereRadius) / CONFIG.unit.speed > deadline) break;
        const n = Math.min(this.spare(pool, q), need);
        if (n <= 0) continue;
        this.order(world, this.take(pool, q, n), { kind: 'planet', planetId: p.id, formation: 'cluster' });
        need -= n;
      }
    }
  }

  /** p 를 도울 수 있는 (range 안의) 다른 아군 행성, 가까운 순 */
  private helpers(myPlanets: Planet[], p: Planet, range: number): Planet[] {
    return myPlanets.filter((q) => q !== p && dist(q, p) < range).sort((a, b) => dist(a, p) - dist(b, p));
  }

  /**
   * 반격 판단: 어느 진영이 COUNTER_MIN 이상 몰려왔다가, 행성을 잃지 않은 채 그 위협이 4분의 1 이하로 줄면
   * '막아 냈다'로 보고 COUNTER_WINDOW 초 동안 그 진영 행성의 가치를 올린다 (공격에 병력을 쏟아 수비가 얇다)
   */
  private watchCounter(world: World, planets: number, threatBy: Map<FactionId, number>): void {
    const now = world.time;
    for (const [f, peak] of this.threatPeak) {
      const cur = threatBy.get(f) ?? 0;
      if (cur <= peak.count * 0.25) {
        if (planets >= peak.planets && now - peak.at < 30) this.counterUntil.set(f, now + COUNTER_WINDOW);
        this.threatPeak.delete(f);
      } else if (now - peak.at > 30) {
        this.threatPeak.delete(f);
      }
    }
    for (const [f, cur] of threatBy) {
      const peak = this.threatPeak.get(f);
      if (cur >= COUNTER_MIN && (!peak || cur >= peak.count)) this.threatPeak.set(f, { count: cur, at: now, planets });
    }
  }

  // ───────────── 사냥 ─────────────

  /**
   * 우주 공간(어느 행성 대기권에서도 떨어진 곳)에 있는 작은 적 무리를, 근처 행성의 여유 병력이 HUNT_RATIO 배 이상이면 요격한다.
   * 우주에서는 양쪽 모두 쏘므로(란체스터 제곱) 1.7 배면 상대 수의 3분의 1 남짓만 잃고 전멸시킨다
   */
  private hunt(world: World, myPlanets: Planet[], pool: Pool, armies: Army[]): void {
    const hunted = new Set<number>();
    for (const op of this.ops) if (op.kind === 'hunt') for (const id of op.prey) hunted.add(id);
    for (const a of armies) {
      if (a.count > HUNT_MAX || hunted.has(a.ids[0])) continue;
      if (world.planets.some((p) => dist(p, a) < p.atmosphereRadius + 50)) continue;
      // 우리 행성으로 오는 무리는 방어(궤도 수비대가 강하 병력을 일방적으로 쏜다)에 맡긴다
      if (projectArmy(a, myPlanets, 8)) continue;
      const need = Math.ceil(a.count * HUNT_RATIO) + 2;
      const srcs = myPlanets.filter((p) => dist(p, a) < HUNT_RANGE && this.spare(pool, p) > 0).sort((p, q) => dist(p, a) - dist(q, a));
      if (srcs.reduce((s, p) => s + this.spare(pool, p), 0) < need) continue;
      const force: Unit[] = [];
      for (const s of srcs) {
        if (force.length >= need) break;
        force.push(...this.take(pool, s, Math.min(this.spare(pool, s), need - force.length)));
      }
      const aim = intercept(a, dist(srcs[0], a) / CONFIG.unit.speed);
      this.order(world, force, { kind: 'move', x: aim.x, y: aim.y, formation: 'cluster' });
      this.ops.push(this.newOp('hunt', -1, force, world.time, 'assault', a.ids));
      return; // 한 번에 하나: 여러 무리를 쫓다 본진이 비지 않게
    }
  }

  // ───────────── 공격 ─────────────

  private attack(world: World, myPlanets: Planet[], pool: Pool, armies: Army[]): void {
    const me = this.faction;
    const prof = this.profile;
    const rivals = world.factions.filter((f) => f.id !== NEUTRAL && f.id !== me && world.planetCount[f.id] > 0);
    // 우세를 굳힌다: 병력이 가장 센 상대의 두 배를 넘으면 작전을 더 벌인다 (한 곳씩 주고받다 판이 늘어지지 않게.
    // 이미 크게 이기고 있을 때만이라, 대등하게 버티는 상대에게는 난이도가 그대로다)
    const dominant = rivals.length > 0 && world.unitCount[me] >= DOMINANT_RATIO * Math.max(...rivals.map((f) => world.unitCount[f.id]));
    const maxOps = prof.maxOps + (dominant ? DOMINANT_EXTRA_OPS : 0);
    const launches = prof.launchesPerThink + (dominant ? 1 : 0);
    let active = this.ops.filter((o) => o.kind === 'attack').length;
    if (active >= maxOps) return;
    const sources = myPlanets.filter((p) => this.spare(pool, p) > 0);
    const total = sources.reduce((s, p) => s + this.spare(pool, p), 0);
    if (total < 6) return;

    const targeted = new Set(this.ops.filter((o) => o.kind !== 'hunt').map((o) => o.target));
    const weakest = rivals.length >= 2 ? rivals.reduce((a, b) => (world.planetCount[b.id] < world.planetCount[a.id] ? b : a)).id : -1;
    const travel = (s: Planet, t: Planet) => Math.max(0, dist(s, t) - t.atmosphereRadius) / CONFIG.unit.speed;

    const valueOf = (t: Planet) => {
      if (t.owner === NEUTRAL) return t.production * 10;
      const counter = (this.counterUntil.get(t.owner) ?? -Infinity) > world.time ? COUNTER_BONUS : 1;
      return (
        (t.production * 10 + 2 + (t.isHome ? 3 : 0)) *
        prof.enemyPressure *
        (t.owner === weakest ? WEAKEST_RIVAL_BONUS : 1) *
        counter
      );
    };
    // 1차: 가치 / 수비대 / 거리로 대충 줄 세워 상위 몇 곳만 추정기로 자세히 본다 (판단 시간을 유닛 · 행성 수와 무관하게)
    const rough = world.planets
      .filter((t) => t.owner !== me && !targeted.has(t.id))
      .map((t) => {
        const near = sources.filter((s) => dist(s, t) < 900).sort((a, b) => travel(a, t) - travel(b, t));
        const defenders = this.hostilesNear(world, t, 10, true);
        const score = near.length > 0 ? valueOf(t) / (defenders + 4) / (1 + dist(near[0], t) / 600) : 0;
        return { t, near, defenders, score };
      })
      .filter((c) => c.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, PLAN_CANDIDATES);

    interface Plan {
      t: Planet;
      near: Planet[];
      send: number;
      /** 추정기가 낸 최소 병력 (안전 배율 포함) */
      least: number;
      choice: TacticChoice;
      score: number;
      /** 생산을 몇 초 더 모아 보내는 편이 싼가 (실제로 보낼 차례가 된 계획만 따져 본다) */
      better: () => boolean;
    }
    const plans: Plan[] = [];
    for (const { t, near, defenders: seen } of rough) {
      const avail = near.reduce((s, p) => s + this.spare(pool, p), 0);
      if (avail < 4) continue;
      const defenders = this.perceive(seen);
      const reinf = t.owner !== NEUTRAL && prof.reinforceWeight > 0 ? this.reinforcementsFor(world, t, armies, travel(near[0], t)) : undefined;
      // n 기를 모으려면 몇 번째 행성까지 가야 하나 → 그 행성에서 오는 시간이 곧 도착 시간 (동시 도착 기준)
      const travelFor = (n: number) => {
        let acc = 0;
        for (const s of near) {
          acc += this.spare(pool, s);
          if (acc >= n) return travel(s, t);
        }
        return travel(near[near.length - 1], t);
      };
      // 시간의 값: 먹는 게 늦어질수록 그 행성의 생산을 (중립이면 내가, 적이면 상대에게) 내준다
      const timeWeight = TIME_WEIGHT + t.production;
      const plan = (n: number) => chooseTactic(planetBattle(t, n, defenders, travelFor(n), reinf), prof.usesStaging, timeWeight);
      const ok = (n: number) => plan(n).tactic !== 'wait';
      const rate = near.reduce((s, p) => s + p.production, 0);
      const most = Math.floor(avail + rate * WAIT_STEPS[WAIT_STEPS.length - 1]);
      if (!ok(most)) continue; // 기다려도 안 된다
      // 간신히 이기는 수로는 보내지 않는다 (추정 오차 · 오는 길의 손실). 그 이상에서는 비용이 가장 싼 규모를 고른다:
      // 많이 보낼수록 빨리 · 적게 잃고 먹지만, 그만큼 다른 곳에 못 쓴다
      const least = Math.ceil(lowestPassing(1, most, ok) * prof.attackMargin);
      /** 지금부터 wait 초 뒤에 (그동안 생산된 병력까지) cap 기 안에서 보낼 때 가장 싼 규모 */
      const bestOf = (cap: number, wait: number) => {
        let best: { send: number; choice: TacticChoice; cost: number } | null = null;
        if (least > cap) return best;
        // 병력을 묶는 값은 여유 병력이 귀할수록 크다: 정원이 찬 채 놀고 있는 병력은 묶어도 잃는 게 없으니 크게 보내 빨리 끝낸다
        const unitWeight = UNIT_WEIGHT * Math.min(1, (2 * least) / cap);
        for (const k of FORCE_STEPS) {
          const send = Math.min(cap, Math.ceil(least * k));
          const choice = plan(send);
          if (choice.estimate) {
            const e = choice.estimate;
            const cost = e.losses + timeWeight * (e.time + wait) + unitWeight * send + 3;
            if (!best || cost < best.cost) best = { send, choice, cost };
          }
          if (send === cap) break;
        }
        return best;
      };
      const best = bestOf(avail, 0);
      if (!best) continue;
      const better = () => WAIT_STEPS.some((w) => (bestOf(Math.floor(avail + rate * w), w)?.cost ?? Infinity) < best.cost);
      // 멀수록 그동안 다른 일을 못 하고 돌아오기도 어렵다
      plans.push({ t, near, send: best.send, least, choice: best.choice, score: valueOf(t) / best.cost / (1 + dist(near[0], t) / 600), better });
    }
    plans.sort((a, b) => b.score - a.score);

    let launched = 0;
    for (const plan of plans) {
      if (active >= maxOps || launched >= launches) break;
      const { t, near, send, least, choice } = plan;
      if (near.reduce((s, p) => s + this.spare(pool, p), 0) < send) continue;
      // 대기: 생산을 몇 초 더 모아 보내는 편이 (기다린 시간까지 쳐도) 싸면 지금은 보내지 않는다
      if (plan.better()) continue;
      this.launch(world, pool, t, near, send, least, choice.tactic === 'siege', travel);
      active++;
      launched++;
    }
  }

  /**
   * 다른 진영 행성 t 의 주인이 보낼 수 있는 증원. 상대는 우리 병력이 닿기 ENEMY_NOTICE 초 전에야 알아채고,
   * ENEMY_REACTION 초 뒤 출발한다고 본다. 이웃 행성은 수비대의 REINFORCE_KEEP 만큼은 남기고, 나와 있는 무리는 전부 온다.
   * 그 수를 reinforceWeight 만큼 센다. (출발하자마자 전부 알아챈다고 보면, 행성마다 정원이 찬 대치에서
   * 어느 행성도 칠 수 없다고 나와 판이 끝나지 않는다)
   */
  private reinforcementsFor(world: World, t: Planet, armies: Army[], arrival: number): Reinforcement[] {
    const w = this.profile.reinforceWeight;
    const speed = CONFIG.unit.speed;
    const depart = Math.max(0, arrival - ENEMY_NOTICE) + ENEMY_REACTION;
    const list: Reinforcement[] = [];
    for (const q of world.planets) {
      if (q === t || q.owner !== t.owner) continue;
      const d = dist(q, t);
      if (d > AI_REINFORCE_RADIUS) continue;
      const n = q.orbitCount[t.owner] * (1 - REINFORCE_KEEP) * w;
      if (n >= 1) list.push({ count: n, eta: depart + (d - t.atmosphereRadius) / speed });
    }
    for (const a of armies) {
      if (a.faction !== t.owner) continue;
      const gap = dist(a, t) - t.atmosphereRadius;
      // 대기권 바로 곁의 무리는 이미 수비대(hostilesNear)로 셌다
      if (gap < 10 || gap > AI_REINFORCE_RADIUS) continue;
      list.push({ count: a.count * w, eta: depart + gap / speed });
    }
    return list;
  }

  /**
   * 공격 개시. 가까운 행성부터 병력을 떼고,
   * synchronize: 가까운 무리는 늦게 출발시켜 모두 같은 시각에 도착하게 한다 (먼저 닿은 무리가 각개 격파당하지 않게).
   * feints: 다른 진영 행성이면 그 이웃 행성(같은 주인)에 견제 병력을 먼저 보내 수비대 · 증원을 끌어낸 뒤 본대가 닿는다.
   */
  private launch(
    world: World,
    pool: Pool,
    t: Planet,
    near: Planet[],
    send: number,
    least: number,
    siege: boolean,
    travel: (s: Planet, t: Planet) => number,
  ): void {
    const prof = this.profile;
    const now = world.time;

    // 견제: 같은 주인의 가장 가까운 이웃 행성. 병력은 본대가 최소 병력(least)을 넘겨 가져가는 몫에서 떼어 낸다
    const decoy =
      prof.feints && t.owner !== NEUTRAL && send >= 20
        ? world.planets
            .filter((n) => n !== t && n.owner === t.owner && dist(n, t) < FEINT_RANGE && !this.ops.some((o) => o.target === n.id))
            .sort((a, b) => dist(a, t) - dist(b, t))[0]
        : undefined;
    const fakeSize = decoy ? Math.min(16, Math.max(6, Math.round(send * FEINT_SHARE))) : 0;
    const surplus = near.reduce((s, p) => s + this.spare(pool, p), 0) - send;
    const main = decoy && surplus < fakeSize ? Math.max(least, send - (fakeSize - surplus)) : send;

    const groups: { units: Unit[]; eta: number }[] = [];
    let count = 0;
    for (const s of near) {
      if (count >= main) break;
      const n = Math.min(this.spare(pool, s), main - count);
      if (n <= 0) continue;
      groups.push({ units: this.take(pool, s, n), eta: travel(s, t) });
      count += n;
    }
    const all = groups.flatMap((g) => g.units);
    const op = this.newOp('attack', t.id, all, now, siege ? 'stage' : 'assault');
    const formation = siege ? 'spread' : 'cluster';
    let arrive = Math.max(...groups.map((g) => g.eta));

    if (decoy) {
      const src = near.filter((s) => this.spare(pool, s) > 0).sort((a, b) => travel(a, decoy) - travel(b, decoy));
      if (src.reduce((s, p) => s + this.spare(pool, p), 0) >= fakeSize) {
        const fake: Unit[] = [];
        for (const s of src) {
          if (fake.length >= fakeSize) break;
          fake.push(...this.take(pool, s, Math.min(this.spare(pool, s), fakeSize - fake.length)));
        }
        // 궤도 위 실제 출발 위치를 쓴다. 산개 무리는 뒤쪽 병력의 보폭에 맞춰 가므로
        // 행성 중심 간 거리만 쓰면 견제의 도착을 실제보다 빨리 잡는다.
        const fakeEta = Math.max(...fake.map((u) => Math.max(0, dist(u, decoy) - decoy.atmosphereRadius) / CONFIG.unit.speed));
        // 포위로 대기권 밖에 서서 오래 버티며 시선을 끈다. 본대는 그보다 FEINT_LEAD 초 늦게 닿는다
        this.order(world, fake, { kind: 'planet', planetId: decoy.id, formation: 'spread' });
        const feint = this.newOp('feint', decoy.id, fake, now, 'stage');
        feint.partner = op;
        op.partner = feint;
        this.ops.push(feint);
        arrive = Math.max(arrive, fakeEta + FEINT_LEAD);
      }
    }

    for (const g of groups) {
      // 돌파 무리는 보폭을 맞추지 않아 앞쪽 병력이 먼저 닿는다. 견제와의 간격은
      // 본대 선두 기준으로 확보해야 먼저 도착한 본대가 견제보다 앞서 싸우지 않는다.
      const eta = op.partner ? Math.min(...g.units.map((u) => Math.max(0, dist(u, t) - t.atmosphereRadius) / CONFIG.unit.speed)) : g.eta;
      const delay = prof.synchronize || op.partner ? arrive - eta : 0;
      if (delay < prof.thinkInterval) this.order(world, g.units, { kind: 'planet', planetId: t.id, formation });
      else op.pending.push({ ids: g.units.map((u) => u.id), at: now + delay });
    }
    this.ops.push(op);
  }

  private newOp(kind: Operation['kind'], target: number, units: Unit[], now: number, phase: Operation['phase'], prey: number[] = []): Operation {
    return {
      kind,
      target,
      units: new Set(units.map((u) => u.id)),
      phase,
      startedAt: now,
      initial: units.length,
      pending: [],
      prey,
      partner: null,
      doubt: 0,
      done: false,
    };
  }

  // ───────────── 진행 중인 작전 ─────────────

  private updateOps(world: World): void {
    const now = world.time;
    const end = (op: Operation, retreat: boolean): false => {
      if (retreat) this.order(world, op.units, { kind: 'return' });
      op.done = true;
      return false;
    };
    this.ops = this.ops.filter((op) => {
      // 출발을 기다리던 무리
      op.pending = op.pending.filter((g) => {
        g.ids = g.ids.filter((id) => op.units.has(id));
        if (g.at > now) return true;
        if (op.kind === 'attack') {
          const formation = op.phase === 'stage' ? 'spread' : 'cluster';
          this.order(world, g.ids, { kind: 'planet', planetId: op.target, formation });
        }
        return false;
      });
      if (op.units.size === 0) return end(op, false);
      if (op.kind === 'hunt') return this.updateHunt(world, op) || end(op, true);

      const t = world.planets[op.target];
      if (t.owner === this.faction) return end(op, false);
      const alive = op.units.size;
      const elapsed = now - op.startedAt;

      if (op.kind === 'feint') {
        // 본대가 끝났거나, 오래 버텼거나, 절반을 잃으면 물러난다
        if (!op.partner || op.partner.done || elapsed > FEINT_DURATION || alive < op.initial * 0.5) return end(op, true);
        return true;
      }

      const waiting = op.pending.reduce((s, g) => s + g.ids.length, 0);
      if (op.phase === 'stage') return this.updateSiege(world, op, t, alive, waiting, elapsed) || end(op, true);

      if (elapsed > ASSAULT_TIMEOUT) return end(op, true);
      if (this.profile.retreatEarly) {
        // 수비대 사거리까지 접근하면 재평가한다. 대다수가 대기권 안에 들어갈 때까지
        // 기다리면 증원이 온 것을 보고도 강하해, 선회·가속하며 빠져나올 병력까지 잃는다.
        if (waiting === 0 && elapsed > 3) {
          let inside = 0, approaching = 0;
          for (const id of op.units) {
            const u = world.getUnit(id)!;
            if (u.inPlanet === t.id) inside++;
            if (dist(u, t) <= t.atmosphereRadius + CONFIG.unit.range) approaching++;
          }
          if (approaching >= alive * 0.6) {
            const defenders = this.hostilesNear(world, t, 0, true);
            const est = estimateBattle({ ...planetBattle(t, alive * RETREAT_SLACK, defenders, 0), engaged: inside >= alive * 0.6 }, 'dive');
            op.doubt = !est.success && t.defense > t.maxDefense * 0.1 ? op.doubt + 1 : 0;
            if (op.doubt >= DOUBT_LIMIT) return end(op, true);
          }
        }
      } else if (alive < op.initial * 0.25 && t.defense > alive * 3) {
        return end(op, true);
      }
      return true;
    });
  }

  /** 포위 중: 지금 돌파로 바꾸는 게 싸면 돌파, 둘 다 지는 싸움이면 귀환. false = 작전 종료(귀환) */
  private updateSiege(world: World, op: Operation, t: Planet, alive: number, waiting: number, elapsed: number): boolean {
    const defenders = this.hostilesNear(world, t, 10, true);
    let holding = 0;
    for (const id of op.units) if (world.getUnit(id)!.state === 'hold') holding++;
    const settled = waiting === 0 && holding > (alive - waiting) * 0.7;
    const dive = () => {
      this.order(world, op.units, { kind: 'planet', planetId: t.id, formation: 'cluster' });
      op.phase = 'assault';
      op.startedAt = world.time;
      op.doubt = 0;
      return true;
    };
    if (!this.profile.retreatEarly) {
      // 예전 규칙: 수가 밀리면 귀환, 충분히 깎았거나 30초가 지나면 돌파
      if (alive < defenders * 0.7) return false;
      if ((holding > alive * 0.7 && defenders <= alive * 0.35) || elapsed > BATTLE_MODEL.siegeLimit) return dive();
      return true;
    }
    if (!settled) return elapsed > BATTLE_MODEL.siegeLimit + 15 ? dive() : true;
    const inp = { ...planetBattle(t, alive, defenders, 0), engaged: true };
    const now = chooseTactic(inp, true, TIME_WEIGHT);
    if (now.tactic === 'wait' && chooseTactic({ ...inp, attackers: alive * RETREAT_SLACK }, true).tactic === 'wait') {
      op.doubt++;
      return op.doubt < DOUBT_LIMIT;
    }
    op.doubt = 0;
    if (now.tactic === 'dive' || defenders <= Math.max(2, alive * BATTLE_MODEL.siegeSwitch) || elapsed > BATTLE_MODEL.siegeLimit) return dive();
    return true;
  }

  /** 사냥: 매 판단 사냥감의 지금 위치(+ 진행 방향)로 다시 겨눈다. false = 끝 (귀환) */
  private updateHunt(world: World, op: Operation): boolean {
    const prey = op.prey.map((id) => world.getUnit(id)).filter((u): u is Unit => !!u);
    if (prey.length === 0 || world.time - op.startedAt > HUNT_TIMEOUT) return false;
    op.prey = prey.map((u) => u.id);
    const army: Army = { faction: prey[0].faction, count: prey.length, x: 0, y: 0, vx: 0, vy: 0, ids: op.prey };
    for (const u of prey) {
      army.x += u.x / prey.length;
      army.y += u.y / prey.length;
      army.vx += ((u.x - u.px) * CONFIG.tickRate) / prey.length;
      army.vy += ((u.y - u.py) * CONFIG.tickRate) / prey.length;
    }
    // 적 행성 대기권 곁으로 도망치면 그만둔다 (수비대 사거리로 끌려 들어가지 않게)
    if (world.planets.some((p) => p.owner !== this.faction && dist(p, army) < p.atmosphereRadius + 30)) return false;
    const first = world.getUnit(op.units.values().next().value!)!;
    const aim = intercept(army, dist(first, army) / CONFIG.unit.speed);
    this.order(world, op.units, { kind: 'move', x: aim.x, y: aim.y, formation: 'cluster' });
    return true;
  }
}

/** 무리가 지금 속도로 τ 초 움직였을 때의 위치 (사냥 요격점). 너무 앞질러 겨누지 않게 4초까지만 내다본다 */
function intercept(a: Army, tau: number): { x: number; y: number } {
  const k = Math.min(4, tau);
  return { x: a.x + a.vx * k, y: a.y + a.vy * k };
}

/** [lo, hi] 에서 pass 를 만족하는 가장 작은 정수 (pass 는 단조 증가, pass(hi) 는 참이라고 본다) */
function lowestPassing(lo: number, hi: number, pass: (n: number) => boolean): number {
  if (pass(lo)) return lo;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (pass(mid)) hi = mid;
    else lo = mid;
  }
  return hi;
}

/** 맵(행성 배치)과 진영으로 정하는 AI 전용 시드: 같은 판이면 같은 잡음 → 결정론 유지 */
function mapSeed(world: World, faction: FactionId): number {
  let h = 0x811c9dc5 ^ faction;
  for (const p of world.planets) {
    h = Math.imul(h ^ Math.round(p.x), 16777619);
    h = Math.imul(h ^ Math.round(p.y), 16777619);
  }
  return h >>> 0;
}

function dist(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}
