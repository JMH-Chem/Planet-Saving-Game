import { describe, expect, it } from 'vitest';
import { parseQualityParam, QUALITY, QualityManager, type QualityLevel } from '../src/render/quality';

// 품질 관리자: 실제 프레임 간격의 평균으로 단계를 고르되, 오르내림이 깜빡이지 않게 내릴 땐 빠르게 · 올릴 땐 느리게.
// 단계를 바꾸는 것은 시험이라, 내려도 빨라지지 않으면(30Hz 화면 · 대화창 합성) 되돌아온다

/** ms 동안 일정한 프레임 간격(frame)과 그리기 시간(render)으로 흘린다. 바뀐 단계 기록을 돌려준다 */
function run(q: QualityManager, ms: number, frame: number, render: number): string[] {
  const changes: string[] = [];
  for (let t = 0; t < ms; t += frame) if (q.sample(frame, render)) changes.push(q.level);
  return changes;
}

/** 단계가 바뀔 때까지만 흘린다 (바뀌면 곧 프레임이 달라지는 실제 상황). 바뀐 단계 또는 null */
function untilChange(q: QualityManager, ms: number, frame: number, render: number): string | null {
  for (let t = 0; t < ms; t += frame) if (q.sample(frame, render)) return q.level;
  return null;
}

/** 기기 모형: 지금 단계에서의 프레임 간격 · 그리기 시간 (ms) */
type Device = (level: QualityLevel) => [frame: number, render: number];

/** 0~1 고른 난수 (시드 고정) */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 기기 모형대로 ms 동안 흘린다 (jitter = 프레임 간격의 ± 흔들림 ms). 바뀐 단계 기록과 단계별 머문 시간 */
function simulate(q: QualityManager, ms: number, device: Device, jitter = 0, seed = 1) {
  const rand = rng(seed);
  const changes: string[] = [];
  const time: Record<QualityLevel, number> = { low: 0, medium: 0, high: 0 };
  for (let t = 0; t < ms; ) {
    const [frame, render] = device(q.level);
    const f = frame + (rand() * 2 - 1) * jitter;
    time[q.level] += f;
    t += f;
    if (q.sample(f, render)) changes.push(q.level);
  }
  return { changes, time };
}

/** 30Hz 로 묶인 화면 (절전 모드 등): 어느 단계든 33ms, 그리기는 싸다 */
const capped30: Device = () => [33.3, 1.5];
/** GPU 가 병목: 그리기 명령(CPU)은 싸지만 단계를 낮추면 실제로 빨라진다 */
const gpuBound: Device = (l) => (l === 'high' ? [40, 4] : l === 'medium' ? [30, 3] : [20, 2]);
/** 그리기 자체가 무겁다: 낮추면 그리기도 프레임도 줄어든다 */
const heavy: Device = (l) => (l === 'high' ? [33, 20] : l === 'medium' ? [26, 14] : [17, 8]);

