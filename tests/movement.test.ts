import { describe, expect, it } from 'vitest';
import { CONFIG } from '../src/config';
import type { Order, Unit } from '../src/sim/types';
import { World, type PlanetInit } from '../src/sim/world';

const DT = 1 / CONFIG.tickRate;

/** 생산을 끈 테스트용 월드. 구석에 진영 2 의 행성을 두어 첫 틱에 승부가 나지 않게 한다 */
function makeWorld(planets: PlanetInit[], seed = 1): World {
  const w = new World({
    width: 1200, height: 800, seed, factionCount: 2, aiFactions: [],
    planets: [...planets, { x: 1160, y: 760, size: 'small', owner: 2, garrison: 0 }],
  });
  for (const p of w.planets) p.production = 0;
  return w;
}

function step(w: World, seconds: number, each?: () => void): void {
  for (let t = 0; t < seconds; t += DT) {
    w.step(DT);
    w.events.length = 0;
    each?.();
  }
}

function order(w: World, units: Unit[], o: Order, faction = 1): void {
  w.enqueue({ faction, unitIds: units.map((u) => u.id), order: o });
}

/** 궤도에 자리 잡은 병력 (생산된 것처럼 각도 · 고도가 흩어져 있다) */
function orbiters(w: World, planet: number, n: number): Unit[] {
  const out = Array.from({ length: n }, () => w.spawnUnit(1, w.planets[planet], false));
  step(w, 3);
  return out;
}

const heading = (u: Unit) => Math.atan2(u.y - u.py, u.x - u.px);
const speedOf = (u: Unit) => Math.hypot(u.x - u.px, u.y - u.py) / DT;
const wrap = (a: number) => a - Math.round(a / (2 * Math.PI)) * 2 * Math.PI;

/** 선분 ab 와 cd 가 (끝점이 아닌 곳에서) 교차하는가 */
function crosses(a: number[], b: number[], c: number[], d: number[]): boolean {
  const o = (p: number[], q: number[], r: number[]) => Math.sign((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]));
  return o(a, b, c) * o(a, b, d) < 0 && o(c, d, a) * o(c, d, b) < 0;
}

