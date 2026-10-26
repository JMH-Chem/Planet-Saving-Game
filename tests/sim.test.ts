import { describe, expect, it } from 'vitest';
import { CONFIG } from '../src/config';
import { generateMap } from '../src/sim/mapgen';
import { Match } from '../src/sim/match';
import type { Unit } from '../src/sim/types';
import { World, type PlanetInit } from '../src/sim/world';

const DT = 1 / CONFIG.tickRate;

/**
 * 테스트용 월드. 살아 있는 진영이 하나뿐이면 첫 틱에 승부가 나서 시뮬레이션이 멈추므로,
 * 기본으로 구석에 진영 2 의 행성(anchor)을 하나 둔다.
 */
function makeWorld(planets: PlanetInit[], anchor = true): World {
  const all = anchor ? [...planets, { x: 960, y: 560, size: 'small' as const, owner: 2 }] : planets;
  return new World({ width: 1000, height: 600, seed: 1, factionCount: 2, aiFactions: [], planets: all });
}

function run(w: World, seconds: number): void {
  for (let t = 0; t < seconds; t += DT) w.step(DT);
}

/** 우주 공간 (x, y) 에 대기 중인 병력을 만든다 */
function spawnAt(w: World, faction: number, count: number, x: number, y: number): Unit[] {
  const units: Unit[] = [];
  for (let i = 0; i < count; i++) {
    const u = w.spawnUnit(faction, w.planets[0], false);
    u.x = u.px = u.tx = x + (i % 8) * 5;
    u.y = u.py = u.ty = y + Math.floor(i / 8) * 5;
    u.state = 'hold';
    u.planet = -1;
    units.push(u);
  }
  return units;
}

const ids = (units: Unit[]) => units.map((u) => u.id);

describe('행성 생산', () => {
  it('초당 생산량만큼 병력을 만들고 궤도 정원에서 멈춘다', () => {
    const w = makeWorld([{ x: 200, y: 300, size: 'small', owner: 1 }]);
    const spec = CONFIG.planet.small;
    run(w, 10);
    expect(w.unitCount[1]).toBe(Math.floor(spec.production * 10));
    run(w, 200);
    expect(w.unitCount[1]).toBe(spec.capacity);
  });

  it('중립 행성은 생산하지 않는다', () => {
    const w = makeWorld([{ x: 200, y: 300, size: 'large', owner: 0, garrison: 3 }]);
    run(w, 20);
    expect(w.unitCount[0]).toBe(3);
  });
});

