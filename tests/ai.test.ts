import { describe, expect, it } from 'vitest';
import { AI_PROFILES, CONFIG, type AIProfile, type PlanetSize } from '../src/config';
import {
  AIController,
  MOTION,
  chooseTactic,
  estimateBattle,
  groupEta,
  planetBattle,
  projectArmy,
  trackArmies,
  type BattleInput,
  type MoveKind,
  type Tactic,
} from '../src/sim/ai';
import { Match } from '../src/sim/match';
import type { Unit } from '../src/sim/types';
import { World, type PlanetInit } from '../src/sim/world';

const DT = 1 / CONFIG.tickRate;
const dist = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);

function makeWorld(planets: PlanetInit[], seed = 3): World {
  return new World({ width: 1200, height: 700, seed, factionCount: 2, aiFactions: [], planets });
}

/** AI 를 붙여 seconds 초 진행 (Match 와 같은 순서: world.step → ai.update). each 는 매 틱 뒤에, true 를 돌려주면 멈춘다 */
function run(w: World, ais: AIController[], seconds: number, each?: () => boolean | void): void {
  const end = w.time + seconds;
  while (w.time < end && w.winner === null) {
    w.step(DT);
    for (const ai of ais) ai.update(w);
    const stop = each?.();
    w.events.length = 0;
    if (stop) return;
  }
}

/** 우주 공간에 위치 고수 중인 병력 count 기 (5px 격자) */
function squad(w: World, faction: number, count: number, x: number, y: number): Unit[] {
  const cols = Math.ceil(Math.sqrt(count));
  return Array.from({ length: count }, (_, i) => w.spawnAt(faction, x + (i % cols) * 5, y + Math.floor(i / cols) * 5, false));
}

// ───────────────────────────── 전투 추정기 vs 실제 시뮬레이션 ─────────────────────────────

/**
 * 실제 공방: 행성에서 140 떨어진 곳에 공격 N 기, 목표 궤도에 수비 G 기. 공격측 증원 없음, 수비측(적 소유면) 생산함.
 * siege = 포위로 서서 수비대가 max(2, 공격측 × 0.12) 이하가 되거나 30초가 지나면 돌파 (추정기의 포위 모형과 같은 규칙)
 */
function realBattle(size: PlanetSize, owner: 0 | 2, N: number, G: number, tactic: Tactic) {
  const w = new World({
    width: 1200, height: 800, seed: 1000 + N * 7 + G, factionCount: 2, aiFactions: [],
    planets: [
      { x: 100, y: 400, size: 'large', owner: 1, garrison: 0 },
      { x: 700, y: 400, size, owner, garrison: G },
      { x: 1150, y: 750, size: 'small', owner: 2, garrison: 0 },
    ],
  });
  w.planets[0].production = 0;
  w.planets[2].production = 0;
  const t = w.planets[1];
  const cols = Math.ceil(Math.sqrt(N));
  const ids = Array.from({ length: N }, (_, i) => w.spawnAt(1, 560 - (i % cols) * 5, 400 + (Math.floor(i / cols) - cols / 2) * 5, false).id);
  w.enqueue({ faction: 1, unitIds: ids, order: { kind: 'planet', planetId: 1, formation: tactic === 'dive' ? 'cluster' : 'spread' } });
  let dived = tactic === 'dive';
  let capturedAt = -1;
  while (w.time < 120) {
    w.step(DT);
    w.events.length = 0;
    const alive = ids.filter((id) => w.getUnit(id));
    if (!dived) {
      const arrived = alive.filter((id) => w.getUnit(id)!.state === 'hold').length >= alive.length * 0.7;
      if ((arrived && t.presence[owner] <= Math.max(2, alive.length * 0.12)) || w.time > 30) {
        w.enqueue({ faction: 1, unitIds: alive, order: { kind: 'planet', planetId: 1, formation: 'cluster' } });
        dived = true;
      }
    }
    if (capturedAt < 0 && t.owner === 1) capturedAt = w.time;
    if ((capturedAt >= 0 && w.time - capturedAt > 12) || alive.length === 0) break;
  }
  return { captured: capturedAt >= 0 && t.owner === 1, time: capturedAt, lost: N - ids.filter((id) => w.getUnit(id)).length };
}

