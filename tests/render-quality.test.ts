import { describe, expect, it } from 'vitest';
import { parseQualityParam, QUALITY, QualityManager } from '../src/render/quality';

// 품질 관리자: 실제 프레임 간격의 평균으로 단계를 고르되, 오르내림이 깜빡이지 않게 내릴 땐 빠르게 · 올릴 땐 느리게

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

  it('느리면(약 30fps) 2초쯤 버틴 뒤 한 단계씩 내린다', () => {
    const q = new QualityManager();
    // 시작 2초는 판단하지 않는다 (텍스처 굽기)
    expect(run(q, 2000, 33, 20)).toEqual([]);
    const first = run(q, 3500, 33, 20);
    expect(first).toEqual(['medium']);
    expect(run(q, 3500, 33, 20)).toEqual(['low']);
    // 하 아래로는 없다
    expect(run(q, 10000, 33, 20)).toEqual([]);
    expect(q.level).toBe('low');
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

  it('고정했으면 아무리 느려도 바꾸지 않는다', () => {
    const q = new QualityManager({ forced: 'high' });
    expect(run(q, 20000, 50, 30)).toEqual([]);
    expect(q.level).toBe('high');
    expect(q.isForced).toBe(true);
  });
});
