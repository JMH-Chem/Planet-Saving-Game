import type { Game } from '../game';
import { PLAYER, type GameEvent } from '../sim/types';

export type AlertKind = 'attack' | 'lost' | 'wave';

export interface Alert {
  /** 같은 대상(행성/게이트)의 알림은 하나로 합친다 */
  key: string;
  kind: AlertKind;
  x: number;
  y: number;
  label: string;
  color: string;
  /** 생긴(또는 더 심각한 종류로 바뀐) 시각 — 알림 시계 기준 초. 미니맵 핑 강조와 Space 순서에 쓴다 */
  born: number;
  /** 이 시각이 지나면 사라진다 (알림 시계 기준) */
  until: number;
  /** 대상 행성 id 또는 게이트 id */
  ref: number;
}

export const ALERT_COLORS: Record<AlertKind, string> = { attack: '#ff5d5d', lost: '#ff5d5d', wave: '#f472d0' };
/** 같은 대상에 두 알림이 겹치면 더 심각한 쪽으로 */
const SEVERITY: Record<AlertKind, number> = { wave: 0, attack: 1, lost: 2 };
/** 공격이 멈춘 뒤 알림이 남는 시간(초) */
const ATTACK_TTL = 6;
const LOST_TTL = 8;
const WAVE_TTL = 4;
const MAX_ALERTS = 8;
const MAX_ARROWS = 4;
/** 같은 종류의 토스트를 다시 띄우기까지(초) */
const TOAST_COOLDOWN = 15;
/** Space 를 이 시간 안에 다시 누르면 다음(더 오래된) 알림으로 */
const CYCLE_MS = 2500;

interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

interface Arrow {
  el: HTMLButtonElement;
  dir: SVGElement;
  label: HTMLElement;
  alert: Alert | null;
  w: number;
  h: number;
  text: string;
}

/**
 * 화면 밖 위협 알림: 아군 행성 공격받는 중 / 함락 / 방어전 웨이브 게이트.
 * 미니맵에는 핑으로, 화면 밖이면 가장자리 화살표(탭/클릭 → 그곳으로)로 보여준다. Space 는 가장 최근 알림으로.
 */
export class Alerts {
  readonly list: Alert[] = [];
  /** 새 알림이 생길 때 (효과음 등 외부 연결용) */
  onNew: ((a: Alert) => void) | null = null;

  private clock = 0;
  private arrows: Arrow[] = [];
  private cycle = { index: 0, at: -Infinity };
  /** 알림이 다 사라진 뒤에도 Space 로 돌아갈 수 있게 마지막 위치를 기억한다 */
  private last: { x: number; y: number } | null = null;
  /** 아군이 막 점령한 행성: 점령 직전의 '공격받음' 기록 때문에 오경보가 나지 않게 잠시 무시 */
  private suppress = new Map<number, number>();
  private toastAt = -Infinity;

  /**
   * @param avoid 화살표가 가리면 안 되는 HUD 요소 (미니맵, 토스트, 배너 등). 숨겨진 요소는 건너뛴다
   * @param toast 화면 밖 공격 시작을 알릴 토스트
   */
  constructor(
    root: HTMLElement,
    private game: Game,
    private avoid: readonly HTMLElement[] = [],
    private toast: ((text: string, color: string) => void) | null = null,
  ) {
    for (let i = 0; i < MAX_ARROWS; i++) {
      const el = document.createElement('button');
      el.className = 'alert-arrow';
      el.hidden = true;
      // 방향 표시는 몸통 + 촉이 있는 화살표 (정삼각형은 120° 마다 같아 보여 방향을 잘못 읽힌다)
      el.innerHTML =
        '<svg class="aa-dir" viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 8h10M8.5 3.5 13 8l-4.5 4.5" /></svg>' +
        '<span class="aa-label"></span>';
      const arrow: Arrow = { el, dir: el.firstElementChild as SVGElement, label: el.lastElementChild as HTMLElement, alert: null, w: 0, h: 0, text: '' };
      el.addEventListener('click', () => {
        if (arrow.alert) this.focus(arrow.alert);
      });
      root.append(el);
      this.arrows.push(arrow);
    }
  }

  dispose(): void {
    for (const a of this.arrows) a.el.remove();
    this.arrows = [];
    this.list.length = 0;
  }

  /** 화면 크기가 바뀌면 화살표 크기를 다시 잰다 */
  layout(): void {
    for (const a of this.arrows) a.text = '';
  }