describe('조향: 가속 · 선회 · 도착', () => {
  it('정지 상태에서 서서히 가속하고, 최고 속도를 넘지 않는다', () => {
    const w = makeWorld([{ x: 60, y: 60, size: 'small', owner: 1, garrison: 0 }]);
    const u = w.spawnAt(1, 200, 400, false);
    order(w, [u], { kind: 'move', x: 900, y: 400, formation: 'cluster' });
    const speeds: number[] = [];
    step(w, 3, () => speeds.push(speedOf(u)));
    // 첫 틱은 가속 한계만큼만
    expect(speeds[0]).toBeLessThanOrEqual(CONFIG.unit.accel * DT + 1e-9);
    // 최고 속도까지 걸리는 시간 ≈ speed / accel
    const reach = speeds.findIndex((s) => s >= CONFIG.unit.speed - 1e-6) * DT;
    expect(reach).toBeGreaterThan(CONFIG.unit.speed / CONFIG.unit.accel - 2 * DT);
    expect(reach).toBeLessThan(CONFIG.unit.speed / CONFIG.unit.accel + 2 * DT);
    expect(Math.max(...speeds)).toBeLessThanOrEqual(CONFIG.unit.speed + 1e-9);
  });

  it('달리던 함선에게 정반대 명령을 내리면 제자리에서 뒤돌지 않고 호를 그리며 돈다', () => {
    const w = makeWorld([{ x: 60, y: 60, size: 'small', owner: 1, garrison: 0 }]);
    const u = w.spawnAt(1, 300, 400, false);
    order(w, [u], { kind: 'move', x: 1000, y: 400, formation: 'cluster' });
    step(w, 2);
    expect(speedOf(u)).toBeCloseTo(CONFIG.unit.speed, 6);
    const x0 = u.x;
    order(w, [u], { kind: 'move', x: 100, y: 400, formation: 'cluster' });
    let prev = heading(u);
    let prevSpeed = speedOf(u);
    let maxTurn = 0, maxX = x0, maxDev = 0;
    step(w, 3, () => {
      const h = heading(u);
      const turn = Math.abs(wrap(h - prev));
      // 한 틱 선회 한계: 횡가속 한계(turnRate × speed) / 틀기 전 속도. 아주 느릴 때는 제자리에서 돌 수 있다
      if (prevSpeed > 5) maxTurn = Math.max(maxTurn, turn / (((CONFIG.unit.turnRate * CONFIG.unit.speed) / prevSpeed) * DT));
      prev = h;
      prevSpeed = speedOf(u);
      maxX = Math.max(maxX, u.x);
      maxDev = Math.max(maxDev, Math.abs(u.y - 400));
    });
    // 관성으로 조금 더 나아갔다가 (즉시 반전 아님) 돌아온다
    expect(maxX).toBeGreaterThan(x0 + 3);
    expect(maxDev).toBeGreaterThan(1);
    expect(maxTurn).toBeLessThanOrEqual(1 + 1e-6);
    expect(u.x).toBeLessThan(x0);
  });

  it('슬롯에 다가가며 감속해 지나치지 않고, 도착한 뒤엔 그대로 멈춰 있다', () => {
    const w = makeWorld([{ x: 60, y: 60, size: 'small', owner: 1, garrison: 0 }]);
    const units = Array.from({ length: 12 }, (_, i) => w.spawnAt(1, 200 + (i % 4) * 6, 300 + Math.floor(i / 4) * 6, false));
    order(w, units, { kind: 'move', x: 700, y: 500, formation: 'cluster' });
    const lastD = new Map<number, number>();
    let grew = 0;
    step(w, 20, () => {
      for (const u of units) {
        const d = Math.hypot(u.tx - u.x, u.ty - u.y);
        const before = lastD.get(u.id);
        // 마지막 30px: 남은 거리가 다시 늘어나면 지나친 것
        if (before !== undefined && before < 30 && d > before + 1e-9) grew++;
        lastD.set(u.id, d);
      }
    });
    expect(grew).toBe(0);
    expect(units.every((u) => u.state === 'hold' && u.x === u.tx && u.y === u.ty)).toBe(true);
    const at = units.map((u) => [u.x, u.y]);
    step(w, 2);
    expect(units.map((u) => [u.x, u.y])).toEqual(at);
  });

  it('선회 반경 때문에 우회 지점의 모서리를 깎더라도 목적지가 아닌 대기권에는 들어가지 않는다', () => {
    // 빠르게 달리던 무리를 적 행성 바로 옆에서 행성 너머로 꺾는다
    const w = makeWorld([
      { x: 60, y: 60, size: 'small', owner: 1, garrison: 0 },
      { x: 600, y: 400, size: 'large', owner: 0, garrison: 0 },
    ]);
    const p = w.planets[1];
    const units = Array.from({ length: 20 }, (_, i) => w.spawnAt(1, 300 + (i % 5) * 5, 300 + Math.floor(i / 5) * 5, false));
    order(w, units, { kind: 'move', x: 600, y: 300, formation: 'cluster' });
    step(w, 4);
    order(w, units, { kind: 'move', x: 600, y: 560, formation: 'spread' });
    let entered = false;
    step(w, 15, () => {
      if (units.some((u) => Math.hypot(u.x - p.x, u.y - p.y) <= p.atmosphereRadius)) entered = true;
    });
    expect(entered).toBe(false);
    expect(units.every((u) => u.state === 'hold')).toBe(true);
  });

  it('궤도 병력은 가속 · 선회 한계 안에서도 궤도를 매끄럽게 따라 돈다', () => {
    const w = makeWorld([{ x: 400, y: 400, size: 'large', owner: 1, garrison: 0 }]);
    const p = w.planets[0];
    const units = orbiters(w, 0, 30);
    let maxErr = 0;
    step(w, 10, () => {
      for (const u of units) {
        const r = p.radius + u.orbitAltitude;
        const gx = p.x + Math.cos(u.orbitAngle) * r, gy = p.y + Math.sin(u.orbitAngle) * r;
        maxErr = Math.max(maxErr, Math.hypot(u.x - gx, u.y - gy));
      }
    });
    // 자리 잡은 뒤엔 궤도점에서 1px 도 벗어나지 않는다 (접선 속도를 앞질러 따라간다)
    expect(maxErr).toBeLessThan(1);
    expect(p.presence[1]).toBe(30);
    expect(p.orbitCount[1]).toBe(30);
  });
});