describe('위치 규칙 · 점령', () => {
  it('대기권 안으로 돌파한 병력이 방어도를 깎아 행성을 점령한다', () => {
    const w = makeWorld([
      { x: 100, y: 300, size: 'large', owner: 1 },
      { x: 500, y: 300, size: 'small', owner: 0, garrison: 0 },
    ]);
    const army = spawnAt(w, 1, 30, 400, 280);
    w.enqueue({ faction: 1, unitIds: ids(army), order: { kind: 'planet', planetId: 1, formation: 'cluster' } });
    run(w, 15);
    expect(w.planets[1].owner).toBe(1);
    expect(w.planets[1].defense).toBeGreaterThan(0);
    // 돌파한 병력은 그대로 새 행성의 궤도 수비대가 된다
    expect(w.planets[1].orbitCount[1]).toBeGreaterThan(20);
  });

  it('대기권 밖의 병력은 행성을 공격하지 않는다', () => {
    const w = makeWorld([
      { x: 100, y: 300, size: 'large', owner: 1 },
      { x: 500, y: 300, size: 'small', owner: 0, garrison: 0 },
    ]);
    const p = w.planets[1];
    spawnAt(w, 1, 16, 500 - p.atmosphereRadius - 45, 295); // 8열 격자 폭 35 → 오른쪽 끝도 대기권 밖
    run(w, 5);
    expect(p.defense).toBe(p.maxDefense);
  });

  it('궤도 수비대가 있으면 행성 피해가 공격측/(공격측+수비측) 비율로 줄어든다', () => {
    const drop = (garrison: number) => {
      const w = makeWorld([
        { x: 100, y: 300, size: 'large', owner: 1 },
        { x: 500, y: 300, size: 'large', owner: 2, garrison },
      ]);
      w.planets[1].production = 0;
      const p = w.planets[1];
      const army = spawnAt(w, 1, 20, 500 - 20, 300 - p.radius - 12);
      // 바로 대기권 안에 배치: 이동 없이 위치 규칙만 비교
      for (const u of army) u.y = u.py = u.ty = p.y - p.radius - 10 + (u.y - army[0].y) * 0.2;
      run(w, 1);
      return p.maxDefense - p.defense;
    };
    const free = drop(0);
    const contested = drop(20);
    expect(free).toBeGreaterThan(0);
    expect(contested).toBeLessThan(free * 0.6);
  });

  it('남의 행성을 도는 병력은 수비대와 반대로 돌고, 점령되면 그 틱부터 방향이 바뀐다', () => {
    const w = makeWorld([
      { x: 100, y: 300, size: 'large', owner: 1 },
      { x: 500, y: 300, size: 'medium', owner: 2, garrison: 1 },
    ]);
    const p = w.planets[1];
    const defender = w.units.find((u) => u.faction === 2 && u.planet === p.id)!;
    const intruder = w.spawnUnit(1, p, false);
    const turn = () => {
      const a0 = defender.orbitAngle, b0 = intruder.orbitAngle;
      w.step(DT);
      return [Math.sign(defender.orbitAngle - a0), Math.sign(intruder.orbitAngle - b0)];
    };
    expect(turn()).toEqual([1, Math.sign(CONFIG.intruderOrbitFactor)]);
    w.capture(p, 1);
    expect(turn()).toEqual([Math.sign(CONFIG.intruderOrbitFactor), 1]);
  });

  it('강하 병력이 수비대와 엇갈려 돌므로 두꺼운 궤도 수비대는 비슷한 수의 돌파를 막아 낸다', () => {
    // 같은 방향으로 돌던 때는 처음 사거리 밖에 내린 강하 병력이 끝까지 맞지 않아 80 vs 120 이 함락됐다
    const w = new World({
      width: 1000, height: 600, seed: 2, factionCount: 2, aiFactions: [],
      planets: [
        { x: 100, y: 300, size: 'large', owner: 1, garrison: 0 },
        { x: 600, y: 300, size: 'large', owner: 2, garrison: 80 },
        { x: 960, y: 560, size: 'small', owner: 2, garrison: 0 },
      ],
    });
    for (const p of w.planets) p.production = 0;
    run(w, 8); // 수비대가 궤도에 자리 잡게
    const army: Unit[] = [];
    for (let i = 0; i < 120; i++) army.push(w.spawnAt(1, 420 + (i % 10) * 5, 280 + Math.floor(i / 10) * 5, false));
    w.enqueue({ faction: 1, unitIds: ids(army), order: { kind: 'planet', planetId: 1, formation: 'cluster' } });
    for (let t = 0; t < 60 && army.some((u) => u.alive); t += DT) w.step(DT);
    expect(army.every((u) => !u.alive)).toBe(true);
    expect(w.planets[1].owner).toBe(2);
  });
});

describe('고립(보급 단절)', () => {
  it('행성을 빼앗기면 궤도 수비대가 고립되고, 아군 행성에 닿으면 풀린다', () => {
    const w = makeWorld([
      { x: 100, y: 300, size: 'large', owner: 1 },
      { x: 500, y: 300, size: 'small', owner: 2, garrison: 5 },
      { x: 800, y: 300, size: 'small', owner: 2 },
    ]);
    const defenders = w.units.filter((u) => u.faction === 2);
    w.capture(w.planets[1], 1);
    expect(defenders.every((u) => u.isolated)).toBe(true);

    const hpBefore = defenders[0].hp;
    w.step(DT);
    expect(defenders[0].hp).toBeLessThan(hpBefore);

    w.enqueue({ faction: 2, unitIds: ids(defenders), order: { kind: 'return' } });
    run(w, 9);
    const survivors = defenders.filter((u) => u.alive);
    expect(survivors.length).toBeGreaterThan(0);
    expect(survivors.every((u) => !u.isolated && u.planet === 2)).toBe(true);
  });

  it('행성을 모두 잃은 진영의 병력은 전원 고립된다', () => {
    const w = makeWorld(
      [
        { x: 100, y: 300, size: 'large', owner: 1 },
        { x: 500, y: 300, size: 'small', owner: 2, garrison: 0 },
      ],
      false,
    );
    const army = spawnAt(w, 2, 5, 300, 100);
    w.capture(w.planets[1], 1);
    w.step(DT);
    expect(army.every((u) => u.isolated)).toBe(true);
  });
});

