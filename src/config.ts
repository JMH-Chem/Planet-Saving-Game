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

/** 방어전(웨이브 침공에서 모성 지키기) 수치. 정복전 수치(CONFIG)와는 독립적으로 조정한다 */
export const DEFENSE = {
  invader: { name: '침공군', color: '#ff4fa3' },
  /** 가로 화면 기준 맵 크기 (세로 화면이면 교환) */
  worldSize: [1700, 1100] as const,
  startingUnits: 12,

  totalWaves: 12,
  /** 첫 웨이브 예고 시각(초). 그 전까지는 확장할 시간 */
  firstWarningAt: 30,
  /** 예고(게이트 열림) → 병력 출현까지(초). 플레이어가 게이트 쪽으로 병력을 돌릴 시간 */
  warningLead: 12,
  /** 출현 간격(초): 2번째 웨이브가 interval, 이후 웨이브마다 intervalShrink 씩 줄고 minInterval 이 하한 */
  interval: 45,
  intervalShrink: 1,
  minInterval: 35,
  /** 게이트 하나가 초당 내보내는 병력. 큰 게이트는 warpDuration 초 안에 다 나오도록 그보다 빠르게 */
  warpRate: 8,
  warpDuration: 8,
  /** 전장 전체 병력이 이 수 이상이면 게이트 출현을 잠시 멈춘다 (성능 보호) */
  unitCap: 1500,

  /** 웨이브 n 의 총 병력 = round((base + linear·(n−1) + quad·(n−1)²) × 난이도 배율) */
  waveSize: { base: 10, linear: 12, quad: 5.6 },
  difficultyMult: { easy: 0.45, normal: 1.0, hard: 1.5 } satisfies Record<Difficulty, number>,
  /** 웨이브별 게이트 수: [이 웨이브부터, 게이트 수] (오름차순) */
  gatesByWave: [
    [1, 1],
    [4, 2],
    [9, 3],
  ] as const,
  /** 게이트는 맵 경계에서 이만큼 안쪽(범위)에 열린다 */
  gateInset: [36, 60] as const,
  /** 게이트와 행성 중심 사이 최소 거리: 출현 직후 바로 대기권에 걸리지 않게 */
  gateClearance: 250,

  /** 침공군 판단 주기(초) */
  thinkInterval: 1,
  /** 이 웨이브부터 수비대가 두꺼운 행성(siegeMinDefenders 이상)은 포위로 수비대를 깎은 뒤 돌파한다 */
  siegeFrom: 5,
  siegeMinDefenders: 8,
  /** 포위 → 돌파 전환: 대기 중 비율, 남은 수비대 비율, 시간 제한(초) */
  siegeHoldRatio: 0.7,
  siegeDefenderRatio: 0.35,
  siegeTimeout: 25,
  /**
   * 돌파가 assaultTimeout(초) 안에 끝나지 않거나, hopelessAfter(초) 뒤에도 수비대에 비해 가망이 없으면
   * 가장 가까운 플레이어 병력에게 달려든다 (같은 궤도를 돌며 서로 닿지 않는 교착 방지)
   */
  assaultTimeout: 45,
  hopelessAfter: 15,
  /** 이 웨이브부터 무리를 둘로 나눠 서로 다른 행성을 친다 (협공). 무리가 pincerMin 기 이상일 때만 */
  pincerFrom: 8,
  pincerMin: 16,
  /** 웨이브가 오를수록 모성을 노리는 경향: 모성까지 거리에 (1 − 가중치) 를 곱해 비교 */
  homeBiasPerWave: 0.05,
  homeBiasMax: 0.55,
  /** 침공군이 빼앗은 행성: 정원 대비 이만큼 남기고 나머지를 주기적으로 출격 */
  raidInterval: 10,
  raidReserveRatio: 0.25,
  raidMin: 6,

  /** 자동 진행(밸런스 측정 · 관전)에서 플레이어를 조종하는 AI 성향. 난이도는 침공 규모만 바꾼다 */
  autoplayProfile: 'normal' as Difficulty,
} as const;
