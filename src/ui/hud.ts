import type { Formation } from '../sim/types';
import { NEUTRAL } from '../sim/types';
import type { World } from '../sim/world';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

/** 게임 중 DOM HUD (상단 진영 현황, 하단 명령 바, 알림) */
export class Hud {
  readonly root = $('hud');
  private topBar = this.root.querySelector<HTMLElement>('.top-bar')!;
  private stats = $('faction-stats');
  private power = $('power-bar');
  private timer = $('timer');
  private wave = $('wave');
  private waveText = this.wave.querySelector('span')!;
  private selCount = $('sel-count').querySelector('b')!;
  private formationBtn = $<HTMLButtonElement>('btn-formation');
  private pauseBtn = $<HTMLButtonElement>('btn-pause');
  private speedBtn = $<HTMLButtonElement>('btn-speed');
  private pausedTag = $('paused-tag');
  private banner = $('banner');
  private bannerText: string | null = null;
  private toasts = $('toasts');

  show(visible: boolean): void {
    this.root.hidden = !visible;
  }

  /**
   * 레이아웃 여백 (카메라 맞춤 · 경계 · 알림 화살표 위치용). 명령 바가 아래에 있으면 아래, 오른쪽 세로 줄이면 오른쪽을 비운다.
   * 미니맵은 전장 위에 떠 있는 창이라 빼지 않는다.
   */
  insets() {
    const top = this.topBar.getBoundingClientRect().bottom + 6;
    const bar = this.root.querySelector('.command-bar')!.getBoundingClientRect();
    const vertical = bar.height > bar.width;
    // 상단 바의 좌우 패딩 = 12px + 노치(safe-area). 가로로 눕힌 휴대폰에서 노치 밑을 전장 영역에서 뺀다
    const cs = getComputedStyle(this.topBar);
    return {
      top,
      bottom: vertical ? window.innerHeight - bar.bottom + 6 : window.innerHeight - bar.top + 8,
      left: parseFloat(cs.paddingLeft) || 12,
      right: vertical ? window.innerWidth - bar.left + 8 : parseFloat(cs.paddingRight) || 12,
    };
  }

  update(world: World): void {
    const chips: string[] = [];
    const bars: string[] = [];
    const total = world.unitCount.reduce((s, n, f) => (f === NEUTRAL ? s : s + n), 0) || 1;
    for (const f of world.factions) {
      if (f.id === NEUTRAL) continue;
      // 휴대폰에서는 색 점 + 병력 수만 보인다 (이름 · 행성 수는 CSS 로 숨기고 툴팁에 남긴다)
      const units = world.unitCount[f.id], planets = world.planetCount[f.id];
      chips.push(
        `<span class="chip${f.alive ? '' : ' dead'}" title="${f.name} · 병력 ${units} · 행성 ${planets}">` +
          `<i style="background:${f.color}"></i><span class="nm">${f.name}</span> <b>${units}</b><small>· 행성 ${planets}</small></span>`,
      );
      bars.push(`<span style="background:${f.color};flex-grow:${world.unitCount[f.id] / total}"></span>`);
    }
    this.stats.innerHTML = chips.join('');
    this.power.innerHTML = bars.join('');
    const t = Math.floor(world.time);
    this.timer.textContent = `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
  }

  setSelection(n: number): void {
    this.selCount.textContent = String(n);
  }

  setFormation(f: Formation): void {
    this.formationBtn.dataset.mode = f;
    this.formationBtn.querySelector('.f-label')!.textContent = f === 'cluster' ? '집중' : '산개';
  }

  setPaused(paused: boolean): void {
    this.pauseBtn.textContent = paused ? '▶' : '❚❚';
    this.pausedTag.hidden = !paused;
  }

  setSpeed(speed: number): void {
    this.speedBtn.textContent = `${speed}×`;
  }

  /** 방어전 웨이브 표시 (null = 숨김, 정복전). alert 면 다음 웨이브 게이트가 열려 있다는 경고 */
  setWave(text: string | null, alert = false): void {
    this.wave.hidden = !text;
    if (!text) return;
    if (this.waveText.textContent !== text) this.waveText.textContent = text;
    this.wave.classList.toggle('alert', alert);
  }

  /** 매 프레임 불려도 되도록 바뀔 때만 DOM 을 건드린다 */
  setBanner(text: string | null): void {
    if (text === this.bannerText) return;
    this.bannerText = text;
    this.banner.hidden = !text;
    if (text) this.banner.textContent = text;
  }

  /** 이전 판의 토스트 · 배너를 지운다 (토스트마다 걸린 타이머는 떼어낸 요소에만 작용하므로 그대로 둔다) */
  reset(): void {
    this.toasts.replaceChildren();
    this.setBanner(null);
  }

  /**
   * 상단 바 높이는 진영 수 · 화면 폭 · 웨이브 표시에 따라 달라진다. 실제 아래 끝을 재서 --hud-top 에 두고
   * (토스트 · 배너가 그 바로 아래에 온다) 바뀔 때마다 알린다 (카메라 여백 갱신용). HUD 가 숨겨져 있을 땐 재지 않는다.
   */
  watchTopBar(onChange: () => void): void {
    let last = -1;
    new ResizeObserver(() => {
      const bottom = Math.ceil(this.topBar.getBoundingClientRect().bottom);
      if (bottom <= 0 || bottom === last) return;
      last = bottom;
      this.root.style.setProperty('--hud-top', `${bottom}px`);
      onChange();
    }).observe(this.topBar, { box: 'border-box' });
  }

  toast(text: string, color: string, ms = 2600): void {
    const el = document.createElement('div');
    el.className = 'toast';
    el.style.borderLeftColor = color;
    el.textContent = text;
    this.toasts.prepend(el);
    while (this.toasts.children.length > 4) this.toasts.lastElementChild!.remove();
    window.setTimeout(() => el.classList.add('out'), ms);
    window.setTimeout(() => el.remove(), ms + 450);
  }
}