function inputFor(size: PlanetSize, owner: 0 | 2, N: number, G: number): BattleInput {
  const spec = CONFIG.planet[size];
  return {
    attackers: N, defenders: G, radius: spec.radius, defense: spec.maxDefense, maxDefense: spec.maxDefense,
    regen: spec.maxDefense * CONFIG.regenRate, production: owner === 0 ? 0 : spec.production, capacity: spec.capacity,
    travel: (140 - spec.radius - CONFIG.atmosphere) / CONFIG.unit.speed + MOTION.startLag,
  };
}

describe('전투 추정기', () => {
  it('실제 시뮬레이션과 성패 · 전술(돌파/포위/대기) 순위가 대부분 일치한다', () => {
    // 고른 격자 (골라낸 사례가 아님): 크기 3 × 중립/적 × (15 vs 5, 40 vs 20, 80 vs 40)
    let successOk = 0, rankOk = 0, cases = 0;
    const misses: string[] = [];
    for (const size of ['small', 'medium', 'large'] as const) {
      for (const owner of [0, 2] as const) {
        for (const [N, G] of [[15, 5], [40, 20], [80, 40]]) {
          const inp = inputFor(size, owner, N, G);
          const lambda = 0.3 + inp.production;
          const real = { dive: realBattle(size, owner, N, G, 'dive'), siege: realBattle(size, owner, N, G, 'siege') };
          const cost = (r: { captured: boolean; time: number; lost: number }) => (r.captured ? r.lost + lambda * r.time : Infinity);
          const best = (d: number, s: number) => (d === Infinity && s === Infinity ? 'wait' : d <= s ? 'dive' : 'siege');
          const truth = best(cost(real.dive), cost(real.siege));
          const guess = chooseTactic(inp, true, lambda).tactic;
          for (const t of ['dive', 'siege'] as const) if (estimateBattle(inp, t).success === real[t].captured) successOk++;
          if (truth === guess) rankOk++;
          else misses.push(`${size}/${owner ? '적' : '중립'} ${N}v${G}: 실제 ${truth} 추정 ${guess}`);
          cases++;
        }
      }
    }
    console.info(`추정기 일치: 성패 ${successOk}/${cases * 2}, 전술 ${rankOk}/${cases}${misses.length ? ` (빗나감: ${misses.join(', ')})` : ''}`);
    expect(successOk / (cases * 2)).toBeGreaterThanOrEqual(0.85);
    expect(rankOk / cases).toBeGreaterThanOrEqual(0.75);
  }, 60_000);

  it('얇은 수비대는 돌파, 두꺼운 수비대는 포위, 어느 쪽도 안 되면 대기', () => {
    expect(chooseTactic(inputFor('medium', 0, 80, 6)).tactic).toBe('dive');
    expect(chooseTactic(inputFor('large', 0, 100, 70)).tactic).toBe('siege');
    expect(chooseTactic(inputFor('medium', 0, 20, 30)).tactic).toBe('wait');
    // 포위를 못 쓰는 성향은 돌파 아니면 대기
    expect(chooseTactic(inputFor('large', 0, 100, 70), false).tactic).toBe('wait');
  });

  it('공격 병력이 늘면 나빠지지 않고, 수비측 생산 · 증원은 공격을 어렵게 만든다', () => {
    for (const tactic of ['dive', 'siege'] as const) {
      let wasOk = false;
      for (let n = 5; n <= 120; n += 5) {
        const ok = estimateBattle(inputFor('medium', 0, n, 20), tactic).success;
        if (wasOk) expect(ok).toBe(true);
        wasOk ||= ok;
      }
      expect(wasOk).toBe(true);
    }
    const base = inputFor('medium', 2, 50, 15);
    const plain = estimateBattle({ ...base, production: 0 }, 'dive');
    const producing = estimateBattle(base, 'dive');
    const reinforced = estimateBattle({ ...base, reinforcements: [{ count: 30, eta: 3 }] }, 'dive');
    expect(plain.success).toBe(true);
    expect(producing.losses).toBeGreaterThan(plain.losses);
    expect(reinforced.success).toBe(false);
    // 멀리서 오는 증원은 점령 뒤에 닿으므로 상관없다
    expect(estimateBattle({ ...base, reinforcements: [{ count: 30, eta: 60 }] }, 'dive').success).toBe(true);
  });

  it('행성 상태로 입력을 만든다: 중립은 생산 0, 회복은 크기별 기본 최대치 기준', () => {
    const w = makeWorld([
      { x: 200, y: 300, size: 'medium', owner: 0, garrison: 4 },
      { x: 700, y: 300, size: 'large', owner: 2 },
    ]);
    const n = planetBattle(w.planets[0], 30, 4, 2);
    expect(n).toMatchObject({ attackers: 30, defenders: 4, production: 0, travel: 2, regen: CONFIG.planet.medium.maxDefense * CONFIG.regenRate });
    expect(planetBattle(w.planets[1], 30, 0, 0).production).toBe(CONFIG.planet.large.production);
  });
});