describe('무리 이동: 함께 출발해 함께 도착', () => {
  it('궤도에서 떼어 낸 무리는 한 줄로 늘어지지 않고 함께 도착한다', () => {
    const w = makeWorld([{ x: 200, y: 400, size: 'large', owner: 1, garrison: 0 }]);
    const army = orbiters(w, 0, 40);
    order(w, army, { kind: 'move', x: 900, y: 400, formation: 'cluster' });
    const arrived = new Map<number, number>();
    let halfway = 0;
    step(w, 20, () => {
      for (const u of army) if (!arrived.has(u.id) && u.state === 'hold') arrived.set(u.id, w.time);
      const xs = army.map((u) => u.x);
      if (!halfway && xs.reduce((a, b) => a + b, 0) / xs.length >= 550) halfway = Math.max(...xs) - Math.min(...xs);
    });
    const ts = [...arrived.values()];
    expect(ts).toHaveLength(40);
    // 예전(각자 최고 속도)에는 도착 시각이 2초 넘게 벌어지고 중간 지점에서 무리 길이가 ~100px 였다
    expect(Math.max(...ts) - Math.min(...ts)).toBeLessThanOrEqual(CONFIG.formation.arriveWindow + 0.1);
    expect(halfway).toBeLessThan(80);
  });

  it('아군 행성으로 합류하는 무리는 대기권에 거의 함께 들어선다', () => {
    const w = makeWorld([
      { x: 200, y: 400, size: 'large', owner: 1, garrison: 0 },
      { x: 700, y: 300, size: 'medium', owner: 1, garrison: 0 },
    ]);
    const p = w.planets[1];
    const army = orbiters(w, 0, 40);
    order(w, army, { kind: 'planet', planetId: p.id, formation: 'cluster' });
    const entered = new Map<number, number>();
    step(w, 15, () => {
      for (const u of army) if (!entered.has(u.id) && Math.hypot(u.x - p.x, u.y - p.y) <= p.atmosphereRadius) entered.set(u.id, w.time);
    });
    const ts = [...entered.values()];
    expect(ts).toHaveLength(40);
    expect(Math.max(...ts) - Math.min(...ts)).toBeLessThanOrEqual(CONFIG.formation.arriveWindow + 0.1);
    expect(army.every((u) => u.state === 'orbit' && u.planet === p.id)).toBe(true);
  });

  it('돌파는 보폭을 맞추지 않고 저마다 최고 속도로 들이친다 (두꺼운 수비대 앞에서 돌파가 포위를 이기지 않게)', () => {
    const w = makeWorld([
      { x: 200, y: 400, size: 'large', owner: 1, garrison: 0 },
      { x: 700, y: 300, size: 'medium', owner: 0, garrison: 0 },
    ]);
    const p = w.planets[1];
    const army = orbiters(w, 0, 40);
    order(w, army, { kind: 'planet', planetId: p.id, formation: 'cluster' });
    // 궤도에서 돌아 나와 가속을 마친 뒤(1.5초)엔 대기권에 닿기 전까지 모두 최고 속도
    step(w, 1.5);
    const outside = army.filter((u) => Math.hypot(u.x - p.x, u.y - p.y) > p.atmosphereRadius + 20);
    expect(outside.length).toBe(40);
    step(w, 1);
    for (const u of outside) expect(speedOf(u)).toBeCloseTo(CONFIG.unit.speed, 6);
  });

  it('멀리 떨어진 낙오병 하나 때문에 본대가 기어가지는 않는다 (minPace)', () => {
    const w = makeWorld([{ x: 60, y: 60, size: 'small', owner: 1, garrison: 0 }]);
    const body = Array.from({ length: 10 }, (_, i) => w.spawnAt(1, 500 + (i % 5) * 6, 400 + Math.floor(i / 5) * 6, false));
    const straggler = w.spawnAt(1, 100, 700, false);
    order(w, [...body, straggler], { kind: 'move', x: 700, y: 400, formation: 'cluster' });
    step(w, 2);
    for (const u of body) expect(speedOf(u)).toBeGreaterThanOrEqual(CONFIG.unit.speed * CONFIG.formation.minPace - 1e-6);
    expect(speedOf(straggler)).toBeCloseTo(CONFIG.unit.speed, 6);
  });
});

