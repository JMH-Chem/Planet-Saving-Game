import { CONFIG, DEFENSE, type PlanetSize } from '../config';
import { Rng } from './rng';
import { NEUTRAL, PLAYER } from './types';
import type { PlanetInit, WorldInit } from './world';

export interface MapOptions {
  /** 플레이어를 포함한 진영 수 (2~4) */
  factionCount: number;
  seed: number;
  /** 진영별 AI 여부 (index = FactionId) */
  aiFactions: boolean[];
  /** 세로 화면용: 맵의 가로/세로를 뒤집는다 */
  portrait?: boolean;
}

const WORLD_SIZE: Record<number, [number, number]> = {
  2: [1500, 940],
  3: [1700, 1100],
  4: [1800, 1160],
};

/** 행성 사이 간격 규칙: 대기권끼리 겹치지 않고, 맵 가장자리에서 margin 만큼 떨어진다 */
function spacingCheck(planets: readonly PlanetInit[], width: number, height: number, margin: number) {
  return (x: number, y: number, size: PlanetSize): boolean => {
    const r = CONFIG.planet[size].radius;
    if (x < r + margin || y < r + margin || x > width - r - margin || y > height - r - margin) return false;
    return planets.every((p) => {
      const minGap = r + CONFIG.planet[p.size].radius + CONFIG.atmosphere * 2 + 45;
      return Math.hypot(p.x - x, p.y - y) >= minGap;
    });
  };
}

/**
 * 회전 대칭 맵 생성. 원 좌표계에서 한 진영 몫(부채꼴)만 뽑고 진영 수만큼 회전 복제한 뒤
 * 화면 비율에 맞게 늘린다. (2인은 점대칭이라 완전 공정, 3~4인은 근사 공정)
 */
export function generateMap(opts: MapOptions): WorldInit {
  const n = Math.min(4, Math.max(2, opts.factionCount));
  const rng = new Rng(opts.seed ^ 0x9e3779b9);
  const [w0, h0] = WORLD_SIZE[n];
  const [width, height] = opts.portrait ? [h0, w0] : [w0, h0];
  const cx = width / 2, cy = height / 2;
  const sx = width / 2 - 70, sy = height / 2 - 70;
  const toWorld = (r: number, a: number) => ({ x: cx + Math.cos(a) * r * sx, y: cy + Math.sin(a) * r * sy });

  const planets: PlanetInit[] = [];
  const fits = spacingCheck(planets, width, height, 40);

  const baseAngle = (Math.PI * 3) / 4; // 플레이어는 왼쪽 아래에서 시작
  const sector = (Math.PI * 2) / n;

  // 각 진영의 모성
  for (let k = 0; k < n; k++) {
    const pos = toWorld(0.8, baseAngle + k * sector);
    planets.push({ ...pos, size: 'large', owner: k + 1, isHome: true, garrison: CONFIG.startingUnits });
  }

  // 중앙의 큰 중립 행성: 수비가 두꺼운 요충지
  planets.push({
    x: cx, y: cy, size: 'large', owner: NEUTRAL,
    garrison: Math.round(CONFIG.planet.large.neutralGarrison * 1.5),
  });

  /** 부채꼴 하나에 행성을 놓고 나머지 진영 몫으로 회전 복제 */
  const tryPlace = (r: number, offset: number, size: PlanetSize, garrison: number): boolean => {
    const copies = Array.from({ length: n }, (_, k) => toWorld(r, baseAngle + offset + k * sector));
    // 복제본끼리도 서로 겹치면 안 되므로 하나씩 넣으면서 검사한다.
    const added: PlanetInit[] = [];
    for (const c of copies) {
      if (!fits(c.x, c.y, size)) {
        planets.splice(planets.length - added.length, added.length);
        return false;
      }
      const p = { ...c, size, owner: NEUTRAL, garrison };
      planets.push(p);
      added.push(p);
    }
    return true;
  };

  const sizeOf = (): PlanetSize => {
    const t = rng.next();
    return t < 0.45 ? 'small' : t < 0.8 ? 'medium' : 'large';
  };
  const garrisonOf = (size: PlanetSize) => Math.round(CONFIG.planet[size].neutralGarrison * rng.range(0.7, 1.3));

  // 모성 근처의 첫 확장용 작은 행성 1~2개 (초반 선택지를 보장)
  const near = rng.int(1, 2);
  for (let i = 0, tries = 0; i < near && tries < 200; tries++) {
    if (tryPlace(rng.range(0.5, 0.62), rng.range(-sector * 0.28, sector * 0.28), 'small', garrisonOf('small'))) i++;
  }

  const perSector = n === 2 ? 6 : n === 3 ? 5 : 4;
  for (let i = near, tries = 0; i < perSector && tries < 2000; tries++) {
    const size = sizeOf();
    if (tryPlace(rng.range(0.25, 0.98), rng.range(-sector / 2, sector / 2), size, garrisonOf(size))) i++;
  }

  return { width, height, seed: opts.seed, factionCount: n, aiFactions: opts.aiFactions, planets };
}

