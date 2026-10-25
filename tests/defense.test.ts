import { describe, expect, it } from 'vitest';
import { CONFIG, DEFENSE } from '../src/config';
import { generateDefenseMap } from '../src/sim/mapgen';
import { Match } from '../src/sim/match';
import { PLAYER, type GameEvent, type WarpGate } from '../src/sim/types';
import { INVADER, gatesForWave, waveSchedule, waveSize } from '../src/sim/waves';

const DT = 1 / CONFIG.tickRate;

function defense(seed = 7, autoplay = false) {
  return new Match({ aiCount: 1, difficulty: 'normal', seed, mode: 'defense', autoplay });
}

/** t 초까지 진행하며 발생한 이벤트를 모은다 */
function runUntil(m: Match, t: number, events: GameEvent[] = []): GameEvent[] {
  while (m.world.time < t && m.world.winner === null) {
    m.step();
    events.push(...m.world.events);
    m.world.events = [];
  }
  return events;
}

const invaders = (m: Match) => m.world.units.filter((u) => u.faction === INVADER);

describe('방어전 · 맵', () => {
  it('모성이 가운데, 중립 행성 10~14개가 겹치지 않게 놓이고 시드가 같으면 같은 맵', () => {
    for (const seed of [1, 2, 3, 42, 777]) {
      const init = generateDefenseMap({ seed });
      expect(init).toEqual(generateDefenseMap({ seed }));
      const home = init.planets.filter((p) => p.isHome);
      expect(home).toHaveLength(1);
      expect(home[0]).toMatchObject({ owner: PLAYER, size: 'large' });
      expect(Math.abs(home[0].x - init.width / 2)).toBeLessThan(60);
      expect(Math.abs(home[0].y - init.height / 2)).toBeLessThan(60);
      const neutrals = init.planets.filter((p) => p.owner === 0);
      expect(neutrals.length).toBeGreaterThanOrEqual(10);
      expect(neutrals.length).toBeLessThanOrEqual(14);
      for (const a of init.planets) {
        const r = CONFIG.planet[a.size].radius;
        expect(a.x).toBeGreaterThan(r + 40);
        expect(a.y).toBeGreaterThan(r + 40);
        for (const b of init.planets) {
          if (a === b) continue;
          const gap = Math.hypot(a.x - b.x, a.y - b.y);
          expect(gap).toBeGreaterThan(r + CONFIG.planet[b.size].radius + CONFIG.atmosphere * 2);
        }
      }
    }
  });

  it('모성 가까이엔 소형, 침공군이 오는 가장자리 쪽엔 중·대형이 놓인다 (위험/보상)', () => {
    for (const seed of [11, 12, 13]) {
      const init = generateDefenseMap({ seed });
      const home = init.planets.find((p) => p.isHome)!;
      const d = (p: { x: number; y: number }) => Math.hypot(p.x - home.x, p.y - home.y);
      const edge = (p: { x: number; y: number }) => Math.min(p.x, p.y, init.width - p.x, init.height - p.y);
      const neutrals = init.planets.filter((p) => p.owner === 0).sort((a, b) => d(a) - d(b));
      expect(neutrals.slice(0, 3).every((p) => p.size === 'small')).toBe(true);
      const avgEdge = (list: typeof neutrals) => list.reduce((s, p) => s + edge(p), 0) / list.length;
      const big = neutrals.filter((p) => p.size !== 'small');
      expect(big.length).toBeGreaterThanOrEqual(4);
      expect(avgEdge(big)).toBeLessThan(avgEdge(neutrals.filter((p) => p.size === 'small')));
    }
  });

  it('세로 화면이면 맵을 세로로 길게 만든다', () => {
    const init = generateDefenseMap({ seed: 5, portrait: true });
    expect(init.height).toBeGreaterThan(init.width);
  });
});

