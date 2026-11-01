import { describe, expect, it } from 'vitest';
import { Match } from '../src/sim/match';
import type { Order } from '../src/sim/types';
import { World } from '../src/sim/world';

describe('정복전 · 플레이어 탈락', () => {
  function eliminatePlayer(m: Match): void {
    for (const p of m.world.planets) if (p.owner === 1) m.world.capture(p, 2);
    for (const u of m.world.units) if (u.faction === 1) u.hp = 0;
    m.step();
  }

  it.each([2, 3])('적이 %i명 남아도 플레이어 전멸 즉시 판이 끝나고 시간은 멈춘다', (aiCount) => {
    const m = new Match({ aiCount, difficulty: 'normal', seed: 42 });
    eliminatePlayer(m);
    expect(m.world.factions[1].alive).toBe(false);
    // 다른 AI 의 승자를 임의로 정하지 않는다.
    expect(m.world.winner).toBeNull();
    const tick = m.world.tick;
    m.step();
    expect(m.world.tick).toBe(tick);
  });

  it('자동 관전에서는 1번 진영이 탈락해도 남은 AI 의 경기가 계속된다', () => {
    const m = new Match({ aiCount: 2, difficulty: 'normal', seed: 42, autoplay: true });
    eliminatePlayer(m);
    const tick = m.world.tick;
    m.step();
    expect(m.world.tick).toBe(tick + 1);
  });
});

describe('점령 · 전투 후 생존 병력', () => {
  function battle(withSurvivor: boolean): World {
    const w = new World({
      width: 1000, height: 600, seed: 1, factionCount: 3, aiFactions: [],
      planets: [
        { x: 500, y: 300, size: 'small', owner: 1, garrison: 0 },
        { x: 100, y: 100, size: 'small', owner: 2, garrison: 0 },
        { x: 900, y: 500, size: 'small', owner: 3, garrison: 0 },
      ],
    });
    for (const p of w.planets) p.production = 0;
    // 먼저 행성에 사격하지만 같은 틱에 수비대에게 격추되는 공격군.
    for (let i = 0; i < 2; i++) {
      const u = w.spawnAt(2, 500 + i * 2, 325, false);
      u.hp = 0.5;
      u.cooldown = 0;
    }
    if (withSurvivor) w.spawnAt(3, 503, 325, false).cooldown = 0;
    for (let i = 0; i < 2; i++) w.spawnAt(1, 500 + i * 2, 326, false).cooldown = 0;
    w.planets[0].defense = 0.1;
    w.step();
    return w;
  }

  it('전멸한 다수 공격군 대신 살아남은 공격군이 점령한다', () => {
    const w = battle(true);
    expect(w.unitCount[2]).toBe(0);
    expect(w.unitCount[3]).toBe(1);
    expect(w.planets[0].owner).toBe(3);
  });

  it('공격군이 모두 전멸했으면 이전 소유권을 유지한다', () => {
    const w = battle(false);
    expect(w.unitCount[2]).toBe(0);
    expect(w.planets[0].owner).toBe(1);
    expect(w.planets[0].defense).toBeGreaterThan(0);
    expect(w.events.some((e) => e.type === 'capture')).toBe(false);
  });
});

describe('이동 대형 · 맵 경계', () => {
  const orders: Order[] = [
    ...[[0, 0], [1000, 0], [0, 600], [1000, 600]].map(([x, y]): Order => ({ kind: 'move', x, y, formation: 'cluster' })),
    { kind: 'line', x1: 0, y1: 0, x2: 0, y2: 0 },
    { kind: 'line', x1: 998, y1: 600, x2: 1000, y2: 600 },
  ];

  it.each(orders)('모서리 명령 %# 도 병력을 겹치거나 맵 밖으로 보내지 않는다', (order) => {
    const w = new World({
      width: 1000, height: 600, seed: 1, factionCount: 2, aiFactions: [],
      planets: [
        { x: 100, y: 100, size: 'small', owner: 1, garrison: 0 },
        { x: 900, y: 500, size: 'small', owner: 2, garrison: 0 },
      ],
    });
    for (const p of w.planets) p.production = 0;
    const units = Array.from({ length: 80 }, (_, i) => w.spawnAt(1, 450 + i % 8, 300 + Math.floor(i / 8), false));
    w.enqueue({ faction: 1, unitIds: units.map((u) => u.id), order });
    w.step();
    for (const u of units) {
      expect(u.tx).toBeGreaterThanOrEqual(0);
      expect(u.tx).toBeLessThanOrEqual(w.width);
      expect(u.ty).toBeGreaterThanOrEqual(0);
      expect(u.ty).toBeLessThanOrEqual(w.height);
    }
    expect(new Set(units.map((u) => `${u.tx},${u.ty}`)).size).toBe(units.length);
    for (let i = 0; i < 600; i++) { w.step(); w.events.length = 0; }
    expect(units.every((u) => u.state === 'hold' && u.x >= 0 && u.x <= w.width && u.y >= 0 && u.y <= w.height)).toBe(true);
  });
});