describe('겹침 풀기', () => {
  it('같은 곳에 두 번 보낸 무리도 한 점에 겹쳐 서지 않는다', () => {
    const w = makeWorld([{ x: 60, y: 60, size: 'small', owner: 1, garrison: 0 }]);
    const a = Array.from({ length: 25 }, (_, i) => w.spawnAt(1, 200 + (i % 5) * 6, 300 + Math.floor(i / 5) * 6, false));
    const b = Array.from({ length: 25 }, (_, i) => w.spawnAt(1, 200 + (i % 5) * 6, 500 + Math.floor(i / 5) * 6, false));
    order(w, a, { kind: 'move', x: 600, y: 400, formation: 'cluster' });
    order(w, b, { kind: 'move', x: 600, y: 400, formation: 'cluster' });
    step(w, 20);
    const all = [...a, ...b];
    expect(all.every((u) => u.state === 'hold')).toBe(true);
    let minGap = Infinity;
    for (let i = 0; i < all.length; i++) {
      for (let j = i + 1; j < all.length; j++) minGap = Math.min(minGap, Math.hypot(all[i].x - all[j].x, all[i].y - all[j].y));
    }
    expect(minGap).toBeGreaterThan(CONFIG.formation.separation * 0.9);
  });

  it('간격이 넉넉한 대형과 궤도는 건드리지 않는다', () => {
    const w = makeWorld([{ x: 900, y: 400, size: 'large', owner: 1, garrison: 0 }]);
    const army = Array.from({ length: 60 }, (_, i) => w.spawnAt(1, 200 + (i % 10) * 6, 300 + Math.floor(i / 10) * 6, false));
    order(w, army, { kind: 'move', x: 500, y: 400, formation: 'cluster' });
    step(w, 12);
    const slots = army.map((u) => [u.tx, u.ty]);
    step(w, 5);
    expect(army.map((u) => [u.tx, u.ty])).toEqual(slots);
  });

  it('한 자리에 겹쳐 생긴 궤도 병력은 대기권 안에서 흩어지고 수비대로 계속 센다', () => {
    const w = makeWorld([{ x: 400, y: 400, size: 'medium', owner: 1, garrison: 0 }]);
    const p = w.planets[0];
    const units = Array.from({ length: 20 }, () => w.spawnUnit(1, p, false));
    for (const u of units) {
      u.orbitAngle = 1;
      u.orbitAltitude = 10;
    }
    step(w, 15);
    let minGap = Infinity;
    for (let i = 0; i < units.length; i++) {
      for (let j = i + 1; j < units.length; j++) minGap = Math.min(minGap, Math.hypot(units[i].x - units[j].x, units[i].y - units[j].y));
    }
    expect(minGap).toBeGreaterThan(CONFIG.formation.separation * 0.8);
    for (const u of units) {
      expect(u.orbitAltitude).toBeGreaterThan(0);
      expect(u.orbitAltitude).toBeLessThan(CONFIG.atmosphere);
    }
    expect(p.presence[1]).toBe(20);
  });
});