describe('품질 단계', () => {
  it('?quality= 로 고정 (모르는 값은 자동)', () => {
    expect(parseQualityParam('?play&quality=low')).toBe('low');
    expect(parseQualityParam('?quality=medium&debug')).toBe('medium');
    expect(parseQualityParam('?quality=high')).toBe('high');
    expect(parseQualityParam('?quality=ultra')).toBeNull();
    expect(parseQualityParam('')).toBeNull();
  });

  it('단계마다 비용이 줄어든다: 발광 해상도 상 > 중 > 끔, 입자 상 ≥ 중 ≥ 하', () => {
    expect(QUALITY.high.bloomScale).toBeGreaterThan(QUALITY.medium.bloomScale);
    expect(QUALITY.medium.bloomScale).toBeGreaterThan(0);
    expect(QUALITY.low.bloomScale).toBe(0);
    expect(QUALITY.low.territoryFill).toBe(false);
    expect(QUALITY.high.particles).toBeGreaterThanOrEqual(QUALITY.medium.particles);
    expect(QUALITY.medium.particles).toBeGreaterThanOrEqual(QUALITY.low.particles);
    expect(QUALITY.low.planetExtras).toBe(false);
  });

  it('60fps 로 잘 돌면 상에 머문다', () => {
    const q = new QualityManager();
    expect(run(q, 30000, 16.7, 4)).toEqual([]);
    expect(q.level).toBe('high');
  });

  it('그리기가 무거워 느리면(약 30fps) 2초쯤 버틴 뒤 한 단계씩 내리고, 빨라졌으니 그대로 둔다', () => {
    const q = new QualityManager();
    // 시작 2초는 판단하지 않는다 (텍스처 굽기)
    expect(simulate(q, 2000, heavy).changes).toEqual([]);
    expect(simulate(q, 3500, heavy).changes).toEqual(['medium']);
    // 중도 아직 느리다 (26ms): 시험(3초)이 끝난 뒤 다시 2초 → 하
    expect(simulate(q, 6000, heavy).changes).toEqual(['low']);
    // 하 아래로는 없고, 그리기가 8ms 라 다시 올리지도 않는다
    expect(simulate(q, 60000, heavy).changes).toEqual([]);
    expect(q.level).toBe('low');
  });

  it('30Hz 로 묶인 화면: 내려 봐도 빨라지지 않으니 되돌아오고, 한동안 다시 내려 보지 않는다', () => {
    const q = new QualityManager();
    const { changes, time } = simulate(q, 60000, capped30);
    expect(changes).toEqual(['medium', 'high']);
    expect(q.level).toBe('high');
    // 상이 아닌 시간은 시험 한 번(3초)뿐
    expect(time.medium).toBeLessThan(3500);
    expect(time.low).toBe(0);
  });

  it('앞서 하로 떨어진 30Hz 기기도 그리기에 여유가 있으면 간격이 18ms 밑으로 못 내려가도 상까지 다시 오른다', () => {
    const q = new QualityManager({ initial: 'low' });
    expect(simulate(q, 30000, capped30).changes).toEqual(['medium', 'high']);
    expect(q.level).toBe('high');
  });

  it('GPU 가 병목이면(그리기 명령은 싸도) 낮췄을 때 빨라지므로 내려가서 머문다', () => {
    const q = new QualityManager();
    const first = simulate(q, 15000, gpuBound);
    expect(first.changes).toEqual(['medium', 'low']);
    expect(q.settled).toBe('low');
    // 이후 10분: 가끔 중으로 올려 보지만(여유처럼 보이므로) 느려지니 곧 되돌아온다. 시간 대부분은 하
    const { changes, time } = simulate(q, 600000, gpuBound);
    expect(q.settled).toBe('low');
    expect(time.low / (time.low + time.medium + time.high)).toBeGreaterThan(0.95);
    expect(time.high).toBe(0);
    // 올려 볼 때마다 두 배씩 더 오래 참는다 (8 · 16 · 32 · 64 · 128 · 240초)
    expect(changes.length).toBeLessThanOrEqual(16);
  });

  it('흔들리는 프레임으로 오래 돌아도 단계가 깜빡이지 않는다', () => {
    for (const [device, jitter] of [[capped30, 6], [gpuBound, 5], [heavy, 4], [() => [16.7, 3] as [number, number], 3]] as const) {
      const q = new QualityManager();
      const { changes } = simulate(q, 20 * 60000, device, jitter, 7);
      // 20분 동안: 30Hz 화면은 내려 보는 시험이 60 · 120 · 240 · 480초 간격으로만, GPU 병목은 올려 보는 시험이 4분 간격까지 벌어진다
      expect(changes.length).toBeLessThanOrEqual(20);
    }
  });

  it('30Hz 화면이라도 그리기가 무거워져 프레임이 뚜렷이 느려지면 다시 내려 본다', () => {
    let render = 1.5;
    // 상은 그리기가 무거워지면 20Hz(50ms)로 떨어지고, 중은 30Hz 를 지킨다
    const device: Device = (l) => [l === 'high' && render > 20 ? 50 : 33.3, l === 'high' ? render : render * 0.5];
    const q = new QualityManager();
    expect(simulate(q, 20000, device).changes).toEqual(['medium', 'high']);
    render = 28;
    // 50ms → 33ms 로 빨라지니 중에 남는다. 중도 33ms 라 하로 한 번 내려 보지만 빨라지지 않으니 중으로 돌아와 머문다
    expect(simulate(q, 12000, device).changes).toEqual(['medium', 'low', 'medium']);
    expect(simulate(q, 50000, device).changes).toEqual([]);
    expect(q.level).toBe('medium');
  });

  it('한두 번 튀는 프레임(탭 전환 등)으로는 내리지 않는다', () => {
    const q = new QualityManager();
    run(q, 3000, 16.7, 4);
    q.sample(1200, 4);
    q.sample(400, 4);
    for (let i = 0; i < 3; i++) q.sample(60, 4);
    expect(run(q, 5000, 16.7, 4)).toEqual([]);
    expect(q.level).toBe('high');
  });

  it('여유가 생기면 천천히(8초 넘게) 한 단계 올린다', () => {
    const q = new QualityManager({ initial: 'low' });
    const changes: string[] = [];
    let t = 0;
    for (; t < 7900 && changes.length === 0; t += 16.7) if (q.sample(16.7, 3)) changes.push(q.level);
    expect(changes).toEqual([]);
    expect(run(q, 4000, 16.7, 3)).toEqual(['medium']);
  });

  it('vsync 에 묶여 프레임 간격이 좋아도 그리기 자체가 무거우면 올리지 않는다', () => {
    const q = new QualityManager({ initial: 'medium' });
    expect(run(q, 30000, 16.7, 12)).toEqual([]);
    expect(q.level).toBe('medium');
  });

  it('올렸다가 곧 다시 내리면(깜빡임) 다음 올리기는 더 오래 참는다', () => {
    const q = new QualityManager({ initial: 'medium' });
    run(q, 2000, 16.7, 3);
    // 여유 → 상으로 (8초 남짓)
    const up1 = run(q, 12000, 16.7, 3);
    expect(up1).toEqual(['high']);
    // 상은 버티지 못한다 → 다시 중
    expect(untilChange(q, 4000, 30, 9)).toBe('medium');
    // 같은 여유로는 이제 16초는 지나야 오른다
    expect(run(q, 12000, 16.7, 3)).toEqual([]);
    expect(run(q, 8000, 16.7, 3)).toEqual(['high']);
  });

  it('올려 봤더니 느려지면 3초 안에 되돌린다', () => {
    const q = new QualityManager({ initial: 'medium' });
    const device: Device = (l) => (l === 'high' ? [21, 4] : [16.7, 3]);
    const { changes } = simulate(q, 14000, device);
    expect(changes).toEqual(['high', 'medium']);
    expect(q.level).toBe('medium');
  });

  it('120Hz 화면: 올려서 조금 느려져도 55fps 넘게 나오면 남긴다', () => {
    const q = new QualityManager({ initial: 'medium' });
    const device: Device = (l) => (l === 'high' ? [10, 3] : [8.3, 2]);
    expect(simulate(q, 20000, device).changes).toEqual(['high']);
  });

  it('일시정지 · 대화창 · 관전 프레임(live = false)은 재지 않는다: 아무리 느려도 단계도 물려줄 값도 그대로', () => {
    const q = new QualityManager();
    let now = 1000;
    const frame = (ms: number, render: number, live: boolean) => {
      now += ms;
      return q.frame(now, render, live);
    };
    for (let i = 0; i < 300; i++) expect(frame(16.7, 1, true)).toBe(false);
    // 도움말: 대화창 합성으로 30ms (그리기는 그대로 싸다), 20초
    for (let i = 0; i < 700; i++) expect(frame(30, 1, false)).toBe(false);
    expect(q.level).toBe('high');
    expect(q.settled).toBe('high');
    // 대화창이 닫히는 순간의 긴 프레임은 쉬던 동안의 간격으로 치지 않는다
    now += 200;
    for (let i = 0; i < 600; i++) expect(frame(16.7, 1, true)).toBe(false);
    expect(q.averages.frame).toBeCloseTo(16.7, 1);
  });

  it('바꿔 보던 중에 멈추면 다시 시작한 뒤 처음부터 다시 잰다 (멈춘 동안은 판단하지 않는다)', () => {
    const q = new QualityManager();
    let now = 0;
    const frame = (ms: number, render: number, live: boolean) => {
      now += ms;
      return q.frame(now, render, live);
    };
    // 30Hz 화면: 4초쯤 중으로 내려 본다
    let changed = false;
    for (let i = 0; i < 200 && !changed; i++) changed = frame(33.3, 1.5, true);
    expect(q.level).toBe('medium');
    expect(q.settled).toBe('high');
    // 시험 도중 도움말을 연다: 아무리 오래 열어 두어도 되돌리지도 더 내리지도 않는다
    for (let i = 0; i < 2000; i++) frame(33.3, 1.5, false);
    expect(q.level).toBe('medium');
    // 닫고 나면 다시 재서 3초 남짓 뒤에 되돌린다
    const changes: string[] = [];
    for (let i = 0; i < 120; i++) if (frame(33.3, 1.5, true)) changes.push(q.level);
    expect(changes).toEqual(['high']);
  });

  it('고정했으면 아무리 느려도 바꾸지 않는다', () => {
    const q = new QualityManager({ forced: 'high' });
    expect(run(q, 20000, 50, 30)).toEqual([]);
    expect(q.level).toBe('high');
    expect(q.isForced).toBe(true);
  });
});