// ───────────────────────────── 이동 모형 ─────────────────────────────

describe('이동 모형 (AI 의 도착 시각)', () => {
  /** src 궤도의 병력 n 기를 d 떨어진 dst 로 보내 (돌파 · 포위 · 합류) 실제 도착 시각과 groupEta 를 견준다 */
  const trip = (kind: MoveKind, n: number, d: number, src: PlanetSize, dst: PlanetSize) => {
    const w = new World({
      width: 1600, height: 900, seed: n + d, factionCount: 2, aiFactions: [],
      planets: [
        { x: 300, y: 450, size: src, owner: 1, garrison: n },
        { x: 300 + d, y: 450, size: dst, owner: kind === 'join' ? 1 : 2, garrison: 0 },
        { x: 1590, y: 10, size: 'small', owner: 2, garrison: 0 },
      ],
    });
    for (let i = 0; i < 45; i++) w.step(DT); // 궤도에 자리 잡기
    const t = w.planets[1];
    const units = w.units.filter((u) => u.faction === 1 && u.planet === 0);
    const eta = groupEta(units, t, kind);
    const t0 = w.time;
    w.enqueue({ faction: 1, unitIds: units.map((u) => u.id), order: { kind: 'planet', planetId: 1, formation: kind === 'siege' ? 'spread' : 'cluster' } });
    // 돌파 · 합류는 대기권에 들어선 때, 포위는 고리 슬롯에 선 때
    const at = new Map<number, number>();
    while (at.size < units.length && w.time - t0 < 30) {
      w.step(DT);
      for (const u of units) {
        if (at.has(u.id)) continue;
        if (kind === 'siege' ? u.state === 'hold' : dist(u, t) <= t.atmosphereRadius) at.set(u.id, w.time - t0);
      }
    }
    const times = [...at.values()].sort((a, b) => a - b);
    return { eta, first: times[0], bulk: times.reduce((s, x) => s + x, 0) / times.length, naive: (d - t.atmosphereRadius) / CONFIG.unit.speed };
  };

  it('돌파는 병력마다 최고 속도, 포위 · 합류는 보폭을 맞춰 함께: groupEta 가 실제 도착과 맞는다', () => {
    for (const [n, d] of [[12, 300], [40, 600]]) {
      const dive = trip('dive', n, d, 'large', 'medium');
      // 첫 병력은 궤도 앞쪽에서 출발해 '거리 / 속도' 보다 거의 1초 일찍 닿는다 (돌파는 보폭을 맞추지 않는다)
      expect(dive.naive - dive.first).toBeGreaterThan(0.6);
      expect(Math.abs(dive.eta.first - dive.first)).toBeLessThan(0.25);
      expect(Math.abs(dive.eta.bulk - dive.bulk)).toBeLessThan(0.25);
      const join = trip('join', n, d, 'large', 'medium');
      expect(Math.abs(join.eta.first - join.first)).toBeLessThan(0.25);
      expect(Math.abs(join.eta.bulk - join.bulk)).toBeLessThan(0.4);
      const siege = trip('siege', n, d, 'large', 'medium');
      // 포위 무리는 고리 끝 슬롯에 맞춰 늦게 선다
      expect(siege.first).toBeGreaterThan(siege.naive);
      expect(Math.abs(siege.eta.bulk - siege.bulk)).toBeLessThan(0.6);
      expect(Math.abs(siege.eta.bulk - siege.bulk)).toBeLessThan(Math.abs(siege.naive - siege.bulk));
    }
  });

  it('출발 가속 · U 턴 지연이 조향과 맞는다 (MOTION)', () => {
    const w = makeWorld([
      { x: 100, y: 100, size: 'small', owner: 1, garrison: 0 },
      { x: 1150, y: 650, size: 'small', owner: 2, garrison: 0 },
    ]);
    const [u] = squad(w, 1, 1, 200, 400);
    const go = (x: number) => w.enqueue({ faction: 1, unitIds: [u.id], order: { kind: 'move', x, y: 400, formation: 'cluster' } });
    go(1100);
    for (let i = 0; i < 60; i++) w.step(DT);
    // 2초 동안 간 거리로 본 지연 = 정지에서 출발한 가속분
    expect(Math.abs(2 - (u.x - 200) / CONFIG.unit.speed - MOTION.startLag)).toBeLessThan(0.05);
    const x0 = u.x;
    let reach = 0;
    go(100);
    for (let i = 0; i < 60; i++) {
      w.step(DT);
      reach = Math.max(reach, u.x - x0);
    }
    // 반대로 돌아서는 데 즉시 반전보다 turnLag 늦고, 그사이 turnReach 남짓 더 나간다
    expect(Math.abs(2 - (x0 - u.x) / CONFIG.unit.speed - MOTION.turnLag)).toBeLessThan(0.08);
    expect(Math.abs(reach - MOTION.turnReach)).toBeLessThan(2);
  });
});

