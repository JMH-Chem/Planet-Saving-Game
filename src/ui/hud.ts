import type { Formation } from '../sim/types';
import { NEUTRAL } from '../sim/types';
import type { World } from '../sim/world';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

/** 게임 중 DOM HUD (상단 진영 현황, 하단 명령 바, 알림) */
export class Hud {
  readonly root = $('hud');
  private stats = $('faction-stats');
  private power = $('power-bar');
  private timer = $('timer');
  private selCount = $('sel-count').querySelector('b')!;
  private formationBtn = $<HTMLButtonElement>('btn-formation');
  private pauseBtn = $<HTMLButtonElement>('btn-pause');
  private speedBtn = $<HTMLButtonElement>('btn-speed');
  private pausedTag = $('paused-tag');
  private banner = $('banner');
  private toasts = $('toasts');

  show(visible: boolean): void {
    this.root.hidden = !visible;
  }

  /** 레이아웃 여백 (카메라 맞춤용). 명령 바가 아래에 있으면 아래, 오른쪽 세로 줄이면 오른쪽을 비운다 */
  insets() {
    const top = this.root.querySelector('.top-bar')!.getBoundingClientRect().bottom + 6;
    const bar = this.root.querySelector('.command-bar')!.getBoundingClientRect();
    const vertical = bar.height > bar.width;
    return {
      top,
      bottom: vertical ? 12 : window.innerHeight - bar.top + 8,
      left: 12,
      right: vertical ? window.innerWidth - bar.left + 8 : 12,
    };
  }

  update(world: World): void {
    const chips: string[] = [];
    const bars: string[] = [];
    const total = world.unitCount.reduce((s, n, f) => (f === NEUTRAL ? s : s + n), 0) || 1;
    for (const f of world.factions) {
      if (f.id === NEUTRAL) continue;
      chips.push(
        `<span class="chip${f.alive ? '' : ' dead'}"><i style="background:${f.color}"></i>${f.name}` +
          ` <b>${world.unitCount[f.id]}</b><small>· 행성 ${world.planetCount[f.id]}</small></span>`,
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

  setBanner(text: string | null): void {
    this.banner.hidden = !text;
    if (text) this.banner.textContent = text;
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