describe('이동 · 대형', () => {
  it('이동 명령은 목적지가 아닌 적 행성의 대기권을 돌아간다', () => {
    const w = makeWorld([
      { x: 100, y: 500, size: 'large', owner: 1 },
      { x: 500, y: 300, size: 'large', owner: 0, garrison: 0 },
    ]);
    const p = w.planets[1];
    const army = spawnAt(w, 1, 8, 250, 300);
    w.enqueue({ faction: 1, unitIds: ids(army), order: { kind: 'move', x: 750, y: 300, formation: 'cluster' } });
    let entered = false;
    for (let t = 0; t < 15; t += DT) {
      w.step(DT);
      if (army.some((u) => Math.hypot(u.x - p.x, u.y - p.y) < p.atmosphereRadius)) entered = true;
    }
    expect(entered).toBe(false);
    expect(army.every((u) => u.state === 'hold' && u.x > 700)).toBe(true);
  });

  it('산개는 집중보다 넓게, 진행 방향에 수직으로 펼쳐진다', () => {
    const spread = (formation: 'cluster' | 'spread') => {
      const w = makeWorld([{ x: 100, y: 100, size: 'small', owner: 1 }]);
      const army = spawnAt(w, 1, 40, 200, 300);
      w.enqueue({ faction: 1, unitIds: ids(army), order: { kind: 'move', x: 600, y: 300, formation } });
      run(w, 15);
      const ys = army.map((u) => u.y);
      const xs = army.map((u) => u.x);
      return { height: Math.max(...ys) - Math.min(...ys), width: Math.max(...xs) - Math.min(...xs) };
    };
    const c = spread('cluster');
    const s = spread('spread');
    expect(s.height).toBeGreaterThan(c.height * 2);
    expect(s.width).toBeLessThan(s.height);
  });

  it('돌파·합류 슬롯은 무리가 아무리 커도 대기권 안이고, 다 들어가는 무리는 기존 고리 그대로다', () => {
    const [lo, hi] = CONFIG.orbitBand;
    const assaultAlts = [lo + 2, (lo + hi) / 2, hi - 2, hi - 2 + CONFIG.formation.rowSpacing];
    for (const size of ['small', 'medium', 'large'] as const) {
      for (const owner of [2, 1]) {
        // 경계값: 기존 고리 정원(합류 91/117/141, 돌파 145/181/219) 바로 위, 그리고 500 까지
        for (const n of [1, 40, 92, 100, 118, 142, 146, 182, 220, 300, 400, 500]) {
          // owner 2 = 적 행성 돌파, owner 1 = 아군 행성 합류
          const w = makeWorld([
            { x: 60, y: 60, size: 'small', owner: 1 },
            { x: 500, y: 300, size, owner, garrison: 0 },
          ]);
          const p = w.planets[1];
          const army = spawnAt(w, 1, n, 200, 100);
          w.enqueue({ faction: 1, unitIds: ids(army), order: { kind: 'planet', planetId: p.id, formation: 'cluster' } });
          w.step(DT);
          for (const u of army) {
            const d = Math.hypot(u.tx - p.x, u.ty - p.y);
            expect(d).toBeLessThan(p.atmosphereRadius);
            expect(d).toBeGreaterThan(p.radius);
          }
          // 작은 돌파(대기권 안 고리 정원 이하)는 예전과 같은 고도에 선다
          if (owner === 2 && n <= 100) {
            for (const u of army) {
              const alt = Math.hypot(u.tx - p.x, u.ty - p.y) - p.radius;
              expect(assaultAlts.some((a) => Math.abs(a - alt) < 1e-6)).toBe(true);
            }
          }
        }
      }
    }
  });

  it('포위는 대기권 바로 바깥에 선다', () => {
    const w = makeWorld([
      { x: 100, y: 300, size: 'large', owner: 1 },
      { x: 600, y: 300, size: 'medium', owner: 0, garrison: 0 },
    ]);
    const p = w.planets[1];
    const army = spawnAt(w, 1, 30, 350, 280);
    w.enqueue({ faction: 1, unitIds: ids(army), order: { kind: 'planet', planetId: p.id, formation: 'spread' } });
    run(w, 15);
    for (const u of army) {
      const d = Math.hypot(u.x - p.x, u.y - p.y);
      expect(d).toBeGreaterThan(p.atmosphereRadius);
      expect(d).toBeLessThan(p.atmosphereRadius + 15);
    }
    expect(p.defense).toBe(p.maxDefense);
  });
});