  consume(events: readonly GameEvent[]): void {
    const w = this.game.world;
    for (const e of events) {
      if (e.type === 'capture') {
        const p = w.planets[e.planetId];
        if (e.from === PLAYER) {
          this.raise(`p${p.id}`, 'lost', p.x, p.y, '함락', p.id, LOST_TTL);
        } else if (e.to === PLAYER) {
          this.suppress.set(p.id, this.clock + 1.5);
          this.drop(`p${p.id}`);
        }
      } else if (e.type === 'wave' && e.phase === 'warning') {
        for (const g of w.gates) {
          if (g.wave === e.wave) this.raise(`g${g.id}`, 'wave', g.x, g.y, `웨이브 ${e.wave}`, g.id, WAVE_TTL);
        }
      }
    }
  }

  update(dt: number): void {
    const g = this.game;
    const w = g.world;
    // 일시정지 중에는 알림도 멈춘다
    if (!g.paused) this.clock += dt;

    for (const p of w.planets) {
      if (p.owner !== PLAYER || p.lastAssaultBy === PLAYER || w.time - p.lastAssaultAt >= 0.5) continue;
      if ((this.suppress.get(p.id) ?? -Infinity) > this.clock) continue;
      this.raise(`p${p.id}`, 'attack', p.x, p.y, '공격받는 중', p.id, ATTACK_TTL);
    }
    // 웨이브 알림은 게이트가 열려 있고 병력이 막 쏟아지는 동안 유지
    for (const a of this.list) {
      if (a.kind !== 'wave') continue;
      const gate = w.gates.find((gt) => gt.id === a.ref);
      if (gate && w.time < gate.spawnAt + 5) a.until = Math.max(a.until, this.clock + WAVE_TTL);
    }
    for (let i = this.list.length - 1; i >= 0; i--) {
      if (this.list[i].until < this.clock) this.list.splice(i, 1);
    }
    this.placeArrows();
  }

  /** 알림 시계 (미니맵 핑 애니메이션용) */
  get now(): number {
    return this.clock;
  }

  /** Space: 가장 최근 알림으로. 곧바로 다시 누르면 더 오래된 알림으로 넘어간다 */
  jumpNext(): boolean {
    if (this.list.length === 0) {
      if (this.last) this.game.focusOn(this.last.x, this.last.y);
      return !!this.last;
    }
    const sorted = [...this.list].sort((a, b) => b.born - a.born);
    const t = performance.now();
    const index = t - this.cycle.at < CYCLE_MS ? (this.cycle.index + 1) % sorted.length : 0;
    this.cycle = { index, at: t };
    this.focus(sorted[index]);
    return true;
  }

  // ───────────────────────────── 내부 ─────────────────────────────

  private focus(a: Alert): void {
    this.last = { x: a.x, y: a.y };
    this.game.focusOn(a.x, a.y);
  }

  private raise(key: string, kind: AlertKind, x: number, y: number, label: string, ref: number, ttl: number): void {
    const until = this.clock + ttl;
    const old = this.list.find((a) => a.key === key);
    if (old && SEVERITY[old.kind] >= SEVERITY[kind]) {
      old.until = Math.max(old.until, until);
      return;
    }
    const a: Alert = { key, kind, x, y, label, color: ALERT_COLORS[kind], born: this.clock, until, ref };
    if (old) this.list.splice(this.list.indexOf(old), 1);
    this.list.push(a);
    if (this.list.length > MAX_ALERTS) this.list.shift();
    this.last = { x, y };
    this.onNew?.(a);
    if (kind === 'attack') this.toastAttack(a);
  }

  private drop(key: string): void {
    const i = this.list.findIndex((a) => a.key === key);
    if (i >= 0) this.list.splice(i, 1);
  }

  /** 화면 밖 행성이 공격받기 시작하면 한 번 알려준다 (함락은 main 의 점령 토스트가 따로 알린다) */
  private toastAttack(a: Alert): void {
    if (!this.toast || this.clock - this.toastAt < TOAST_COOLDOWN || this.onScreen(a)) return;
    this.toastAt = this.clock;
    const home = this.game.world.planets[a.ref]?.isHome;
    const touch = window.matchMedia('(pointer: coarse)').matches;
    this.toast(`${home ? '모성이' : '아군 행성이'} 공격받고 있습니다${touch ? '' : ' · Space'}`, a.color);
  }

  private onScreen(a: Alert): boolean {
    const cam = this.game.camera;
    const v = cam.viewRect();
    const s = cam.toScreen(a.x, a.y);
    return s.x >= v.left && s.x <= v.right && s.y >= v.top && s.y <= v.bottom;
  }