describe('방어전 · 웨이브 일정', () => {
  it('첫 웨이브는 30초에 예고, 42초에 출현하고 이후 간격이 조금씩 줄어든다', () => {
    const s = waveSchedule('normal');
    expect(s).toHaveLength(DEFENSE.totalWaves);
    expect(s[0]).toMatchObject({ wave: 1, warnAt: 30, spawnAt: 42 });
    for (let i = 1; i < s.length; i++) {
      const gap = s[i].spawnAt - s[i - 1].spawnAt;
      expect(gap).toBeGreaterThanOrEqual(DEFENSE.minInterval);
      expect(gap).toBeLessThanOrEqual(DEFENSE.interval);
      expect(s[i].warnAt).toBe(s[i].spawnAt - DEFENSE.warningLead);
      expect(s[i].size).toBeGreaterThan(s[i - 1].size);
    }
    expect([1, 3, 4, 8, 9, 12].map(gatesForWave)).toEqual([1, 1, 2, 2, 3, 3]);
    expect(waveSize(5, 'easy')).toBeLessThan(waveSize(5, 'normal'));
    expect(waveSize(5, 'hard')).toBeGreaterThan(waveSize(5, 'normal'));
  });

  it('예고 시각에 게이트가 열리고, 출현 시각부터 초당 warpRate 기씩 나와 다 나오면 닫힌다', () => {
    const m = defense();
    const spec = m.waves!.schedule[0];
    const before = runUntil(m, spec.warnAt - 0.5);
    expect(before.some((e) => e.type === 'wave')).toBe(false);
    expect(m.world.gates).toHaveLength(0);

    const warn = runUntil(m, spec.warnAt + DT * 2);
    expect(warn).toContainEqual({ type: 'wave', wave: 1, total: DEFENSE.totalWaves, phase: 'warning' });
    expect(m.world.gates).toHaveLength(spec.gates);
    const gate = m.world.gates[0];
    expect(gate).toMatchObject({ wave: 1, spawnAt: spec.spawnAt, opensAt: spec.spawnAt - DEFENSE.warningLead, count: spec.size, remaining: spec.size });
    expect(m.waves!.warned).toBe(true);
    expect(m.waves!.wave).toBe(0);

    // 출현 직전까지는 아무도 나오지 않는다
    runUntil(m, spec.spawnAt - 0.1);
    expect(invaders(m)).toHaveLength(0);

    const start = runUntil(m, spec.spawnAt + 1);
    expect(start).toContainEqual({ type: 'wave', wave: 1, total: DEFENSE.totalWaves, phase: 'start' });
    expect(m.waves!.wave).toBe(1);
    const warped = start.filter((e) => e.type === 'warp').length;
    expect(warped).toBeGreaterThanOrEqual(DEFENSE.warpRate);
    expect(warped).toBeLessThanOrEqual(DEFENSE.warpRate + 2);
    expect(gate.remaining).toBe(spec.size - warped);

    const rest = runUntil(m, spec.spawnAt + spec.size / DEFENSE.warpRate + 1);
    expect(warped + rest.filter((e) => e.type === 'warp').length).toBe(spec.size);
    expect(m.world.gates).toHaveLength(0);
    expect(m.world.factions[INVADER].stats.produced).toBe(spec.size);
  });

  it('게이트는 맵 경계 근처, 행성과 멀리, 서로 흩어져 열린다', () => {
    for (const seed of [3, 8, 21]) {
      const m = defense(seed);
      const w = m.world;
      // 웨이브마다 예고 시각으로 건너뛰어 막 열린 게이트를 모은다 (나온 병력은 바로 치운다)
      const opened: WarpGate[] = [];
      for (const spec of m.waves!.schedule) {
        w.time = spec.warnAt;
        m.waves!.update(w);
        const fresh = w.gates.filter((g) => g.wave === spec.wave);
        expect(fresh).toHaveLength(spec.gates);
        expect(fresh.reduce((s, g) => s + g.count, 0)).toBe(spec.size);
        opened.push(...fresh.map((g) => ({ ...g })));
        for (const u of invaders(m)) u.hp = 0;
        m.step();
      }
      for (const g of opened) {
        const edge = Math.min(g.x, g.y, w.width - g.x, w.height - g.y);
        expect(edge).toBeLessThanOrEqual(DEFENSE.gateInset[1] + 1);
        expect(edge).toBeGreaterThanOrEqual(DEFENSE.gateInset[0] - 1);
        for (const p of w.planets) expect(Math.hypot(p.x - g.x, p.y - g.y)).toBeGreaterThanOrEqual(DEFENSE.gateClearance);
      }
      const last = opened.filter((g) => g.wave === 12);
      expect(last).toHaveLength(3);
      for (const a of last) {
        for (const b of last) if (a !== b) expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThan(500);
      }
    }
  });
});

