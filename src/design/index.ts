import './codex.css';
import { createCodexMenu } from './codex';

/** 스킨만 바꾼다. 원본 HTML/CSS 와 시뮬레이션·입력·렌더러는 공유한다. */
export function initializeDesign(): void {
  const codex = new URLSearchParams(location.search).get('design') === 'codex';
  document.documentElement.dataset.design = codex ? 'codex' : 'original';
  const panel = document.querySelector<HTMLElement>('#menu > .panel')!;
  const nav = document.createElement('nav');
  nav.className = 'design-switch';
  nav.setAttribute('aria-label', '화면 디자인 비교');
  for (const [version, label] of [['original', '기존 디자인'], ['codex', 'Codex 디자인']]) {
    const link = document.createElement('a');
    link.textContent = label;
    const url = new URL(location.href);
    url.searchParams.set('design', version);
    url.searchParams.delete('play');
    link.href = url.href;
    if (version === (codex ? 'codex' : 'original')) link.setAttribute('aria-current', 'page');
    const updateHref = () => {
      // 메뉴에서 방금 고른 값도 보존한다. 링크는 일반 탐색이어서 새 탭으로도 비교 가능하다.
      for (const [name, parameter] of [['mode', 'mode'], ['aiCount', 'ai'], ['difficulty', 'difficulty']]) {
        const selected = document.querySelector<HTMLElement>(`.seg[data-name="${name}"] .on`);
        if (selected?.dataset.v) url.searchParams.set(parameter, selected.dataset.v);
      }
      url.searchParams.set('seed', (document.getElementById('seed') as HTMLInputElement).value);
      link.href = url.href;
    };
    link.addEventListener('pointerdown', updateHref);
    link.addEventListener('focus', updateHref);
    link.addEventListener('click', updateHref);
    nav.append(link);
  }
  if (codex) createCodexMenu(panel, nav);
  else panel.append(nav);
}
