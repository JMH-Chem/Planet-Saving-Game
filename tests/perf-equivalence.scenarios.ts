/**
 * 성능 최적화 동치성 검사용 시나리오 (tests/perf-equivalence.test.ts).
 * 같은 시드 · 같은 명령이면 시뮬레이션 결과가 비트 단위로 같아야 한다: 병력 위치 · 체력 · 상태, 행성 소유 · 방어도, 이벤트.
 * 기대 해시(tests/fixtures/perf-equivalence.json)는 최적화 전 코드(b6f5def)에서 이 파일을 그대로 돌려 기록했다.
 */
import { Match, type MatchSettings } from '../src/sim/match';
import type { GameEvent } from '../src/sim/types';
import { World } from '../src/sim/world';

const f64 = new Float64Array(1);
const u32 = new Uint32Array(f64.buffer);

/** FNV-1a 32비트 (숫자는 float64 비트 그대로) */
class Hasher {
  h = 0x811c9dc5;
  int(v: number): void {
    this.h = Math.imul(this.h ^ (v | 0), 0x01000193) >>> 0;
  }
  num(v: number): void {
    f64[0] = v;
    this.int(u32[0]);
    this.int(u32[1]);
  }
  str(s: string): void {
    for (let i = 0; i < s.length; i++) this.int(s.charCodeAt(i));
  }
}

function hashEvents(h: Hasher, events: readonly GameEvent[]): void {
  h.int(events.length);
  for (const e of events) {
    h.str(e.type);
    for (const v of Object.values(e)) {
      if (typeof v === 'number') h.num(v);
      else if (typeof v === 'boolean') h.int(v ? 1 : 2);
      else if (typeof v === 'string') h.str(v);
    }
  }
}

function hashWorld(h: Hasher, w: World): void {
  h.num(w.time);
  h.int(w.tick);
  h.int(w.winner ?? -1);
  h.int(w.units.length);
  for (const u of w.units) {
    h.int(u.id);
    h.int(u.faction);
    h.num(u.x);
    h.num(u.y);
    h.num(u.px);
    h.num(u.py);
    h.num(u.hp);
    h.num(u.cooldown);
    h.str(u.state);
    h.int(u.planet);
    h.num(u.tx);
    h.num(u.ty);
    h.num(u.orbitAngle);
    h.num(u.orbitAltitude);
    h.int(u.isolated ? 1 : 0);
    h.int(u.inPlanet);
  }
  for (const p of w.planets) {
    h.int(p.owner);
    h.num(p.defense);
    h.num(p.prodProgress);
    h.num(p.lastAssaultAt);
    h.int(p.lastAssaultBy);
    for (const c of p.orbitCount) h.int(c);
    for (const c of p.presence) h.int(c);
  }
  for (const f of w.factions) {
    h.int(f.alive ? 1 : 0);
    h.int(f.stats.produced);
    h.int(f.stats.lost);
    h.int(f.stats.kills);
    h.int(f.stats.planetsCaptured);
  }
  for (const c of w.planetCount) h.int(c);
  for (const c of w.unitCount) h.int(c);
}

export interface ScenarioResult {
  /** 체크포인트(10초마다)의 누적 해시 */
  checkpoints: string[];
  maxUnits: number;
  ticks: number;
}

/** 이벤트는 틱마다 해시에 섞고 비운다 (브라우저의 렌더러가 하는 것과 같다) */
function drive(world: World, step: () => void, seconds: number): ScenarioResult {
  const h = new Hasher();
  const checkpoints: string[] = [];
  const ticks = Math.round(seconds * 30);
  let maxUnits = 0;
  for (let t = 1; t <= ticks; t++) {
    step();
    hashEvents(h, world.events);
    world.events.length = 0;
    maxUnits = Math.max(maxUnits, world.units.length);
    if (t % 300 === 0 || t === ticks) {
      const c = new Hasher();
      c.h = h.h;
      hashWorld(c, world);
      h.h = c.h;
      checkpoints.push(h.h.toString(16).padStart(8, '0'));
    }
  }
  return { checkpoints, maxUnits, ticks };
}

