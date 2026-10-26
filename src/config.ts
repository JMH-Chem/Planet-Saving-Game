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

  // 소형 중립 수비대 5: 침입자 역회전(intruderOrbitFactor) 이후에도 시작 병력 13~15기의 첫 돌파가 대개 통하도록
  planet: {
    small: { radius: 18, production: 0.5, capacity: 30, maxDefense: 80, neutralGarrison: 5 },
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
  /**
   * 남의 행성(적·중립)을 도는 병력의 회전 배율. −1 = 수비대와 반대로 돈다.
   * 같은 방향으로 돌면 강하한 병력과 수비대의 상대 위치가 얼어붙어, 처음 사거리 밖에 내린 병력은
   * 끝까지 아무와도 싸우지 않는다. 반대로 돌면 서로 0.7 rad/s 로 스쳐 지나가 수비대가 침입자를 쏠 수 있다
   */
  intruderOrbitFactor: -1,

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
  /** 한 번 판단에 새로 시작할 수 있는 공격 수 (여유 병력이 되면 두 곳을 동시에 친다) */
  launchesPerThink: number;
  /** 다른 진영 행성의 공격 가치 배율 (1 보다 크면 중립을 다 먹기 전에도 상대 행성을 먼저 노린다) */
  enemyPressure: number;
  /**
   * 다른 진영 행성을 칠 때, 그 진영이 주변(AI_REINFORCE_RADIUS)에 둔 병력을 이 비율만큼 수비대로 셈한다.
   * 0 이면 궤도 수비대만 보고 들어갔다가 이웃 행성의 증원에 번번이 막힌다
   */
  reinforceWeight: number;
}

/** reinforceWeight 가 세는 '곧 증원으로 올 수 있는' 병력의 반경 */
export const AI_REINFORCE_RADIUS = 300;

export const AI_PROFILES: Record<Difficulty, AIProfile> = {
  easy: {
    thinkInterval: 3.0, attackMargin: 2.0, usesStaging: false, reserveRatio: 0.3,
    launchesPerThink: 1, enemyPressure: 1, reinforceWeight: 0,
  },
  normal: {
    thinkInterval: 1.5, attackMargin: 1.5, usesStaging: true, reserveRatio: 0.2,
    launchesPerThink: 1, enemyPressure: 1, reinforceWeight: 0.05,
  },
  hard: {
    thinkInterval: 0.8, attackMargin: 1.25, usesStaging: true, reserveRatio: 0.12,
    launchesPerThink: 2, enemyPressure: 1.5, reinforceWeight: 0.3,
  },
};

/** 방어전(웨이브 침공에서 모성 지키기) 수치. 정복전 수치(CONFIG)와는 독립적으로 조정한다 */
export const DEFENSE = {
  invader: { name: '침공군', color: '#ff4fa3' },
  /** 가로 화면 기준 맵 크기 (세로 화면이면 교환) */
  worldSize: [1700, 1100] as const,
  startingUnits: 12,
  /** 모성 최대 방어도 배율 (회복 속도는 그대로). 비슷한 수의 돌파에 몇 초 만에 넘어가지 않고 증원이 닿을 시간을 준다 */
  homeDefenseMult: 1.75,

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
  /**
   * 침공군 병력이 이 수 이상이면 게이트 출현을 잠시 멈춘다 (성능 보호. 침공군이 줄면 이어서 나온다).
   * 플레이어·중립 병력은 세지 않는다: 플레이어가 병력을 쌓아 둔다고 웨이브가 멈추면 판이 끝나지 않는다
   */
  invaderCap: 900,

  /**
   * 웨이브 n 의 총 병력 = round((base + linear·(n−1) + quad·(n−1)²) × 난이도 배율).
   * 보통 기준 10 → 602 (총 2835). quad 5.6 일 때는 후반(570~820)이 확장을 다 해도 따라잡을 수 없는 벽이었다.
   * 지금 값에서: 확장 + 정원 관리 + 게이트 대응을 하는 플레이어는 보통을 대개 이기고 어려움은 가끔 이긴다,
   * 모성만 지키면 보통 5 웨이브 남짓, 자동 진행(AI)은 쉬움을 이긴다 (헤드리스 측정)
   */
  waveSize: { base: 10, linear: 12, quad: 3.8 },
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
   * 가장 가까운 플레이어 병력에게 달려든다 (강하 병력은 행성만 쏘므로, 가망 없는 돌파가 수비대에게 맞기만 하며 끌지 않게)
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