// ───────────────────────────── 군대 추적 · 진행 방향 ─────────────────────────────

describe('군대 추적', () => {
  it('가까운 병력끼리 묶고, 자기 행성 수비대는 빼고, 진행 방향으로 목표와 도착 시간을 내다본다', () => {
    const w = makeWorld([
      { x: 150, y: 350, size: 'medium', owner: 1, garrison: 5 },
      { x: 1050, y: 350, size: 'medium', owner: 2, garrison: 20 },
    ]);
    const coming = squad(w, 2, 12, 700, 340);
    squad(w, 2, 7, 600, 620); // 멀리 떨어진 다른 무리
    w.enqueue({ faction: 2, unitIds: coming.map((u) => u.id), order: { kind: 'planet', planetId: 0, formation: 'cluster' } });
    for (let i = 0; i < 10; i++) w.step(DT);

    const armies = trackArmies(w, 1).sort((a, b) => b.count - a.count);
    expect(armies.map((a) => a.count)).toEqual([12, 7]); // 행성 1 의 수비대 20 은 무리가 아니다
    const [a, b] = armies;
    expect(Math.hypot(a.vx, a.vy)).toBeGreaterThan(40);
    expect(a.vx).toBeLessThan(0);
    const hit = projectArmy(a, [w.planets[0]], 20)!;
    expect(hit.planet).toBe(w.planets[0]);
    const expected = (dist(a, w.planets[0]) - w.planets[0].atmosphereRadius) / CONFIG.unit.speed;
    expect(hit.eta).toBeCloseTo(expected, 5);
    // 멈춰 있는 무리, 지평 밖, 반대 방향은 위협이 아니다
    expect(projectArmy(b, [w.planets[0]], 20)).toBeNull();
    expect(projectArmy(a, [w.planets[0]], 2)).toBeNull();
    expect(projectArmy({ ...a, vx: -a.vx, vy: -a.vy }, [w.planets[0]], 20)).toBeNull();
  });
});

// ───────────────────────────── AI 행동 ─────────────────────────────

