import { CONFIG, type PlanetSize } from '../config';
import { Rng } from './rng';
import { NEUTRAL } from './types';
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
  const fits = (x: number, y: number, size: PlanetSize) => {
    const r = CONFIG.planet[size].radius;
    if (x < r + 40 || y < r + 40 || x > width - r - 40 || y > height - r - 40) return false;
    return planets.every((p) => {
      const minGap = r + CONFIG.planet[p.size].radius + CONFIG.atmosphere * 2 + 45;
      return Math.hypot(p.x - x, p.y - y) >= minGap;
    });
  };

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
