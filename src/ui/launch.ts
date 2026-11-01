import type { Difficulty } from '../config';
import type { MatchSettings } from '../sim/match';

/** 디자인을 바꿔도 같은 맵·모드·난이도로 비교할 수 있게 URL 설정을 한곳에서 읽는다. */
export function readLaunchSettings(params: URLSearchParams, randomSeed: () => number): MatchSettings {
  const ai = Number(params.get('ai'));
  const difficulty = params.get('difficulty');
  const seed = params.get('seed');
  return {
    aiCount: [1, 2, 3].includes(ai) ? ai : 1,
    difficulty: (['easy', 'normal', 'hard'].includes(difficulty ?? '') ? difficulty : 'normal') as Difficulty,
    seed: seed !== null && seed.trim() !== '' && Number.isFinite(Number(seed)) ? Math.trunc(Number(seed)) : randomSeed(),
    mode: params.get('mode') === 'defense' ? 'defense' : 'conquest',
  };
}