describe('슬롯 배정', () => {
  const scatter = (w: World, n: number) =>
    Array.from({ length: n }, () => {
      const a = w.rng.range(0, Math.PI * 2), d = Math.sqrt(w.rng.next()) * 90;
      const cx = w.rng.next() < 0.6 ? 300 : 420;
      return w.spawnAt(1, cx + Math.cos(a) * d, 300 + (cx - 300) * 2 + Math.sin(a) * d, false);
    });

  it.each([
    ['집중 이동', { kind: 'move', x: 900, y: 250, formation: 'cluster' }],
    ['산개 이동', { kind: 'move', x: 900, y: 250, formation: 'spread' }],
    ['돌파', { kind: 'planet', planetId: 1, formation: 'cluster' }],
    ['포위', { kind: 'planet', planetId: 1, formation: 'spread' }],
  ] as [string, Order][])('흩어진 무리의 %s 경로가 서로 엇갈리지 않는다', (_, o) => {
    const w = makeWorld([
      { x: 60, y: 60, size: 'small', owner: 1, garrison: 0 },
      { x: 950, y: 500, size: 'large', owner: 2, garrison: 0 },
    ]);
    const army = scatter(w, 80);
    const start = army.map((u) => [u.x, u.y]);
    order(w, army, o);
    w.step(DT);
    const segs = army.map((u, i) => [start[i], [u.tx, u.ty]]);
    let crossings = 0;
    for (let i = 0; i < segs.length; i++) {
      for (let j = i + 1; j < segs.length; j++) if (crosses(segs[i][0], segs[i][1], segs[j][0], segs[j][1])) crossings++;
    }
    // 예전 축 정렬 짝짓기는 같은 배치에서 수십~수백 쌍이 엇갈렸다
    expect(crossings).toBe(0);
  });

  it('같은 입력이면 같은 짝 (결정론)', () => {
    const assigned = () => {
      const w = makeWorld([
        { x: 60, y: 60, size: 'small', owner: 1, garrison: 0 },
        { x: 950, y: 500, size: 'large', owner: 2, garrison: 0 },
      ], 9);
      const army = scatter(w, 400);
      order(w, army, { kind: 'planet', planetId: 1, formation: 'cluster' });
      w.step(DT);
      return army.map((u) => `${u.tx},${u.ty}`);
    };
    expect(assigned()).toEqual(assigned());
  });
});

describe('사격: 동시 판정 · 헛사격 없음', () => {
  /** 사거리 안에서 맞붙은 두 병력, 둘 다 이번 틱에 쏘고 한 방이면 죽는다 */
  function duel(firstFaction: number): World {
    const w = makeWorld([{ x: 60, y: 60, size: 'small', owner: 1, garrison: 0 }]);
    const a = w.spawnAt(firstFaction, 500, 400, false);
    const b = w.spawnAt(3 - firstFaction, 510, 400, false);
    for (const u of [a, b]) {
      u.cooldown = 0;
      u.hp = CONFIG.unit.damage;
    }
    w.step(DT);
    return w;
  }

  it.each([1, 2])('같은 틱에 서로 쏘면 먼저 만들어진 쪽(%i)만 사는 일 없이 둘 다 맞는다', (first) => {
    const w = duel(first);
    expect(w.unitCount[1]).toBe(0);
    expect(w.unitCount[2]).toBe(0);
  });

  it('이미 죽을 만큼 맞은 표적은 건너뛰고 다음으로 가까운 적을 쏜다', () => {
    const w = makeWorld([{ x: 60, y: 60, size: 'small', owner: 1, garrison: 0 }]);
    const near = w.spawnAt(2, 510, 400, false);
    const far = w.spawnAt(2, 520, 400, false);
    near.hp = far.hp = 2 * CONFIG.unit.damage;
    for (const u of [near, far]) u.cooldown = 10;
    const shooters = Array.from({ length: 4 }, (_, i) => w.spawnAt(1, 500, 396 + i * 2, false));
    for (const s of shooters) s.cooldown = 0;
    w.step(DT);
    const shots = w.events.filter((e) => e.type === 'shot' && e.faction === 1);
    expect(shots).toHaveLength(4);
    // 2 발이면 가까운 표적이 죽으므로 나머지 2 발은 먼 표적에게
    expect(shots.filter((e) => e.type === 'shot' && e.x2 === 510)).toHaveLength(2);
    expect(shots.filter((e) => e.type === 'shot' && e.x2 === 520)).toHaveLength(2);
    expect(near.alive || far.alive).toBe(false);
  });

  it('위치 규칙은 그대로: 적 대기권 안에서는 가까운 적 병력 대신 행성을 쏜다', () => {
    const w = makeWorld([
      { x: 60, y: 60, size: 'small', owner: 1, garrison: 0 },
      { x: 600, y: 400, size: 'medium', owner: 2, garrison: 0 },
    ]);
    const p = w.planets[1];
    const enemy = w.spawnAt(2, 600, 400 - p.radius - 12, false);
    enemy.cooldown = 10;
    const diver = w.spawnAt(1, 600, 400 - p.radius - 8, false);
    diver.cooldown = 0;
    w.step(DT);
    expect(enemy.hp).toBe(CONFIG.unit.hp);
    expect(p.defense).toBeLessThan(p.maxDefense);
  });
});

