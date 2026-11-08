/**
 * 밸런스 측정 하네스 (기본으로는 건너뛴다). 수치를 바꾼 뒤 표를 다시 뽑을 때:
 *
 *   BALANCE=1 npx vitest run tests/balance.harness.test.ts --reporter=verbose            # 전부 (한 코어로 10분 남짓)
 *   BALANCE=conquest,aivai npx vitest run tests/balance.harness.test.ts --reporter=verbose
 *   BALANCE=conquest BALANCE_SEEDS=40 npx vitest run tests/balance.harness.test.ts --reporter=verbose
 *
 * (기본 리포터는 통과한 테스트의 콘솔 출력을 숨기므로 표를 보려면 --reporter=verbose)
 *
 * 묶음: conquest(스크립트 플레이어 vs AI) · passive(가만히 있는 플레이어가 처음 맞는 시각) · aivai(AI 끼리, 15분 안에 끝나나)
 *      · defense(방어전 자동 진행) · estimator(전투 추정기 vs 실제 공방) · perf(AI 판단 시간)
 * 결과는 표로 출력하고, 목표(docs/GAME_DESIGN.md §8)는 기록만 한다. 강하게 확인하는 건 AI 끼리 판이 15분 안에 끝나는지와
 * 1500 기에서 판단이 평균 1ms 를 넘지 않는지 두 가지 (나머지는 시드 표본에 따라 흔들리는 비율이라 표로 본다).
 */
import { describe, expect, it } from 'vitest';
import { CONFIG, type Difficulty, type PlanetSize } from '../src/config';
import { AIController, MOTION, chooseTactic, estimateBattle, type Tactic } from '../src/sim/ai';
import { Match } from '../src/sim/match';
import { NEUTRAL, PLAYER, type Planet, type Unit } from '../src/sim/types';
import { World } from '../src/sim/world';

// vitest 는 node 에서 돈다. 이 하네스가 읽는 환경 변수만 선언한다 (@types/node 를 들이지 않는다)
declare const process: { env: Record<string, string | undefined> };

const SUITES = (process.env.BALANCE ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const on = (name: string) => SUITES.includes('1') || SUITES.includes('all') || SUITES.includes(name);
const SEEDS = Number(process.env.BALANCE_SEEDS ?? 20);
const AA_SEEDS = Number(process.env.BALANCE_AA_SEEDS ?? 8);
const DEF_SEEDS = Number(process.env.BALANCE_DEF_SEEDS ?? 10);
const LIMIT = 900;
const LONG = 3_600_000;
const DIFFICULTIES: Difficulty[] = ['easy', 'normal', 'hard'];
const range = (n: number, from = 1) => Array.from({ length: n }, (_, i) => from + i);
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const D = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);

// ───────────────────────────── 스크립트 플레이어 ─────────────────────────────

type BotKind = 'simple' | 'smart' | 'passive';

/**
 * 플레이어 자리에 앉히는 스크립트 (지난 밸런스 작업의 conquest_bot 을 옮긴 것).
 *  simple : 3~4초마다 판단, 작전 하나, 돌파만 (중립 ~15기, 큰 곳은 수비대에 비례), 위협받는 행성엔 다른 행성 여유 병력을 부른다 — '단순한' 플레이어
 *  smart  : 1.5초마다, 작전 둘, 수비대 8 이상이면 포위 → 수비대가 줄면 돌파, 적 행성은 주변 적 병력까지 보고 전력 산정 — '꼼꼼한' 플레이어
 *  passive: 아무것도 안 한다
 */
class ScriptedPlayer {
  private next = 1;
  private ops: { pid: number; ids: number[]; at: number; staged: boolean }[] = [];
  private readonly react: number;
  private readonly smart: boolean;

  constructor(
    readonly kind: BotKind,
    seed: number,
  ) {
    this.smart = kind === 'smart';
    this.react = this.smart ? 1.5 : 3 + ((seed * 7) % 10) / 10;
  }

