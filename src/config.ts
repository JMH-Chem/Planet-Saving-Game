// 밸런스 수치는 전부 여기서 관리한다. (docs/GAME_DESIGN.md 의 표와 동기화할 것)

export type PlanetSize = 'small' | 'medium' | 'large';

export interface PlanetSpec {
  radius: number;
  /** 초당 생산 병력 수 */
  production: number;
  /** 궤도 정원: 궤도 병력이 이 수에 도달하면 생산 정지 */
  capacity: number;
  /** 최대 방어도(행성 내구도) */
  maxDefense: number;
  /** 중립일 때 기본 수비대 수 */
  neutralGarrison: number;
}

export const CONFIG = {
  /** 시뮬레이션 틱/초 (고정 타임스텝) */
  tickRate: 30,

  unit: {
    hp: 4,
    damage: 1,
    /** 공격 간격(초). 실제로는 ±jitter 만큼 흔들어 사격이 동기화되지 않게 한다 */
    attackInterval: 1.0,
    attackJitter: 0.15,
    range: 24,
    speed: 55,
    /** 행성(방어도)에 주는 피해 배율 */
    planetDamageMult: 0.6,
  },

  planet: {
    small: { radius: 18, production: 0.5, capacity: 30, maxDefense: 80, neutralGarrison: 6 },
    medium: { radius: 26, production: 0.8, capacity: 50, maxDefense: 150, neutralGarrison: 12 },
    large: { radius: 34, production: 1.1, capacity: 80, maxDefense: 240, neutralGarrison: 20 },
  } satisfies Record<PlanetSize, PlanetSpec>,

  /** 대기권 두께(행성 표면에서 바깥으로). 이 안에 들어온 적은 '강하'하여 행성을 직접 공격한다 */
  atmosphere: 24,
  /** 궤도 대기 병력이 도는 고도 범위(표면 기준) */
  orbitBand: [5, 18] as const,
  /** 포위 대형이 서는 고도(표면 기준) — 대기권 바로 바깥 */
  surroundAltitude: 27,
  /** 궤도 회전 속도(rad/s) */
  orbitSpeed: 0.35,

  /** 공격받지 않은 뒤 방어도 회복이 시작되기까지(초) */
  regenDelay: 2,
  /** 초당 방어도 회복(최대치 대비 비율) */
  regenRate: 0.04,
  /** 점령 직후 방어도(최대치 대비 비율) */
  captureDefense: 0.4,

  /** 고립(보급 단절) 상태 */
  isolation: {
    hpLossPerSec: 0.4,
    damageMult: 0.5,
  },

  /** 시작 병력 */
  startingUnits: 12,

  formation: {
    clusterSpacing: 5.5,
    lineSpacing: 7,
    lineMaxWidth: 260,
    rowSpacing: 7,
  },
} as const;

export const FACTION_COLORS = ['#9aa3ad', '#4fc3f7', '#ff5d5d', '#ffb74d', '#c792ea'] as const;
export const FACTION_NAMES = ['중립', '플레이어', '적 A', '적 B', '적 C'] as const;

export type Difficulty = 'easy' | 'normal' | 'hard';

export interface AIProfile {
  /** 판단 주기(초) */
  thinkInterval: number;
  /** 공격 시 요구하는 전력 배율 */
  attackMargin: number;
  /** 수비대가 많을 때 포위 → 돌파 2단계 전술 사용 여부 */
  usesStaging: boolean;
  /** 행성마다 남겨두는 예비 병력 비율(정원 대비) */
  reserveRatio: number;
}

export const AI_PROFILES: Record<Difficulty, AIProfile> = {
  easy: { thinkInterval: 3.0, attackMargin: 2.0, usesStaging: false, reserveRatio: 0.3 },
  normal: { thinkInterval: 1.5, attackMargin: 1.5, usesStaging: true, reserveRatio: 0.2 },
  hard: { thinkInterval: 0.8, attackMargin: 1.25, usesStaging: true, reserveRatio: 0.12 },
};