describe('결정론', () => {
  it('같은 시드와 명령이면 조향 · 무리 · 겹침 풀기까지 똑같이 움직인다', () => {
    const run = () => {
      const w = makeWorld([
        { x: 200, y: 400, size: 'large', owner: 1, garrison: 60 },
        { x: 800, y: 300, size: 'medium', owner: 0 },
      ], 4);
      w.planets[0].production = 1;
      const sig: number[] = [];
      for (let k = 0; k < 6; k++) {
        const mine = w.units.filter((u) => u.faction === 1);
        const o: Order = k % 3 === 0
          ? { kind: 'move', x: 500 + k * 20, y: 300, formation: k % 2 ? 'spread' : 'cluster' }
          : k % 3 === 1 ? { kind: 'planet', planetId: 1, formation: 'spread' } : { kind: 'return' };
        order(w, mine.slice(0, Math.ceil(mine.length * 0.7)), o);
        step(w, 3);
        sig.push(w.units.reduce((h, u) => (h * 31 + Math.round(u.x * 100) + Math.round(u.y * 100) * 7) >>> 0, 0));
      }
      return sig;
    };
    expect(run()).toEqual(run());
  });
});

describe('우회: 대기권 바로 바깥 슬롯', () => {
  it('목적지가 남의 대기권 경계 0~0.5px 바깥이어도 우회 지점만 쫓으며 맴돌지 않고 도착한다', () => {
    const c = CONFIG.formation.clusterSpacing / Math.sqrt(Math.PI);
    const slotOffset = c * Math.sqrt(0.5); // 한 기짜리 집중 대형의 첫 슬롯은 목표에서 +x 쪽으로 이만큼
    const stuck: string[] = [];
    for (const gap of [0.05, 0.2, 0.45]) {
      for (const slotAngle of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) {
        for (const from of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) {
          const w = makeWorld([
            { x: 60, y: 60, size: 'small', owner: 1, garrison: 0 },
            { x: 600, y: 400, size: 'medium', owner: 0, garrison: 0 },
          ]);
          const p = w.planets[1];
          const r = p.atmosphereRadius + gap;
          const sx = p.x + Math.cos(slotAngle) * r, sy = p.y + Math.sin(slotAngle) * r;
          const u = w.spawnAt(1, p.x + Math.cos(from) * 260, p.y + Math.sin(from) * 260, false);
          order(w, [u], { kind: 'move', x: sx - slotOffset, y: sy, formation: 'cluster' });
          step(w, DT);
          // 시나리오 확인: 슬롯이 정말 문제의 띠 [대기권, 대기권 + 0.5) 안에 잡혔다
          expect(Math.hypot(u.tx - p.x, u.ty - p.y) - p.atmosphereRadius).toBeCloseTo(gap, 1);
          step(w, 20);
          if (u.state !== 'hold') stuck.push(`gap ${gap} slot ${slotAngle.toFixed(2)} from ${from.toFixed(2)}`);
          // 우회하느라 대기권에 들어가 행성을 치지도 않는다
          expect(p.defense).toBe(p.maxDefense);
        }
      }
    }
    expect(stuck).toEqual([]);
  });
});