describe('맵 생성', () => {
  it('2인 맵은 점대칭이고 대기권끼리 겹치지 않는다', () => {
    const init = generateMap({ factionCount: 2, seed: 123, aiFactions: [] });
    const cx = init.width / 2, cy = init.height / 2;
    for (const p of init.planets) {
      const mirror = init.planets.find((q) => Math.abs(q.x - (2 * cx - p.x)) < 1e-6 && Math.abs(q.y - (2 * cy - p.y)) < 1e-6);
      expect(mirror?.size).toBe(p.size);
    }
    for (const a of init.planets) {
      for (const b of init.planets) {
        if (a === b) continue;
        const gap = Math.hypot(a.x - b.x, a.y - b.y);
        expect(gap).toBeGreaterThan(CONFIG.planet[a.size].radius + CONFIG.planet[b.size].radius + CONFIG.atmosphere * 2);
      }
    }
  });

  it('세로 모드는 맵을 세로로 길게 만든다', () => {
    const init = generateMap({ factionCount: 2, seed: 5, aiFactions: [], portrait: true });
    expect(init.height).toBeGreaterThan(init.width);
  });
});

describe('결정론 · AI', () => {
  const signature = (m: Match) =>
    m.world.units.reduce((h, u) => (h * 31 + Math.round(u.x * 10) + Math.round(u.y * 10) * 7 + u.faction) >>> 0, 0);

  it('같은 시드는 같은 결과를 낸다 (리플레이/락스텝 대비)', () => {
    const a = new Match({ aiCount: 2, difficulty: 'normal', seed: 77, autoplay: true });
    const b = new Match({ aiCount: 2, difficulty: 'normal', seed: 77, autoplay: true });
    for (let i = 0; i < CONFIG.tickRate * 60; i++) {
      a.step();
      b.step();
    }
    expect(a.world.units.length).toBe(b.world.units.length);
    expect(signature(a)).toBe(signature(b));
  });

  it('AI 끼리 붙이면 15분 안에 승부가 난다', () => {
    const m = new Match({ aiCount: 1, difficulty: 'hard', seed: 3, autoplay: true });
    while (m.world.winner === null && m.world.time < 900) {
      m.step();
      m.world.events.length = 0;
    }
    expect(m.world.winner).not.toBeNull();
    expect(m.world.winner).toBeGreaterThan(0);
  });

  // 진영이 셋 이상이면 고르게 강한 AI 끼리 행성만 주고받다 끝나지 않을 수 있다 (가장 약한 상대부터 정리해서 끝낸다)
  it.each([
    ['easy', 3],
    ['normal', 2],
  ] as const)('여럿이 붙어도(%s, AI %i) 15분 안에 승부가 난다', (difficulty, aiCount) => {
    const m = new Match({ aiCount, difficulty, seed: 1, autoplay: true });
    while (m.world.winner === null && m.world.time < 900) {
      m.step();
      m.world.events.length = 0;
    }
    expect(m.world.winner).toBeGreaterThan(0);
  }, 30_000);

  it('AI 는 첫 중립 행성을 필요한 만큼만 모아 빨리 먹는다', () => {
    // 예전에는 소형 중립(수비대 5~6)에도 보통 52기, 어려움 40기를 모성에 쌓을 때까지 기다려 41~43초 / 31~33초에야 첫 점령
    const firstCapture = (difficulty: 'normal' | 'hard') => {
      const m = new Match({ aiCount: 1, difficulty, seed: 1 });
      while (m.world.time < 90) {
        m.step();
        for (const e of m.world.events) if (e.type === 'capture' && e.to > 1) return m.world.time;
        m.world.events.length = 0;
      }
      return Infinity;
    };
    expect(firstCapture('normal')).toBeLessThan(39);
    expect(firstCapture('hard')).toBeLessThan(31);
  });
});