describe('AI 행동', () => {
  it('어려움: 다가오는 무리를 내다보고 도착 전에 증원해 행성을 지킨다 (쉬움은 붙은 뒤에야 움직인다)', () => {
    const scenario = (difficulty: 'easy' | 'hard') => {
      const w = makeWorld([
        { x: 150, y: 350, size: 'large', owner: 1, garrison: 60 },
        { x: 520, y: 350, size: 'small', owner: 1, garrison: 4 },
        { x: 1150, y: 650, size: 'small', owner: 2, garrison: 40 },
      ]);
      const raid = squad(w, 2, 26, 1000, 330);
      w.enqueue({ faction: 2, unitIds: raid.map((u) => u.id), order: { kind: 'planet', planetId: 1, formation: 'cluster' } });
      const ai = new AIController(1, difficulty, 0.5);
      let sentAt = -1, contactAt = -1;
      run(w, [ai], 40, () => {
        if (sentAt < 0 && w.units.some((u) => u.faction === 1 && u.state === 'move' && u.planet === 1)) sentAt = w.time;
        if (contactAt < 0 && w.planets[1].presence[2] > 0) contactAt = w.time;
      });
      return { sentAt, contactAt, held: w.planets[1].owner === 1 };
    };
    const hard = scenario('hard');
    const easy = scenario('easy');
    expect(hard.sentAt).toBeGreaterThan(0);
    expect(hard.sentAt).toBeLessThan(hard.contactAt - 3);
    expect(hard.held).toBe(true);
    expect(easy.sentAt < 0 || easy.sentAt > hard.sentAt + 2).toBe(true);
  });

  it('지는 싸움이 되면 일찍 물려 병력을 살린다', () => {
    const w = makeWorld([
      { x: 150, y: 350, size: 'large', owner: 1, garrison: 70 },
      { x: 620, y: 350, size: 'medium', owner: 2, garrison: 6 },
      { x: 1150, y: 650, size: 'small', owner: 2, garrison: 10 },
    ]);
    const home = w.planets[0], target = w.planets[1];
    const ai = new AIController(1, 'hard', 0.5);
    // 공격이 출발해 목표 가까이 갈 때까지
    const near = () => w.units.filter((u) => u.faction === 1 && dist(u, target) < target.atmosphereRadius + 40).length;
    run(w, [ai], 30, () => near() >= 10);
    expect(near()).toBeGreaterThanOrEqual(10);
    const force = w.units.filter((u) => u.faction === 1 && dist(u, home) > home.atmosphereRadius + 20).map((u) => u.id);
    expect(force.length).toBeGreaterThanOrEqual(10);
    // 그 순간 목표에 수비대 90 기가 생긴다 (이웃 행성 증원이 도착한 셈)
    for (let i = 0; i < 90; i++) w.spawnUnit(2, target, false);
    run(w, [ai], 25);
    const survivors = force.filter((id) => w.getUnit(id));
    expect(target.owner).toBe(2);
    expect(survivors.length).toBeGreaterThanOrEqual(force.length * 0.4);
    expect(survivors.every((id) => dist(w.getUnit(id)!, home) < home.atmosphereRadius + 5 || w.getUnit(id)!.planet === home.id)).toBe(true);
  });

  it('다가가는 동안 수비대가 불어나면 대기권에 들어서기 전에 돌아선다 (들어간 뒤의 U 턴은 사격 띠 안에서 맞는다)', () => {
    const w = makeWorld([
      { x: 150, y: 350, size: 'large', owner: 1, garrison: 70 },
      { x: 620, y: 350, size: 'medium', owner: 2, garrison: 6 },
      { x: 1150, y: 650, size: 'small', owner: 2, garrison: 10 },
    ]);
    const target = w.planets[1];
    const ai = new AIController(1, 'hard', 0.5);
    // 공격 무리의 앞줄이 대기권 100px 앞에 왔을 때 수비대 90 기가 생긴다
    const front = () => Math.min(...w.units.filter((u) => u.faction === 1 && u.state === 'move').map((u) => dist(u, target) - target.atmosphereRadius));
    run(w, [ai], 30, () => front() < 100);
    const force = w.units.filter((u) => u.faction === 1 && u.state === 'move').map((u) => u.id);
    expect(force.length).toBeGreaterThanOrEqual(30);
    for (let i = 0; i < 90; i++) w.spawnUnit(2, target, false);
    let entered = 0;
    run(w, [ai], 15, () => {
      for (const id of force) if (w.getUnit(id)?.inPlanet === target.id) entered++;
    });
    expect(entered).toBe(0);
    expect(force.filter((id) => w.getUnit(id)).length).toBeGreaterThanOrEqual(force.length * 0.9);
  });

  it('어려움: 여러 행성에서 모은 병력이 거의 같은 시각에 닿는다 (가까운 무리를 늦게 출발)', () => {
    const w = makeWorld([
      { x: 120, y: 350, size: 'large', owner: 1, garrison: 45 },
      { x: 560, y: 520, size: 'small', owner: 1, garrison: 28 },
      { x: 820, y: 350, size: 'large', owner: 0, garrison: 34 },
      { x: 1150, y: 650, size: 'small', owner: 2, garrison: 40 },
    ]);
    const target = w.planets[2];
    const ai = new AIController(1, 'hard', 0.5);
    const origin = new Map<number, number>();
    const startedAt = new Map<number, number>();
    const arrivedAt = new Map<number, number>();
    run(w, [ai], 45, () => {
      for (const u of w.units) {
        if (u.faction !== 1) continue;
        if (!origin.has(u.id)) origin.set(u.id, u.planet);
        if (!startedAt.has(u.id) && u.state === 'move') startedAt.set(u.id, w.time);
        if (!arrivedAt.has(u.id) && dist(u, target) < target.atmosphereRadius + 12) arrivedAt.set(u.id, w.time);
      }
    });
    // 점령 뒤 그 행성에서 생산된 병력은 빼고, 처음부터 있던 두 행성 출신만 본다
    const ids = [...arrivedAt.keys()].filter((id) => origin.get(id) === 0 || origin.get(id) === 1);
    const times = ids.map((id) => arrivedAt.get(id)!).sort((a, b) => a - b);
    expect(times.length).toBeGreaterThanOrEqual(30);
    // 두 행성 모두에서 왔고, 가까운 행성(1)의 무리는 먼 행성(0)보다 늦게 출발했다
    const firstStart = (pid: number) => Math.min(...ids.filter((id) => origin.get(id) === pid).map((id) => startedAt.get(id)!));
    expect(ids.some((id) => origin.get(id) === 0) && ids.some((id) => origin.get(id) === 1)).toBe(true);
    expect(firstStart(1) - firstStart(0)).toBeGreaterThan(3);
    // 가운데 80% 가 3초 안에 닿는다. 동시에 출발했다면 이동 시간 차이(약 7초)만큼 벌어진다
    const spread = times[Math.floor(times.length * 0.9)] - times[Math.floor(times.length * 0.1)];
    expect(spread).toBeLessThan(3);
  });

  it('어려움: 본대 전에 이웃 적 행성을 견제해 수비대를 끌어낸다', () => {
    const w = makeWorld([
      { x: 150, y: 350, size: 'large', owner: 1, garrison: 90 },
      { x: 760, y: 220, size: 'medium', owner: 2, garrison: 12 },
      { x: 760, y: 500, size: 'medium', owner: 2, garrison: 12 },
    ]);
    const ai = new AIController(1, 'hard', 0.5);
    // 행성마다 아군이 처음 닿은 시각과, 그 3초 뒤 곁에 있는 수
    const first = new Map<number, number>();
    const count = new Map<number, number>();
    const near = (pid: number) => w.units.filter((u) => u.faction === 1 && dist(u, w.planets[pid]) < w.planets[pid].atmosphereRadius + 12).length;
    run(w, [ai], 30, () => {
      for (const pid of [1, 2]) {
        if (!first.has(pid) && near(pid) > 0) first.set(pid, w.time);
        if (first.has(pid) && !count.has(pid) && w.time >= first.get(pid)! + 3) count.set(pid, near(pid));
      }
      return count.size === 2;
    });
    expect(count.size).toBe(2);
    const [feint, main] = [1, 2].sort((a, b) => first.get(a)! - first.get(b)!);
    expect(count.get(feint)!).toBeGreaterThanOrEqual(6);
    expect(count.get(feint)!).toBeLessThanOrEqual(16);
    expect(count.get(main)!).toBeGreaterThan(count.get(feint)! * 2);
    expect(first.get(main)! - first.get(feint)!).toBeGreaterThanOrEqual(2);
  });

  it('어려움: 우주 공간에 떨어진 작은 무리를 근처 병력으로 사냥한다', () => {
    const w = makeWorld([
      { x: 150, y: 350, size: 'large', owner: 1, garrison: 40 },
      { x: 1150, y: 650, size: 'large', owner: 2, garrison: 70 },
    ]);
    const prey = squad(w, 2, 8, 430, 330).map((u) => u.id);
    const ai = new AIController(1, 'hard', 0.5);
    const lostBefore = w.factions[1].stats.lost;
    run(w, [ai], 20);
    expect(prey.filter((id) => w.getUnit(id))).toHaveLength(0);
    expect(w.factions[1].stats.lost - lostBefore).toBeLessThan(8);
  });

  it('공격을 막아 내면 그 진영 행성에 반격 가산이 붙는다', () => {
    const w = makeWorld([
      { x: 150, y: 350, size: 'large', owner: 1, garrison: 70 },
      { x: 1100, y: 350, size: 'large', owner: 2, garrison: 80 },
    ]);
    const raid = squad(w, 2, 30, 600, 330);
    w.enqueue({ faction: 2, unitIds: raid.map((u) => u.id), order: { kind: 'planet', planetId: 0, formation: 'cluster' } });
    const ai = new AIController(1, 'normal', 0.5);
    let counterAt = -1;
    run(w, [ai], 40, () => {
      const until = (ai as unknown as { counterUntil: Map<number, number> }).counterUntil.get(2) ?? -1;
      if (counterAt < 0 && until > w.time) counterAt = w.time;
    });
    expect(raid.filter((u) => w.getUnit(u.id))).toHaveLength(0);
    expect(w.planets[0].owner).toBe(1);
    expect(counterAt).toBeGreaterThan(0);
  });
});

