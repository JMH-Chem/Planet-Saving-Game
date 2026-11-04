/** 기존 컨트롤을 이동해 사용하므로 ID·이벤트·접근성 이름이 분리된 복사본을 만들지 않는다. */
export function createCodexMenu(panel: HTMLElement, comparison: HTMLElement): void {
  const menu = panel.parentElement!;
  const header = document.createElement('header');
  header.className = 'cx-header';
  header.innerHTML = '<span class="cx-wordmark"><i aria-hidden="true"></i> ORBITAL COMMAND</span>';
  header.append(comparison);

  const stage = document.createElement('div');
  stage.className = 'cx-stage';
  const brief = document.createElement('section');
  brief.className = 'cx-brief';
  brief.setAttribute('aria-label', '게임 소개');
  brief.innerHTML = `
    <p class="cx-eyebrow">작은 함대, 큰 선택.</p>
    <div class="cx-title"></div>
    <p class="cx-manifest">한 번의 이동이 전술이 된다.<br>병력을 모으고, 펼치고, 당신의 궤도를 넓히세요.</p>
    <figure class="cx-tactics" aria-label="집중 대형으로 대기권 안을 돌파하거나, 산개 대형으로 바깥을 포위하세요">
      <svg viewBox="0 0 520 304" fill="none" aria-hidden="true">
        <defs>
          <radialGradient id="cx-globe" cx=".3" cy=".23" r=".85">
            <stop stop-color="#bcddd6"/><stop offset=".38" stop-color="#5c9d96"/><stop offset=".76" stop-color="#204f57"/><stop offset="1" stop-color="#0a2734"/>
          </radialGradient>
          <pattern id="cx-grid" width="32" height="32" patternUnits="userSpaceOnUse"><path d="M32 0H0V32" stroke="#b7c7c5" stroke-opacity=".07"/></pattern>
        </defs>
        <rect width="520" height="304" fill="url(#cx-grid)"/>
        <path d="M0 152H520M260 0V304" stroke="#b7c7c5" stroke-opacity=".12" stroke-dasharray="2 8"/>
        <circle cx="260" cy="152" r="120" stroke="#a9c3c1" stroke-opacity=".14"/>
        <circle cx="260" cy="152" r="93" stroke="#d0df9b" stroke-opacity=".6" stroke-dasharray="3 6"/>
        <ellipse cx="260" cy="152" rx="164" ry="48" transform="rotate(-24 260 152)" stroke="#9abfbd" stroke-opacity=".2"/>
        <circle cx="260" cy="152" r="67" fill="url(#cx-globe)"/>
        <path d="M214 113C242 103 254 130 275 125S295 100 302 113M198 155C229 141 252 178 287 155S315 153 323 170M223 195C256 184 274 206 298 183" stroke="#e7eee0" stroke-opacity=".18" stroke-width="8" stroke-linecap="round"/>
        <path d="M77 212L169 178" stroke="#d5e8a4" stroke-width="1.5" stroke-dasharray="5 5"/>
        <path d="m159 173 13 4-6 12" stroke="#d5e8a4" stroke-width="1.5"/>
        <path d="m76 207 9 5-10 5 1-10Zm-19 12 9 5-10 5 1-10Zm2-28 9 5-10 5 1-10Z" fill="#d5e8a4"/>
        <path d="m317 64 10 2-7 8-3-10Zm26 20 10 2-7 8-3-10Zm22 27 10 2-7 8-3-10Zm11 31 10 2-7 8-3-10Z" fill="#8dccde"/>
        <circle cx="260" cy="152" r="73" stroke="#e1ebe0" stroke-opacity=".17"/>
        <path d="M193 58H98V42M329 218h97v30" stroke="#91b4b5" stroke-opacity=".45"/>
        <text x="54" y="32" fill="#c4d3c8" font-size="11" letter-spacing="2">대기권</text>
        <text x="391" y="267" fill="#8dccde" font-size="11" letter-spacing="2">포위</text>
        <text x="43" y="253" fill="#d5e8a4" font-size="11" letter-spacing="2">돌파</text>
        <circle cx="260" cy="32" r="3" fill="#d5e8a4"/>
      </svg>
      <figcaption><span><b>집중 → 돌파</b>대기권 안으로 진입</span><span><b>산개 → 포위</b>바깥에서 수비대와 교전</span></figcaption>
    </figure>
    <ol class="cx-principles"><li><span>01</span>병력을 고르고</li><li><span>02</span>대형을 정하고</li><li><span>03</span>행성을 차지하세요</li></ol>`;
  brief.querySelector('.cx-title')!.append(panel.querySelector('h1')!);
  panel.querySelector('.sub')!.remove();

  const heading = document.createElement('div');
  heading.className = 'cx-card-heading';
  heading.innerHTML = '<p class="cx-eyebrow">MISSION SETUP</p><h2>다음 전장을 정하세요</h2>';
  panel.prepend(heading);
  panel.classList.add('cx-settings');
  panel.setAttribute('aria-label', '작전 설정');
  const mode = panel.querySelector('.seg[data-name="mode"]')!;
  mode.querySelector('[data-v="conquest"]')!.insertAdjacentHTML('beforeend', '<small>행성을 넓히는 전투</small>');
  mode.querySelector('[data-v="defense"]')!.insertAdjacentHTML('beforeend', '<small>모성을 지키는 전투</small>');
  // 덜 자주 바꾸는 맵 설정을 접어 작은 화면에서도 주요 선택과 출격 버튼을 먼저 보여 준다.
  const mapSettings = document.createElement('details');
  mapSettings.className = 'cx-map-settings';
  mapSettings.innerHTML = '<summary>맵 설정 <span>같은 전장 다시 플레이</span></summary>';
  const seedField = panel.querySelector('#seed')!.closest('.field')!;
  seedField.before(mapSettings);
  mapSettings.append(seedField);
  const seedHint = document.createElement('p');
  seedHint.id = 'cx-seed-hint';
  seedHint.className = 'cx-seed-hint';
  seedHint.textContent = '시드와 전투 설정, 화면 방향이 같으면 같은 배치로 시작합니다.';
  seedField.append(seedHint);
  panel.querySelector('#seed')!.setAttribute('aria-describedby', seedHint.id);

  const actions = document.createElement('div');
  actions.className = 'cx-launch-actions';
  const start = panel.querySelector('#btn-start')!;
  start.textContent = '출격하기  ↗';
  actions.append(start, panel.querySelector('#btn-howto')!);
  const note = document.createElement('p');
  note.className = 'cx-launch-note';
  const pointer = matchMedia('(pointer: coarse)');
  const updateHint = () => {
    note.textContent = pointer.matches ? '아군 행성을 탭해 선택 · 목표를 탭해 이동' : '아군 행성 클릭으로 선택 · 우클릭으로 이동';
  };
  updateHint();
  pointer.addEventListener('change', updateHint);
  actions.append(note);
  panel.append(actions);
  stage.append(brief, panel);
  menu.append(header, stage);
}
