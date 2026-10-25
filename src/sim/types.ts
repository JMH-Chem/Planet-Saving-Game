import type { PlanetSize } from '../config';

/** 0 = 중립, 1 = 플레이어, 2+ = AI */
export type FactionId = number;
export const NEUTRAL: FactionId = 0;
export const PLAYER: FactionId = 1;

export interface Faction {
  id: FactionId;
  name: string;
  color: string;
  isAI: boolean;
  alive: boolean;
  /** 행성 없이도 보급이 유지되는 진영 (방어전의 침공군). 행성을 잃어도 전원 고립되지 않는다 */
  invader: boolean;
  stats: FactionStats;
}

/** conquest = 정복전(적 진영 섬멸), defense = 방어전(웨이브로 몰려오는 침공군에게서 모성 지키기) */
export type GameMode = 'conquest' | 'defense';

/** 방어전: 침공군이 나타나는 워프 게이트. 예고(opensAt) 후 spawnAt 부터 병력이 흘러나온다 */
export interface WarpGate {
  id: number;
  x: number;
  y: number;
  /** 몇 번째 웨이브인지 (1부터) */
  wave: number;
  /** 게이트가 화면에 나타난(예고 시작) 시각(초) */
  opensAt: number;
  /** 병력이 나오기 시작하는 시각(초) */
  spawnAt: number;
  /** 이 게이트에서 나올 총 병력 수 */
  count: number;
  /** 아직 나오지 않은 병력 수. 0 이 되면 게이트는 닫히고 목록에서 빠진다 */
  remaining: number;
}

export interface FactionStats {
  produced: number;
  lost: number;
  kills: number;
  planetsCaptured: number;
}

export interface Planet {
  id: number;
  x: number;
  y: number;
  size: PlanetSize;
  radius: number;
  /** 대기권 바깥 경계 반경 (radius + CONFIG.atmosphere) */
  atmosphereRadius: number;
  owner: FactionId;
  defense: number;
  maxDefense: number;
  production: number;
  capacity: number;
  prodProgress: number;
  /** 마지막으로 적에게 방어도 피해를 받은 시각(초) */
  lastAssaultAt: number;
  /** 마지막으로 방어도 피해를 준 진영 */
  lastAssaultBy: FactionId;
  isHome: boolean;
  /** 진영별 궤도 대기 병력 수 (매 틱 갱신) */
  orbitCount: number[];
  /** 진영별 대기권 안 병력 수 (매 틱 갱신) */
  presence: number[];
}

export type UnitState = 'orbit' | 'move' | 'hold';

export interface Unit {
  id: number;
  faction: FactionId;
  x: number;
  y: number;
  /** 직전 틱 위치 (렌더 보간용) */
  px: number;
  py: number;
  hp: number;
  cooldown: number;
  state: UnitState;
  /** state === 'orbit' 일 때 도는 행성, 'move' 일 때는 도착 후 합류할 행성 (-1 = 없음) */
  planet: number;
  tx: number;
  ty: number;
  orbitAngle: number;
  orbitAltitude: number;
  /** 고립(보급 단절): 체력이 계속 줄고 공격력이 떨어진다 */
  isolated: boolean;
  /** 현재 들어가 있는 행성 대기권 (-1 = 우주 공간). 매 틱 갱신 */
  inPlanet: number;
  alive: boolean;
}

export type Formation = 'cluster' | 'spread';

export type Order =
  /** 지점으로 이동. cluster = 원형 밀집, spread = 진행 방향에 수직인 횡대 */
  | { kind: 'move'; x: number; y: number; formation: Formation }
  /** 선을 따라 횡대 배치 (PC 우클릭 드래그) */
  | { kind: 'line'; x1: number; y1: number; x2: number; y2: number }
  /** 행성 지정. 아군 행성 = 궤도 합류, 적 행성 + cluster = 돌파(대기권 강하), 적 행성 + spread = 포위 */
  | { kind: 'planet'; planetId: number; formation: Formation }
  /** 각자 가장 가까운 아군 행성으로 귀환 */
  | { kind: 'return' };

export interface Command {
  faction: FactionId;
  unitIds: number[];
  order: Order;
}

export type GameEvent =
  | { type: 'shot'; x1: number; y1: number; x2: number; y2: number; faction: FactionId; planet: boolean }
  | { type: 'death'; x: number; y: number; faction: FactionId }
  /** 행성이 병력을 하나 생산함 (x, y = 생성 위치) */
  | { type: 'spawn'; x: number; y: number; faction: FactionId; planetId: number }
  /** 방어전: 워프 게이트에서 병력 하나가 나옴 */
  | { type: 'warp'; x: number; y: number; faction: FactionId; gateId: number }
  /** 방어전: 웨이브 예고(게이트 열림) / 시작(병력 출현 시작) */
  | { type: 'wave'; wave: number; total: number; phase: 'warning' | 'start' }
  | { type: 'capture'; planetId: number; from: FactionId; to: FactionId }
  | { type: 'eliminated'; faction: FactionId };
