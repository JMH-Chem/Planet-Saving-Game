import { describe, expect, it } from 'vitest';
import { readLaunchSettings } from '../src/ui/launch';

describe('디자인 비교 · 실행 설정', () => {
  it('디자인과 관계없이 같은 시드·진영·난이도·모드를 복원한다', () => {
    for (const design of ['original', 'codex']) {
      expect(readLaunchSettings(new URLSearchParams(`design=${design}&seed=42&ai=3&difficulty=hard&mode=defense`), () => 99))
        .toEqual({ seed: 42, aiCount: 3, difficulty: 'hard', mode: 'defense' });
    }
  });
  it('시드 0 도 무작위 값으로 바뀌지 않는다', () => {
    expect(readLaunchSettings(new URLSearchParams('seed=0'), () => 99).seed).toBe(0);
  });
  it.each(['', 'ai=99&difficulty=unknown&mode=unknown&seed=NaN'])('없거나 잘못된 값은 실행 가능한 기본값으로 대체한다: %s', (query) => {
    expect(readLaunchSettings(new URLSearchParams(query), () => 99))
      .toEqual({ seed: 99, aiCount: 1, difficulty: 'normal', mode: 'conquest' });
  });
});