export function runMatch(settings: MatchSettings, seconds: number): ScenarioResult {
  const m = new Match(settings);
  return drive(m.world, () => m.step(), seconds);
}

/**
 * 대군 난전: 세 진영이 맵 가운데로 몰려 맞붙는다 (공간 격자 · 행성 집계에 병력 수천 기가 걸린다).
 * 고정 명령만 쓰므로 AI 와 무관하게 격자 질의 순서 · 집계가 결과를 좌우한다.
 */
export function makeMelee(perFaction: number, seed: number): World {
  const w = new World({
    width: 2400, height: 1600, seed, factionCount: 3, aiFactions: [],
    planets: [
      { x: 300, y: 300, size: 'large', owner: 1, garrison: 0 },
      { x: 2100, y: 300, size: 'large', owner: 2, garrison: 0 },
      { x: 1200, y: 1350, size: 'large', owner: 3, garrison: 0 },
      { x: 1200, y: 800, size: 'medium', owner: 0, garrison: 40 },
      { x: 800, y: 600, size: 'small', owner: 0, garrison: 10 },
      { x: 1600, y: 600, size: 'small', owner: 0, garrison: 10 },
      { x: 800, y: 1050, size: 'small', owner: 0, garrison: 10 },
      { x: 1600, y: 1050, size: 'small', owner: 0, garrison: 10 },
    ],
  });
  const anchors = [[0, 0], [500, 450], [1900, 450], [1200, 1150]];
  const cols = Math.ceil(Math.sqrt(perFaction));
  for (let f = 1; f <= 3; f++) {
    const [ax, ay] = anchors[f];
    const ids: number[] = [];
    for (let i = 0; i < perFaction; i++) {
      ids.push(w.spawnAt(f, ax + ((i % cols) - cols / 2) * 6, ay + (Math.floor(i / cols) - cols / 2) * 6, false).id);
    }
    // 절반은 가운데 행성으로 돌파, 절반은 맵 가운데 지점으로 이동 (서로 다른 명령 경로)
    const half = ids.length >> 1;
    w.enqueue({ faction: f, unitIds: ids.slice(0, half), order: { kind: 'planet', planetId: 3, formation: 'cluster' } });
    w.enqueue({ faction: f, unitIds: ids.slice(half), order: { kind: 'move', x: 1200, y: 800, formation: f === 2 ? 'spread' : 'cluster' } });
  }
  return w;
}

export function runMelee(perFaction: number, seed: number, seconds: number): ScenarioResult {
  const w = makeMelee(perFaction, seed);
  return drive(w, () => w.step(), seconds);
}

export interface ScenarioSpec {
  name: string;
  run: () => ScenarioResult;
}

export const SCENARIOS: ScenarioSpec[] = [
  { name: 'conquest-1ai-s1', run: () => runMatch({ aiCount: 1, difficulty: 'normal', seed: 1, autoplay: true }, 150) },
  { name: 'conquest-2ai-s7', run: () => runMatch({ aiCount: 2, difficulty: 'hard', seed: 7, autoplay: true }, 150) },
  { name: 'conquest-3ai-s3', run: () => runMatch({ aiCount: 3, difficulty: 'normal', seed: 3, autoplay: true }, 150) },
  { name: 'conquest-3ai-s11-portrait', run: () => runMatch({ aiCount: 3, difficulty: 'easy', seed: 11, autoplay: true, portrait: true }, 120) },
  { name: 'defense-s2', run: () => runMatch({ aiCount: 1, difficulty: 'normal', seed: 2, mode: 'defense', autoplay: true }, 150) },
  { name: 'defense-s5-hard', run: () => runMatch({ aiCount: 1, difficulty: 'hard', seed: 5, mode: 'defense', autoplay: true }, 120) },
  { name: 'melee-800x3-s9', run: () => runMelee(800, 9, 25) },
];
