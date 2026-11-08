import { describe, expect, it } from 'vitest';
import expected from './fixtures/perf-equivalence.json';
import { SCENARIOS } from './perf-equivalence.scenarios';

/**
 * 시뮬레이션 성능 최적화(C6)가 결과를 바꾸지 않았는지: 최적화 전 코드(b6f5def)에서 기록한 상태 해시와 비트 단위로 비교한다.
 * 정복전 1~3 AI · 방어전 (자동 진행, 여러 시드, 120~150초) + 병력 2,400기 난전. 10초마다 병력 위치 · 체력 · 상태,
 * 행성 소유 · 방어도, 진영 통계를 해시하고, 매 틱 이벤트를 누적한다.
 * 시뮬레이션 규칙을 일부러 바꾼 커밋이라면 이 해시도 새로 기록해야 한다 (scenarios 파일 머리말 참고).
 */
describe('성능 최적화 동치성 (b6f5def 와 같은 결과)', () => {
  const table = expected as Record<string, string[]>;
  for (const s of SCENARIOS) {
    it(s.name, () => {
      const r = s.run();
      expect(r.checkpoints).toEqual(table[s.name]);
    });
  }
});
