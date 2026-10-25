import { CONFIG, type Difficulty } from '../config';
import { AIController } from './ai';
import { generateMap } from './mapgen';
import { PLAYER, type GameMode } from './types';
import { World } from './world';

export interface MatchSettings {
  /** AI 진영 수 (1~3) */
  aiCount: number;
  difficulty: Difficulty;
  seed: number;
  /** true 면 플레이어 진영도 AI 가 조종 (관전/테스트용) */
  autoplay?: boolean;
  /** 세로 화면용 세로로 긴 맵 */
  portrait?: boolean;
  /** 기본 conquest. defense 는 방어전 (src/sim/waves.ts) */
  mode?: GameMode;
}

/** 월드 + AI 를 묶은 한 판. 브라우저와 헤드리스 테스트가 같은 코드를 쓴다. */
export class Match {
  readonly world: World;
  readonly ais: AIController[] = [];

  constructor(readonly settings: MatchSettings) {
    const factionCount = settings.aiCount + 1;
    const aiFactions = Array.from({ length: factionCount + 1 }, (_, id) => id > PLAYER || (id === PLAYER && !!settings.autoplay));
    this.world = new World(generateMap({ factionCount, seed: settings.seed, aiFactions, portrait: settings.portrait }));
    this.world.factions.forEach((f, i) => {
      // 판단 시점을 진영마다 엇갈리게 해서 동시에 몰려오지 않게 한다.
      if (f.isAI) this.ais.push(new AIController(f.id, settings.difficulty, 1 + i * 0.37));
    });
  }

  step(dt = 1 / CONFIG.tickRate): void {
    this.world.step(dt);
    for (const ai of this.ais) ai.update(this.world);
  }
}