  /** 화면 밖 알림마다 보이는 영역 가장자리에 그쪽을 가리키는 화살표를 붙인다 */
  private placeArrows(): void {
    const cam = this.game.camera;
    const v = cam.viewRect();
    const cx = (v.left + v.right) / 2, cy = (v.top + v.bottom) / 2;
    // 심각한 것 → 최근 것 순으로 최대 4개
    const off = this.list
      .filter((a) => !this.onScreen(a))
      .sort((a, b) => SEVERITY[b.kind] - SEVERITY[a.kind] || b.born - a.born)
      .slice(0, MAX_ARROWS);
    // 피할 영역: HUD 요소 + 먼저 놓인 화살표. 토스트 · 배너는 수시로 바뀌므로 화살표가 있을 때만 매번 잰다
    const obstacles: Box[] = [];
    if (off.length > 0) {
      for (const el of this.avoid) {
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) obstacles.push(r);
      }
    }

    this.arrows.forEach((arrow, i) => {
      const a = off[i];
      arrow.alert = a ?? null;
      if (!a) {
        arrow.el.hidden = true;
        return;
      }
      if (arrow.el.hidden) arrow.el.hidden = false;
      if (arrow.text !== a.label + a.color) {
        arrow.text = a.label + a.color;
        arrow.label.textContent = a.label;
        arrow.el.dataset.kind = a.kind;
        arrow.el.style.color = a.color;
        arrow.el.title = `${a.label} — 눌러서 이동`;
        arrow.w = arrow.el.offsetWidth;
        arrow.h = arrow.el.offsetHeight;
      }
      const s = cam.toScreen(a.x, a.y);
      const dx = s.x - cx, dy = s.y - cy;
      const hw = (v.right - v.left) / 2 - arrow.w / 2 - 8;
      const hh = (v.bottom - v.top) / 2 - arrow.h / 2 - 8;
      // 중심에서 대상 쪽으로 쏜 반직선이 (화살표 크기만큼 줄인) 보이는 영역 경계와 만나는 점
      const t = Math.min(hw / Math.max(1e-6, Math.abs(dx)), hh / Math.max(1e-6, Math.abs(dy)));
      const sideEdge = hw / Math.max(1e-6, Math.abs(dx)) <= hh / Math.max(1e-6, Math.abs(dy));
      const { x, y } = this.slideClear(cx + dx * t, cy + dy * t, arrow.w, arrow.h, sideEdge, v, obstacles);
      obstacles.push({ left: x - arrow.w / 2, top: y - arrow.h / 2, right: x + arrow.w / 2, bottom: y + arrow.h / 2 });
      arrow.el.style.transform = `translate(${Math.round(x - arrow.w / 2)}px, ${Math.round(y - arrow.h / 2)}px)`;
      arrow.dir.style.transform = `rotate(${Math.atan2(dy, dx)}rad)`;
    });
  }

  /**
   * 겹치는 영역이 있으면 화살표가 붙은 가장자리를 따라 (좌우 가장자리면 위/아래, 위아래 가장자리면 좌/우로)
   * 가장 가까운 빈 자리로 미끄러뜨린다. 방향은 화살 아이콘이 가리키므로 조금 비켜도 읽는 데 지장이 없다.
   */
  private slideClear(x: number, y: number, w: number, h: number, sideEdge: boolean, v: Box, obstacles: readonly Box[]): { x: number; y: number } {
    const pad = 6;
    const minX = v.left + w / 2 + 8, maxX = v.right - w / 2 - 8;
    const minY = v.top + h / 2 + 8, maxY = v.bottom - h / 2 - 8;
    for (let tries = 0; tries < 10; tries++) {
      const o = obstacles.find((r) => x + w / 2 > r.left - pad && x - w / 2 < r.right + pad && y + h / 2 > r.top - pad && y - h / 2 < r.bottom + pad);
      if (!o) break;
      const options = sideEdge
        ? [{ x, y: o.top - pad - h / 2 }, { x, y: o.bottom + pad + h / 2 }]
        : [{ x: o.left - pad - w / 2, y }, { x: o.right + pad + w / 2, y }];
      const inside = options.filter((c) => c.x >= minX && c.x <= maxX && c.y >= minY && c.y <= maxY);
      const pick = (inside.length > 0 ? inside : options).reduce((a, b) => (Math.hypot(a.x - x, a.y - y) <= Math.hypot(b.x - x, b.y - y) ? a : b));
      x = pick.x;
      y = pick.y;
    }
    return { x, y };
  }
}
