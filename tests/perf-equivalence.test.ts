import { describe, expect, it } from 'vitest';
import expected from './fixtures/perf-equivalence.json';
import { SCENARIOS } from './perf-equivalence.scenarios';

/**
 * 시뮬레이션 성능 최적화(C6)가 결과를 바꾸지 않았는지: 최적화 전 코드(b6f5def)에서 기록한 상태 해시와 비트 단위로 비교한다.
 * 정복전 1~3 AI · 방어전 (자동 진행, 여러 시드, 120~150초) + 병력 2,400기 난전. 10초마다 병력 위치 · 체력 · 상태,
 * 행성 소유 · 방어도, 진영 통계를 해시하고, 매 틱 이벤트를 누적한다.
 *
 * 규칙 · AI · 수치를 일부러 바꾼 커밋은 이 검사가 실패하는 게 정상이다. 그때는 바꾸기 전 코드에서 이 검사가 통과하는지
 * 먼저 확인한 다음, 바꾼 코드에서 `RECORD_EQUIVALENCE=1 npx vitest run tests/perf-equivalence.test.ts` 로 해시를
 * 다시 기록하고, 커밋 메시지에 '동치성 해시 재기록: <이유>' 를 남긴다. 성능만 손댄 커밋은 절대 다시 기록하지 않는다.
 */
declare const process: { env: Record<string, string | undefined> };

describe('성능 최적화 동치성 (b6f5def 와 같은 결과)', () => {
  if (process.env.RECORD_EQUIVALENCE) {
    it('기대 해시 다시 기록 (RECORD_EQUIVALENCE)', async () => {
      const out: Record<string, string[]> = {};
      for (const s of SCENARIOS) out[s.name] = s.run().checkpoints;
      // 프로젝트에 @types/node 가 없어 모듈 이름을 문자열로 합쳐 타입 검사를 피한다 (vitest 는 node 에서 돈다)
      const fs = (await import(/* @vite-ignore */ 'node:' + 'fs')) as { writeFileSync: (path: string, data: string) => void };
      const path = decodeURIComponent(new URL('./fixtures/perf-equivalence.json', import.meta.url).pathname);
      fs.writeFileSync(path, JSON.stringify(out, null, 2) + '\n');
    }, 120_000);
    return;
  }
  const table = expected as Record<string, string[]>;
  for (const s of SCENARIOS) {
    it(s.name, () => {
      const r = s.run();
      expect(r.checkpoints).toEqual(table[s.name]);
    });
  }
});