export interface DefenseMapOptions {
  seed: number;
  /** 세로 화면용: 맵의 가로/세로를 뒤집는다 */
  portrait?: boolean;
}

/**
 * 방어전 맵. 플레이어 모성(대형)이 한가운데, 중립 행성이 그 둘레에 세 겹으로 놓인다.
 * 안쪽 = 수비가 얇은 소형(첫 확장), 바깥 = 생산이 좋은 중·대형이지만 침공군이 나타나는 가장자리에 가깝다.
 * (확장할수록 경제는 커지지만 지킬 곳도 늘어나는 위험/보상)
 */
export function generateDefenseMap(opts: DefenseMapOptions): WorldInit {
  const rng = new Rng(opts.seed ^ 0x5bd1e995);
  const [w0, h0] = DEFENSE.worldSize;
  const [width, height] = opts.portrait ? [h0, w0] : [w0, h0];
  const cx = width / 2, cy = height / 2;
  const sx = width / 2 - 90, sy = height / 2 - 90;

  const planets: PlanetInit[] = [
    {
      x: cx + rng.range(-30, 30),
      y: cy + rng.range(-20, 20),
      size: 'large',
      owner: PLAYER,
      isHome: true,
      garrison: DEFENSE.startingUnits,
    },
  ];
  // 가장자리 여백을 정복전보다 넉넉히: 게이트(경계 안쪽 60 이내)가 열릴 자리를 남긴다
  const fits = spacingCheck(planets, width, height, 60);
  const garrisonOf = (size: PlanetSize, mult: number) =>
    Math.round(CONFIG.planet[size].neutralGarrison * mult * rng.range(0.8, 1.2));

  const home = planets[0];
  // 첫 확장용 소형 3개: 모성에서 어느 방향이든 비슷한 거리(원형)에 둔다
  const inner = 3;
  const a0 = rng.range(0, Math.PI * 2);
  for (let i = 0; i < inner; i++) {
    for (let tries = 0; tries < 300; tries++) {
      const a = a0 + ((i + rng.range(-0.3, 0.3)) * Math.PI * 2) / inner;
      const r = rng.range(170, 260);
      const x = home.x + Math.cos(a) * r, y = home.y + Math.sin(a) * r;
      if (!fits(x, y, 'small')) continue;
      planets.push({ x, y, size: 'small', owner: NEUTRAL, garrison: garrisonOf('small', 1) });
      break;
    }
  }

  // 바깥 두 겹은 맵 비율을 따라 타원으로. [개수, 타원 반경 범위(0 = 중심, 1 = 가장자리 여백선), 크기, 수비대 배율]
  const rings: [number, number, number, () => PlanetSize, number][] = [
    [rng.int(3, 4), 0.5, 0.7, () => (rng.next() < 0.5 ? 'small' : 'medium'), 1.1],
    [4, 0.72, 0.95, () => (rng.next() < 0.6 ? 'medium' : 'large'), 1.4],
  ];
  for (const [count, r0, r1, sizeOf, mult] of rings) {
    // 고리마다 시작 각도를 흔들고 칸을 나눠, 행성이 모성 둘레 사방에 고르게 퍼지게 한다
    const b0 = rng.range(0, Math.PI * 2);
    for (let i = 0; i < count; i++) {
      const size = sizeOf();
      for (let tries = 0; tries < 300; tries++) {
        const a = b0 + ((i + rng.range(-0.35, 0.35)) * Math.PI * 2) / count;
        const r = rng.range(r0, r1);
        const x = cx + Math.cos(a) * r * sx, y = cy + Math.sin(a) * r * sy;
        // 첫 확장 고리보다는 확실히 멀게: 가까운 행성 = 소형이라는 약속을 지킨다
        if (Math.hypot(x - home.x, y - home.y) < 300 || !fits(x, y, size)) continue;
        planets.push({ x, y, size, owner: NEUTRAL, garrison: garrisonOf(size, mult) });
        break;
      }
    }
  }
  // 칸 배치가 막혀 10개가 안 되면 아무 데나 채운다
  for (let tries = 0; planets.length < 11 && tries < 2000; tries++) {
    const a = rng.range(0, Math.PI * 2);
    const r = rng.range(0.5, 0.95);
    const x = cx + Math.cos(a) * r * sx, y = cy + Math.sin(a) * r * sy;
    if (Math.hypot(x - home.x, y - home.y) >= 300 && fits(x, y, 'medium')) {
      planets.push({ x, y, size: 'medium', owner: NEUTRAL, garrison: garrisonOf('medium', 1.1) });
    }
  }

  return { width, height, seed: opts.seed, factionCount: 2, aiFactions: [false, false, true], planets };
}