  update(w: World): void {
    if (this.kind === 'passive' || w.time < this.next) return;
    this.next = w.time + this.react;
    const KEEP = 3;
    const mine = w.planets.filter((p) => p.owner === PLAYER);
    const busy = new Set(this.ops.flatMap((o) => o.ids));
    const free = (p: Planet) =>
      w.units.filter((u) => u.faction === PLAYER && u.state === 'orbit' && u.planet === p.id && !busy.has(u.id) && !u.isolated);
    const send = (units: Unit[], planetId: number) => {
      if (units.length) w.enqueue({ faction: PLAYER, unitIds: units.map((u) => u.id), order: { kind: 'planet', planetId, formation: 'cluster' } });
    };
    const strays = w.units.filter((u) => u.faction === PLAYER && !busy.has(u.id) && (u.state === 'hold' || (u.isolated && u.state !== 'move')));
    if (strays.length) w.enqueue({ faction: PLAYER, unitIds: strays.map((u) => u.id), order: { kind: 'return' } });
    for (const p of mine) {
      const threat = w.units.filter((u) => u.faction > PLAYER && D(u, p) < p.atmosphereRadius + 80).length;
      if (threat > 0 && threat * 1.2 > p.orbitCount[PLAYER]) {
        for (const q of mine) if (q !== p && D(q, p) < 700) send(free(q).slice(KEEP), p.id);
      }
    }
    this.ops = this.ops.filter((op) => {
      op.ids = op.ids.filter((id) => w.getUnit(id));
      const p = w.planets[op.pid];
      if (p.owner === PLAYER || op.ids.length === 0) return false;
      if (op.staged) {
        const units = op.ids.map((id) => w.getUnit(id)!);
        const arrived = units.filter((u) => u.state === 'hold').length >= units.length * 0.7;
        if ((arrived && p.orbitCount[p.owner] <= Math.max(2, op.ids.length * 0.12)) || w.time - op.at > 25) {
          send(units, p.id);
          op.staged = false;
          op.at = w.time;
        }
        return true;
      }
      if (w.time - op.at > 45) {
        w.enqueue({ faction: PLAYER, unitIds: op.ids, order: { kind: 'return' } });
        return false;
      }
      return true;
    });
    if (this.ops.length >= (this.smart ? 2 : 1) || mine.length === 0) return;
    const pool = mine.flatMap((p) => free(p).slice(p.isHome ? 6 : KEEP));
    const c = w.planets
      .filter((p) => p.owner !== PLAYER && !this.ops.some((o) => o.pid === p.id))
      .map((p) => {
        const g = w.units.filter((u) => u.faction !== PLAYER && D(u, p) < p.atmosphereRadius + 10).length;
        const near = this.smart && p.owner !== NEUTRAL ? w.units.filter((u) => u.faction === p.owner && D(u, p) < 300).length - g : 0;
        const need =
          p.owner === NEUTRAL ? Math.max(15, Math.ceil(g * 2.2 + 4)) : Math.max(20, Math.ceil((g + near * 0.5) * 2 + p.defense / 8 + 6));
        return { p, g, need, d: Math.min(...mine.map((q) => D(q, p))) };
      })
      .filter((x) => x.need <= pool.length)
      .sort((a, b) => a.d - b.d)[0];
    if (!c) return;
    pool.sort((a, b) => D(a, c.p) - D(b, c.p));
    const force = pool.slice(0, c.need);
    const staged = this.smart && c.g >= 8;
    if (staged) w.enqueue({ faction: PLAYER, unitIds: force.map((u) => u.id), order: { kind: 'planet', planetId: c.p.id, formation: 'spread' } });
    else send(force, c.p.id);
    this.ops.push({ pid: c.p.id, ids: force.map((u) => u.id), at: w.time, staged });
  }
}

interface GameResult {
  winner: number | null;
  time: number;
  /** AI 첫 중립 점령 시각 (−1 = 없음) */
  aiFirstCapture: number;
  /** 플레이어 행성이 처음 공격받은 시각 (−1 = 없음) */
  firstHit: number;
}