// ───────────────────────────── 난이도 · 결정론 ─────────────────────────────

describe('난이도 성향', () => {
  const behaviours = ['projectThreats', 'retreatEarly', 'opportunism', 'snipes', 'synchronize', 'feints', 'usesStaging'] as const;
  const on = (p: AIProfile) => behaviours.filter((b) => p[b]);

  it('어려울수록 빨리 반응하고 덜 잘못 보며, 켜는 행동은 쉬움 ⊆ 보통 ⊆ 어려움', () => {
    const { easy, normal, hard } = AI_PROFILES;
    expect(easy.thinkInterval).toBeGreaterThan(normal.thinkInterval);
    expect(normal.thinkInterval).toBeGreaterThan(hard.thinkInterval);
    expect(easy.estimateNoise).toBeGreaterThan(normal.estimateNoise);
    expect(normal.estimateNoise).toBeGreaterThanOrEqual(hard.estimateNoise);
    expect(easy.estimateBias).toBeLessThan(1);
    expect(on(easy).every((b) => normal[b])).toBe(true);
    expect(on(normal).every((b) => hard[b])).toBe(true);
    expect(on(hard)).toHaveLength(behaviours.length);
  });

  it('추정 잡음을 써도 같은 시드는 같은 결과 (AI 전용 시드 난수)', () => {
    const signature = (m: Match) => m.world.units.reduce((h, u) => (h * 31 + Math.round(u.x * 10) + Math.round(u.y * 10) * 7 + u.faction) >>> 0, 0);
    const a = new Match({ aiCount: 2, difficulty: 'easy', seed: 21, autoplay: true });
    const b = new Match({ aiCount: 2, difficulty: 'easy', seed: 21, autoplay: true });
    for (let i = 0; i < CONFIG.tickRate * 70; i++) {
      a.step();
      b.step();
    }
    expect(signature(a)).toBe(signature(b));
    expect(a.world.planets.map((p) => p.owner)).toEqual(b.world.planets.map((p) => p.owner));
  });
});