describe('방어전 · 침공군', () => {
  it('침공군은 행성이 없어도 고립되지 않고 탈락하지도 않는다', () => {
    const m = defense();
    runUntil(m, m.waves!.schedule[0].spawnAt + 3);
    const inv = invaders(m);
    expect(inv.length).toBeGreaterThan(0);
    expect(m.world.planetCount[INVADER]).toBe(0);
    expect(inv.every((u) => !u.isolated)).toBe(true);
    expect(m.world.factions[INVADER]).toMatchObject({ alive: true, invader: true, isAI: true, name: DEFENSE.invader.name });
  });

  it('다 나온 무리는 가장 가까운 아군 행성으로 향한다', () => {
    const m = defense();
    const spec = m.waves!.schedule[0];
    runUntil(m, spec.warnAt + 1);
    const gate = m.world.gates[0];
    const nearest = m.world.planets
      .filter((p) => p.owner === PLAYER)
      .sort((a, b) => Math.hypot(a.x - gate.x, a.y - gate.y) - Math.hypot(b.x - gate.x, b.y - gate.y))[0];
    runUntil(m, spec.spawnAt + spec.size / DEFENSE.warpRate + 2);
    const inv = invaders(m);
    expect(inv.length).toBe(spec.size);
    expect(inv.every((u) => u.state === 'move' && u.planet === nearest.id)).toBe(true);
    const dist = () => invaders(m).reduce((s, u) => s + Math.hypot(u.x - nearest.x, u.y - nearest.y), 0);
    const d0 = dist();
    runUntil(m, m.world.time + 3);
    expect(dist()).toBeLessThan(d0);
  });

  it('전장 병력 상한에 막혀도 게이트 앞에서 멈춰 있지 않고 모인 만큼 출격한다', () => {
    const m = defense();
    const w = m.world;
    const home = w.planets[m.waves!.homeId];
    while (w.units.length < DEFENSE.unitCap) w.spawnUnit(PLAYER, home, false);
    const spec = m.waves!.schedule[0];
    runUntil(m, spec.spawnAt + 2);
    expect(invaders(m)).toHaveLength(0);
    expect(m.world.gates).toHaveLength(1);

    // 플레이어 병력이 조금 줄면 그만큼만 나와서 곧바로 출격한다
    for (const u of w.units.filter((v) => v.faction === PLAYER).slice(0, 4)) u.hp = 0;
    runUntil(m, w.time + 0.5);
    const inv = invaders(m);
    expect(inv.length).toBeGreaterThan(0);
    expect(inv.length).toBeLessThan(spec.size);
    expect(inv.every((u) => u.state === 'move')).toBe(true);
  });

  it('침공군이 빼앗은 행성은 침공군 병력을 생산한다', () => {
    const m = defense();
    const w = m.world;
    const p = w.planets.find((q) => q.owner === 0 && q.size === 'small')!;
    w.capture(p, INVADER);
    runUntil(m, 10);
    expect(p.orbitCount[INVADER]).toBeGreaterThan(0);
  });
});

describe('방어전 · 승패', () => {
  it('모성을 빼앗기면 바로 패배한다 (승자 = 침공군)', () => {
    const m = defense();
    runUntil(m, 5);
    expect(m.world.winner).toBeNull();
    m.world.capture(m.world.planets[m.waves!.homeId], INVADER);
    m.step();
    expect(m.world.winner).toBe(INVADER);
  });

  it('모든 웨이브가 다 나오고 침공군이 전멸하면 승리, 그 전에는 끝나지 않는다', () => {
    const m = defense();
    const w = m.world;
    const d = m.waves!;
    while (!d.isFinished(w)) {
      // 시간을 건너뛰며 웨이브를 불러내고, 나온 침공군은 즉시 격추 처리한다
      w.time += 20;
      d.update(w);
      for (const u of invaders(m)) u.hp = 0;
      m.step();
      if (!d.isFinished(w)) expect(w.winner).toBeNull();
      w.events = [];
    }
    expect(d.wave).toBe(DEFENSE.totalWaves);
    expect(d.nextSpawnAt).toBeNull();
    m.step();
    expect(w.winner).toBe(PLAYER);
    expect(d.survived(w)).toBe(DEFENSE.totalWaves);
  });

  it('침공군 병력이 남아 있으면 마지막 웨이브 뒤에도 승리가 아니다', () => {
    const m = defense();
    const w = m.world;
    const d = m.waves!;
    while (!d.isFinished(w)) {
      w.time += 20;
      d.update(w);
      for (const u of invaders(m).slice(1)) u.hp = 0;
      m.step();
      w.events = [];
    }
    m.step();
    expect(w.unitCount[INVADER]).toBeGreaterThan(0);
    expect(w.winner).toBeNull();
  });
});

describe('방어전 · 결정론 · 정복전 영향 없음', () => {
  const signature = (m: Match) =>
    m.world.units.reduce((h, u) => (h * 31 + Math.round(u.x * 10) + Math.round(u.y * 10) * 7 + u.faction) >>> 0, 0);

  it('같은 시드는 같은 결과를 낸다', () => {
    const a = defense(99, true);
    const b = defense(99, true);
    for (let i = 0; i < CONFIG.tickRate * 150; i++) {
      a.step();
      b.step();
      a.world.events.length = 0;
      b.world.events.length = 0;
    }
    expect(a.waves!.wave).toBeGreaterThanOrEqual(3);
    expect(a.world.units.length).toBe(b.world.units.length);
    expect(signature(a)).toBe(signature(b));
    expect(a.world.planets.map((p) => p.owner)).toEqual(b.world.planets.map((p) => p.owner));
  });

  it('정복전은 웨이브도 게이트도 승패 훅도 없다', () => {
    const m = new Match({ aiCount: 2, difficulty: 'normal', seed: 4 });
    expect(m.mode).toBe('conquest');
    expect(m.waves).toBeNull();
    expect(m.world.winRule).toBeNull();
    for (let i = 0; i < CONFIG.tickRate * 50; i++) m.step();
    expect(m.world.gates).toHaveLength(0);
    expect(m.world.factions.every((f) => !f.invader)).toBe(true);
  });
});