/** 스크립트 플레이어 vs AI 한 판 (passive 는 처음 맞을 때까지만) */
function playConquest(kind: BotKind, difficulty: Difficulty, seed: number): GameResult {
  const m = new Match({ aiCount: 1, difficulty, seed });
  const w = m.world;
  const bot = new ScriptedPlayer(kind, seed);
  let aiFirstCapture = -1, firstHit = -1;
  while (w.winner === null && w.time < LIMIT && w.factions[PLAYER].alive) {
    bot.update(w);
    m.step();
    for (const e of w.events) if (e.type === 'capture' && e.from === NEUTRAL && e.to > PLAYER && aiFirstCapture < 0) aiFirstCapture = w.time;
    w.events.length = 0;
    if (firstHit < 0 && w.planets.some((p) => p.owner === PLAYER && p.lastAssaultBy > PLAYER && p.lastAssaultAt > 0)) {
      firstHit = w.time;
      if (kind === 'passive') break;
    }
  }
  const winner = w.winner ?? (w.factions[PLAYER].alive ? null : -1);
  return { winner, time: w.time, aiFirstCapture, firstHit };
}

function playAIvAI(difficulty: Difficulty, aiCount: number, seed: number): GameResult {
  const m = new Match({ aiCount, difficulty, seed, autoplay: true });
  const w = m.world;
  let first = -1;
  while (w.winner === null && w.time < LIMIT) {
    m.step();
    if (first < 0) for (const e of w.events) if (e.type === 'capture' && e.from === NEUTRAL) first = w.time;
    w.events.length = 0;
  }
  return { winner: w.winner, time: w.time, aiFirstCapture: first, firstHit: -1 };
}

// ───────────────────────────── 묶음 ─────────────────────────────

describe.skipIf(!on('conquest'))('밸런스 · 스크립트 플레이어 vs AI (1:1)', () => {
  it('플레이어 승 / AI 승 / 미결 (15분)', () => {
    const rows: string[] = [];
    for (const kind of ['simple', 'smart'] as const) {
      for (const difficulty of DIFFICULTIES) {
        const games = range(SEEDS).map((seed) => playConquest(kind, difficulty, seed));
        const player = games.filter((g) => g.winner === PLAYER).length;
        const unresolved = games.filter((g) => g.winner === null).length;
        rows.push(
          `| ${kind} | ${difficulty} | ${player} | ${games.length - player - unresolved} | ${unresolved} | ` +
            `${median(games.map((g) => g.aiFirstCapture)).toFixed(0)}초 |`,
        );
      }
    }
    console.info(['| 플레이어 | AI | 플레이어 승 | AI 승 | 미결 | AI 첫 점령(중앙값) |', '|---|---|---:|---:|---:|---:|', ...rows].join('\n'));
  }, LONG);
});

describe.skipIf(!on('passive'))('밸런스 · 가만히 있는 플레이어', () => {
  it('AI 가 처음 플레이어 행성을 치는 시각', () => {
    const rows = DIFFICULTIES.map((difficulty) => {
      const hits = range(SEEDS).map((seed) => playConquest('passive', difficulty, seed).firstHit);
      return `| ${difficulty} | ${Math.min(...hits).toFixed(0)}초 | ${median(hits).toFixed(0)}초 |`;
    });
    console.info(['| AI | 첫 공격 최소 | 중앙값 |', '|---|---:|---:|', ...rows].join('\n'));
  }, LONG);
});

describe.skipIf(!on('aivai'))('밸런스 · AI 끼리', () => {
  it('난이도 × AI 1~3 × 시드: 모두 15분 안에 끝난다', () => {
    const rows: string[] = [];
    let unresolved = 0;
    for (const difficulty of DIFFICULTIES) {
      for (const aiCount of [1, 2, 3]) {
        const games = range(AA_SEEDS).map((seed) => playAIvAI(difficulty, aiCount, seed));
        const open = games.filter((g) => g.winner === null).length;
        unresolved += open;
        const times = games.map((g) => g.time);
        rows.push(`| ${difficulty} | ${aiCount + 1} | ${Math.min(...times).toFixed(0)}~${Math.max(...times).toFixed(0)}초 | ${open} | ${median(games.map((g) => g.aiFirstCapture)).toFixed(0)}초 |`);
      }
    }
    console.info(['| 난이도 | 진영 | 걸린 시간 | 미결 | 첫 점령(중앙값) |', '|---|---:|---|---:|---:|', ...rows].join('\n'));
    expect(unresolved).toBe(0);
  }, LONG);
});

describe.skipIf(!on('defense'))('밸런스 · 방어전 자동 진행', () => {
  it('난이도별 승리 / 버틴 웨이브 (docs §4.7 의 자동 진행 AI 열)', () => {
    const rows = DIFFICULTIES.map((difficulty) => {
      let wins = 0;
      const waves: number[] = [];
      for (const seed of range(DEF_SEEDS)) {
        const m = new Match({ aiCount: 1, difficulty, seed, mode: 'defense', autoplay: true });
        while (m.world.winner === null && m.world.time < 1100) {
          m.step();
          m.world.events.length = 0;
        }
        if (m.world.winner === PLAYER) wins++;
        waves.push(m.waves!.survived(m.world));
      }
      return `| ${difficulty} | ${wins}/${DEF_SEEDS} | ${Math.min(...waves)}~${Math.max(...waves)} |`;
    });
    console.info(['| 난이도 | 승리 | 버틴 웨이브 |', '|---|---:|---|', ...rows].join('\n'));
  }, LONG);
});

/** 실제 공방 (tests/ai.test.ts 의 realBattle 과 같은 규칙, 거리 dist) */
function realBattle(size: PlanetSize, owner: 0 | 2, N: number, G: number, defFrac: number, tactic: Tactic, distance: number) {
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
  t.defense = t.maxDefense * defFrac;
  const cols = Math.ceil(Math.sqrt(N));
  const ids = range(N, 0).map((i) => w.spawnAt(1, 700 - distance - (i % cols) * 5, 400 + (Math.floor(i / cols) - cols / 2) * 5, false).id);
  w.enqueue({ faction: 1, unitIds: ids, order: { kind: 'planet', planetId: 1, formation: tactic === 'dive' ? 'cluster' : 'spread' } });
  let dived = tactic === 'dive';
  let capturedAt = -1;
  while (w.time < 120) {
    w.step();
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

describe.skipIf(!on('estimator'))('밸런스 · 전투 추정기 vs 실제', () => {
  it('크기 × 중립/적 × 공격 × 수비 × 방어도 × 거리 격자에서 성패 · 전술 일치율', () => {
    let succ = 0, succN = 0, rank = 0, decisive = 0, decisiveOk = 0, cases = 0, lossErr = 0, timeErr = 0, both = 0;
    for (const size of ['small', 'medium', 'large'] as const) {
      const spec = CONFIG.planet[size];
      for (const owner of [0, 2] as const) {
        for (const defFrac of [1, 0.4]) {
          for (const distance of [140, 240]) {
            for (const N of [8, 15, 25, 40, 60, 90, 130]) {
              for (const G of [0, 4, 10, 20, 35, 55]) {
                if (G > N * 1.6 + 5 || (G > spec.capacity && G > 30)) continue;
                const inp = {
                  attackers: N, defenders: G, radius: spec.radius, defense: spec.maxDefense * defFrac, maxDefense: spec.maxDefense,
                  regen: spec.maxDefense * CONFIG.regenRate, production: owner === 0 ? 0 : spec.production, capacity: spec.capacity,
                  // 멈춰 선 무리가 출발하므로 가속 지연(MOTION.startLag)까지 (AI 가 추정기에 넣는 이동 시간과 같게)
                  travel: Math.max(0, (distance - spec.radius - CONFIG.atmosphere) / CONFIG.unit.speed) + MOTION.startLag,
                };
                const lambda = 0.3 + inp.production;
                const real = { dive: realBattle(size, owner, N, G, defFrac, 'dive', distance), siege: realBattle(size, owner, N, G, defFrac, 'siege', distance) };
                for (const t of ['dive', 'siege'] as const) {
                  const e = estimateBattle(inp, t);
                  succN++;
                  if (e.success === real[t].captured) succ++;
                  if (e.success && real[t].captured) {
                    both++;
                    lossErr += Math.abs(e.losses - real[t].lost);
                    timeErr += Math.abs(e.time - real[t].time);
                  }
                }
                const cost = (r: { captured: boolean; time: number; lost: number }) => (r.captured ? r.lost + lambda * r.time : Infinity);
                const cd = cost(real.dive), cs = cost(real.siege);
                const truth = cd === Infinity && cs === Infinity ? 'wait' : cd <= cs ? 'dive' : 'siege';
                const guess = chooseTactic(inp, true, lambda).tactic;
                cases++;
                if (truth === guess) rank++;
                // '결정적' = 실측 비용이 3 이상 갈리거나 한쪽만 성공하는 판 (거의 비긴 판은 어느 쪽을 골라도 괜찮다)
                if (truth === 'wait' || cd === Infinity || cs === Infinity || Math.abs(cd - cs) >= 3) {
                  decisive++;
                  if (truth === guess) decisiveOk++;
                }
              }
            }
          }
        }
      }
    }
    const pct = (a: number, b: number) => `${((a / b) * 100).toFixed(1)}% (${a}/${b})`;
    console.info(
      `추정기 vs 실제 ${cases}판 × 2전술: 성패 ${pct(succ, succN)}, 전술 ${pct(rank, cases)}, 결정적인 판의 전술 ${pct(decisiveOk, decisive)}, ` +
        `둘 다 점령한 ${both}건의 손실 오차 평균 ${(lossErr / both).toFixed(2)}기 · 시간 오차 평균 ${(timeErr / both).toFixed(2)}초`,
    );
    expect(succ / succN).toBeGreaterThan(0.9);
  }, LONG);
});

describe.skipIf(!on('perf'))('밸런스 · AI 판단 시간', () => {
  it('4인 판에 1500 기를 채운 난전에서 think() 평균이 1ms 아래', () => {
    const proto = AIController.prototype as unknown as { think: (w: World) => void };
    const think = proto.think;
    const rows: string[] = [];
    try {
      for (const difficulty of DIFFICULTIES) {
        const samples: number[] = [];
        proto.think = function (this: AIController, w: World) {
          const t0 = performance.now();
          think.call(this, w);
          samples.push(performance.now() - t0);
        };
        const m = new Match({ aiCount: 3, difficulty, seed: 3, autoplay: true });
        const w = m.world;
        while (w.time < 60) {
          m.step();
          w.events.length = 0;
        }
        // 각 진영 행성 궤도와 맵 가운데 우주 공간에 병력을 채운다
        for (let i = 0; w.units.length < 1500; i++) {
          const p = w.planets[i % w.planets.length];
          if (p.owner !== NEUTRAL) w.spawnUnit(p.owner, p, false);
          else {
            const a = (i * 2.4) % (Math.PI * 2);
            w.spawnAt(1 + (i % 4), w.width / 2 + Math.cos(a) * 300 + (i % 7) * 4, w.height / 2 + Math.sin(a) * 200 + (i % 5) * 4, false);
          }
        }
        samples.length = 0;
        const units = w.units.length;
        const end = w.time + 20;
        while (w.time < end && w.winner === null) {
          m.step();
          w.events.length = 0;
        }
        const avg = samples.reduce((s, x) => s + x, 0) / samples.length;
        rows.push(`| ${difficulty} | ${units}→${w.units.length} | ${samples.length} | ${avg.toFixed(3)}ms | ${Math.max(...samples).toFixed(2)}ms |`);
        expect(avg).toBeLessThan(1);
      }
    } finally {
      proto.think = think;
    }
    console.info(['| 난이도 | 유닛 | 판단 수 | 평균 | 최대 |', '|---|---|---:|---:|---:|', ...rows].join('\n'));
  }, LONG);
});
