import './style.css';
import { sfx } from './audio/sfx';
import { DEFENSE, type Difficulty } from './config';
import { Game } from './game';
import { InputController } from './input/controller';
import { Minimap } from './render/minimap';
import type { MatchSettings } from './sim/match';
import { PLAYER, type GameEvent, type GameMode } from './sim/types';
import type { WaveDirector } from './sim/waves';
import type { World } from './sim/world';
import { Alerts } from './ui/alerts';
import { Hud } from './ui/hud';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const canvas = $<HTMLCanvasElement>('game');
const menu = $('menu');
const help = $('help');
const result = $('result');
const confirmBox = $('confirm');
const seedInput = $<HTMLInputElement>('seed');
const hud = new Hud();

const DIFFICULTY_LABEL: Record<Difficulty, string> = { easy: '쉬움', normal: '보통', hard: '어려움' };
const MODE_DESC: Record<GameMode, string> = {
  conquest: '적 진영의 행성과 병력을 모두 없애면 승리',
  defense: `가장자리 게이트로 몰려오는 ${DEFENSE.totalWaves}번의 침공에서 모성을 지키고, 남은 침공군과 그 행성까지 모두 없애면 승리`,
};
const SPEEDS = [1, 2, 3];
const coarsePointer = window.matchMedia('(pointer: coarse)');

let game: Game | null = null;
let input: InputController | null = null;
let minimap: Minimap | null = null;
let alerts: Alerts | null = null;
let hudTimer = 0;
/** 결과 화면을 띄울 타이머. 그 전에 판을 떠나면(메뉴 · 다시 하기) 취소해야 옛 결과가 새 화면 위에 뜨지 않는다 */
let resultTimer = 0;
let settings: MatchSettings = { aiCount: 1, difficulty: 'normal', seed: randomSeed(), mode: 'conquest' };

function randomSeed(): number {
  return Math.floor(Math.random() * 1_000_000);
}

/** 세로 화면이면 맵도 세로로 길게 만든다 */
function isPortrait(): boolean {
  return window.innerHeight > window.innerWidth * 1.1;
}

// ───────────────────────────── 화면 전환 ─────────────────────────────

function teardown(): void {
  sfx.stopAmbient();
  game?.stop();
  input?.dispose();
  minimap?.dispose();
  alerts?.dispose();
  window.clearInterval(hudTimer);
  window.clearTimeout(resultTimer);
  hud.reset();
  game = null;
  input = null;
  minimap = null;
  alerts = null;
}

/** 메뉴 뒤에서 AI 끼리 싸우는 관전 화면 */
function showMenu(): void {
  teardown();
  hud.show(false);
  result.hidden = true;
  help.hidden = true;
  confirmBox.hidden = true;
  menu.hidden = false;
  seedInput.value = String(settings.seed);
  setSeg('mode', settings.mode ?? 'conquest');
  syncModeField();
  game = new Game(canvas, { aiCount: 3, difficulty: 'normal', seed: randomSeed(), autoplay: true, portrait: isPortrait() });
  game.speed = 1.5;
  layout(true);
  game.start();
}

function startMatch(s: MatchSettings): void {
  teardown();
  settings = s;
  menu.hidden = true;
  result.hidden = true;
  help.hidden = true;
  confirmBox.hidden = true;
  hud.show(true);

  const g = new Game(canvas, s, {
    onEvents: handleEvents,
    onSelectionChange: (n, byUser) => {
      hud.setSelection(n);
      if (byUser) selectSound(n);
    },
    onEnd: showResult,
    onFrame: (dt) => {
      alerts?.update(dt);
      minimap?.update(dt);
      // 목표 지정은 키보드 · 버튼 · 터치 · 미니맵 어디서든 켜지고 꺼지므로 매 프레임 맞춘다 (바뀔 때만 DOM 을 건드린다)
      syncBanner();
    },
  });
  game = g;
  if (new URLSearchParams(location.search).has('debug')) Object.assign(window, { __game: g, __sfx: sfx });
  input = new InputController(canvas, g, { onKey: handleKey });
  const avoid = ['minimap', 'minimap-tools', 'toasts', 'banner'].map((id) => $(id));
  alerts = new Alerts($('alert-arrows'), g, avoid, (text, color) => hud.toast(text, color));
  minimap = new Minimap($<HTMLCanvasElement>('minimap'), g, alerts);
  hud.setSelection(0);
  hud.setFormation(g.formation);
  hud.setPaused(false);
  hud.setSpeed(1);
  hud.update(g.world);
  syncWave();
  layout(true);
  g.start();
  sfx.startAmbient();
  hudTimer = window.setInterval(() => {
    hud.update(g.world);
    syncWave();
  }, 200);
  hud.toast(coarsePointer.matches ? '아군 행성을 탭해 병력을 고르고, 목표를 탭하세요' : '아군 행성을 클릭해 병력을 고르고, 목표를 우클릭하세요', '#4fc3f7', 6000);
  const waves = g.match.waves;
  if (waves) hud.toast(`첫 침공까지 ${clock(waves.schedule[0].spawnAt)} · 주변 행성을 먼저 확보하세요`, g.world.factions[waves.faction].color, 7000);
}

function showResult(winner: number): void {
  if (!game) return;
  const w = game.world;
  const me = w.factions[PLAYER];
  const won = winner === PLAYER;
  const waves = game.match.waves;
  const rows: [string, number | string][] = [];
  if (waves) {
    $('result-title').textContent = won ? '방어 성공!' : '모성 함락';
    $('result-sub').textContent = `${formatTime(w.time)} · 방어전 · ${DIFFICULTY_LABEL[settings.difficulty]} · 시드 ${settings.seed}`;
    rows.push(['버틴 웨이브', `${waves.survived(w)} / ${waves.totalWaves}`]);
  } else {
    $('result-title').textContent = won ? '승리!' : '패배';
    $('result-sub').textContent = `${formatTime(w.time)} · 적 ${settings.aiCount} · ${DIFFICULTY_LABEL[settings.difficulty]} · 시드 ${settings.seed}`;
  }
  rows.push(
    ['점령한 행성', me.stats.planetsCaptured],
    ['생산한 병력', me.stats.produced],
    ['격추', me.stats.kills],
    ['잃은 병력', me.stats.lost],
  );
  $('result-stats').innerHTML = rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');
  sfx.stopAmbient(2.5);
  sfx.stinger(won ? 'victory' : 'defeat');
  const g = game;
  window.clearTimeout(resultTimer);
  resultTimer = window.setTimeout(() => {
    if (game !== g) return;
    // 도움말 · 나가기 확인창 위에 겹치지 않게 닫는다. 끝나기 직전에 누른 HUD 버튼에 남은 포커스도 떼어
    // Enter · Space 가 가려진 그 버튼을 누르지 않게 한다
    help.hidden = true;
    confirmBox.hidden = true;
    result.hidden = false;
    (document.activeElement as HTMLElement | null)?.blur();
  }, 1200);
}

function layout(refit: boolean): void {
  if (!game) return;
  // 미니맵 크기가 명령 바 위치(--minimap-reserve)를 정하므로 인셋을 재기 전에 먼저 맞춘다
  minimap?.layout();
  alerts?.layout();
  const insets = game.spectator ? { top: 24, bottom: 24, left: 24, right: 24 } : hud.insets();
  game.resize(window.innerWidth, window.innerHeight, insets, refit);
}

// ───────────────────────────── 게임 중 UI ─────────────────────────────

function handleEvents(events: readonly GameEvent[]): void {
  if (!game) return;
  alerts?.consume(events);
  const w = game.world;
  const cam = game.camera;
  const a = cam.toWorld(0, 0);
  const b = cam.toWorld(cam.width, cam.height);
  sfx.handleEvents(events, w, { x0: a.x, y0: a.y, x1: b.x, y1: b.y });
  for (const e of events) {
    if (e.type === 'capture') {
      // 화면 안의 점령 · 함락은 렌더러가 행성 위에 '점령!' · '함락' 을 띄우므로, 토스트로는 화면 밖 행성만 알린다
      const p = w.planets[e.planetId];
      if (p.x >= a.x && p.x <= b.x && p.y >= a.y && p.y <= b.y) continue;
      if (e.to === PLAYER) hud.toast(e.from === 0 ? '중립 행성 점령!' : `${w.factions[e.from].name}의 행성 탈취!`, w.factions[PLAYER].color);
      else if (e.from === PLAYER) hud.toast(`${w.factions[e.to].name}에게 행성을 빼앗겼습니다`, w.factions[e.to].color);
    } else if (e.type === 'eliminated' && e.faction !== PLAYER) {
      hud.toast(`${w.factions[e.faction].name} 섬멸!`, w.factions[e.faction].color, 3500);
    } else if (e.type === 'wave' && e.phase === 'warning') {
      const waves = game.match.waves;
      const color = waves ? w.factions[waves.faction].color : '#ff4fa3';
      // 예고 시간 동안 어디에 얼마나 보낼지 정할 수 있게, 실제로 열린 게이트에서 규모와 게이트 수를 센다
      const gates = w.gates.filter((g) => g.wave === e.wave);
      const size = gates.reduce((s, g) => s + g.count, 0);
      const head = e.wave === e.total ? '마지막 웨이브' : `웨이브 ${e.wave}`;
      hud.toast(`${head} 접근 중! ${size}기 · 게이트 ${gates.length}`, color, 3500);
    }
  }
}

/**
 * 방어전 웨이브 표시: 다음 웨이브가 예고됐거나 전장이 비어 있으면 남은 시간, 아니면 진행 중.
 * 마지막 웨이브까지 다 나온 뒤에는 남은 승리 조건(침공군 섬멸 → 침공군 행성 탈환)을 보여 준다.
 */
function syncWave(): void {
  const waves = game?.match.waves;
  if (!game || !waves) {
    hud.setWave(null);
    return;
  }
  const w = game.world;
  const head = `웨이브 ${waves.wave}/${waves.totalWaves}`;
  const next = waves.nextSpawnAt;
  if (w.winner !== null) {
    hud.setWave(`${head} · ${w.winner === PLAYER ? '방어 성공' : '함락'}`);
  } else if (next !== null && (waves.warned || !waves.inProgress)) {
    hud.setWave(`${head} · 다음 ${clock(next - w.time)}`, waves.warned);
  } else if (next === null) {
    const left = invaderTally(waves, w);
    if (left.units > 0) hud.setWave(`${head} · 침공군 ${left.units}기 남음`);
    else if (left.planets > 0) hud.setWave(`${head} · 침공군 행성 ${left.planets}곳 탈환`);
    else hud.setWave(`${head} · 진행 중`);
  } else {
    hud.setWave(`${head} · 진행 중`);
  }
}

/** WaveDirector 의 남은 침공군 집계 (병력 = 전장 + 게이트에서 아직 안 나온 수, 행성 = 침공군 행성 수) */
type InvaderTally = Partial<Record<'remainingInvaders' | 'invaderPlanets', (world: World) => number>>;

/** 집계 메서드가 없는 WaveDirector 에서도 돌도록, 없으면 같은 값을 월드에서 직접 센다 */
function invaderTally(waves: WaveDirector, w: World): { units: number; planets: number } {
  const t = waves as WaveDirector & InvaderTally;
  return {
    units: t.remainingInvaders?.(w) ?? w.unitCount[waves.faction] + w.gates.reduce((s, g) => s + g.remaining, 0),
    planets: t.invaderPlanets?.(w) ?? w.planetCount[waves.faction],
  };
}

function syncBanner(): void {
  // 휴대폰에는 Esc 가 없다: 터치에서는 해제 버튼으로 취소한다
  const text = coarsePointer.matches ? '목표를 탭하세요 (해제로 취소)' : '목표를 클릭하세요 (Esc 취소)';
  hud.setBanner(game?.overlay.targeting ? text : null);
}

function togglePause(force?: boolean): void {
  if (!game) return;
  game.paused = force ?? !game.paused;
  hud.setPaused(game.paused);
  sfx.setPaused(game.paused);
}

function handleKey(action: 'pause' | 'formation' | 'speed' | 'alert'): void {
  if (!game) return;
  if (action === 'alert') {
    // 돌아갈 알림이 한 번도 없었으면 아무 일도 일어나지 않으므로 거절음
    sfx.ui(alerts?.jumpNext() ? 'click' : 'deny');
    return;
  }
  if (action === 'pause') togglePause();
  else if (action === 'formation') toggleFormation(game);
  else {
    game.speed = SPEEDS[(SPEEDS.indexOf(game.speed) + 1) % SPEEDS.length];
    hud.setSpeed(game.speed);
  }
  if (action !== 'formation') sfx.ui('click');
}

function toggleFormation(g: Game): void {
  const f = g.toggleFormation();
  hud.setFormation(f);
  sfx.ui('toggle', f === 'spread' ? 1 : 0);
}

function runCommand(cmd: string): void {
  const g = game;
  if (!g) return;
  // 선택이 바뀌면 선택음(selectSound), 할 수 없는 명령이면 거절음.
  // 전체 공격 · 귀환은 키보드(G · R)와 같은 소리가 나도록 Game 이 성공음 · 거절음을 낸다
  switch (cmd) {
    case 'select-all':
      g.selectAll();
      if (g.selection.size === 0) sfx.ui('deny');
      break;
    case 'halve':
      if (g.selection.size <= 1) sfx.ui('deny');
      g.halveSelection();
      break;
    case 'clear':
      g.clearSelection();
      sfx.ui('click');
      break;
    case 'formation':
      toggleFormation(g);
      break;
    case 'attack-all':
      g.attackAll();
      break;
    case 'return':
      g.commandReturn();
      break;
  }
}

function formatTime(sec: number): string {
  const t = Math.floor(sec);
  return `${Math.floor(t / 60)}분 ${t % 60}초`;
}

/** 남은 시간 m:ss (올림: 0:00 은 출현 순간에만) */
function clock(sec: number): string {
  const t = Math.max(0, Math.ceil(sec));
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
}

// ───────────────────────────── 바인딩 ─────────────────────────────

document.querySelectorAll<HTMLElement>('.command-bar [data-cmd]').forEach((btn) => {
  btn.addEventListener('click', () => runCommand(btn.dataset.cmd!));
});

document.querySelectorAll<HTMLElement>('.seg').forEach((seg) => {
  seg.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest('button');
    if (!btn) return;
    seg.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b === btn));
  });
});

const segValue = (name: string) => document.querySelector<HTMLElement>(`.seg[data-name="${name}"] .on`)!.dataset.v!;
const setSeg = (name: string, v: string) =>
  document.querySelectorAll<HTMLElement>(`.seg[data-name="${name}"] button`).forEach((b) => b.classList.toggle('on', b.dataset.v === v));

/** 방어전에는 적 진영이 침공군 하나뿐이라 진영 수 선택을 숨긴다 */
function syncModeField(): void {
  const mode = segValue('mode') as GameMode;
  $('field-aiCount').hidden = mode === 'defense';
  $('mode-desc').textContent = MODE_DESC[mode];
}
document.querySelector('.seg[data-name="mode"]')!.addEventListener('click', syncModeField);

// 도움말의 방어전 수치는 설정값에서 채운다 (밸런스를 바꿔도 글이 어긋나지 않게)
document.querySelectorAll<HTMLElement>('[data-defense]').forEach((el) => {
  el.textContent = String(DEFENSE[el.dataset.defense as 'totalWaves' | 'warningLead']);
});

$('seed-random').addEventListener('click', () => (seedInput.value = String(randomSeed())));
$('btn-start').addEventListener('click', () => {
  sfx.unlock();
  startMatch({
    aiCount: Number(segValue('aiCount')),
    difficulty: segValue('difficulty') as Difficulty,
    seed: Number(seedInput.value) || randomSeed(),
    portrait: isPortrait(),
    mode: segValue('mode') as GameMode,
  });
});

// 대화창을 열면 포커스를 그 안의 버튼으로 옮긴다: 방금 누른 HUD 버튼(? · ☰)에 포커스가 남아 있으면
// Enter · Space 가 가려진 그 버튼을 다시 눌러, 열기 전의 일시정지 상태를 덮어쓴다
let pausedBeforeHelp = false;
const openHelp = () => {
  if (!help.hidden) return;
  pausedBeforeHelp = !!game?.paused;
  if (game && !game.spectator) togglePause(true);
  help.hidden = false;
  // 닫기 버튼은 긴 도움말의 맨 아래에 있다: 포커스를 옮겨도 스크롤은 맨 위(규칙)에 둔다
  $('btn-help-close').focus({ preventScroll: true });
};
const closeHelp = () => {
  help.hidden = true;
  if (game && !game.spectator) togglePause(pausedBeforeHelp);
};
$('btn-howto').addEventListener('click', openHelp);
$('btn-help').addEventListener('click', openHelp);
$('btn-help-close').addEventListener('click', closeHelp);

$('btn-pause').addEventListener('click', () => togglePause());
$('btn-speed').addEventListener('click', () => handleKey('speed'));
$('btn-fit').addEventListener('click', () => game?.toggleOverview());
$('btn-home').addEventListener('click', () => game?.focusHome());
// window.confirm 은 모바일 웹뷰/임베드 환경에서 막히는 경우가 있어 화면 안 확인창을 쓴다.
let pausedBeforeConfirm = false;
$('btn-menu').addEventListener('click', () => {
  if (!confirmBox.hidden) return;
  pausedBeforeConfirm = !!game?.paused;
  togglePause(true);
  confirmBox.hidden = false;
  $('btn-confirm-stay').focus();
});
const closeConfirm = () => {
  confirmBox.hidden = true;
  togglePause(pausedBeforeConfirm);
};
$('btn-confirm-leave').addEventListener('click', showMenu);
$('btn-confirm-stay').addEventListener('click', closeConfirm);
$('btn-retry').addEventListener('click', () => {
  sfx.unlock();
  startMatch(settings);
});
$('btn-to-menu').addEventListener('click', showMenu);

// 대화창(메뉴 · 도움말 · 나가기 확인 · 결과)이 떠 있는 동안 게임 단축키(P · G · 방향키 …)가 가려진 판을 움직이지 않게,
// window 버블 단계에서 듣는 입력 컨트롤러보다 먼저(캡처 단계) 전파를 끊는다. 기본 동작은 막지 않으므로
// Tab · Enter · Space 는 대화창 안의 버튼을 다루고, 시드 입력칸 타이핑과 M(소리)은 그대로 된다. Esc 는 도움말 · 확인창을 닫는다.
window.addEventListener(
  'keydown',
  (e) => {
    if (menu.hidden && help.hidden && confirmBox.hidden && result.hidden) return;
    if (e.target instanceof HTMLInputElement || e.code === 'KeyM') return;
    e.stopPropagation();
    if (e.code !== 'Escape') return;
    if (!confirmBox.hidden) closeConfirm();
    else if (!help.hidden) closeHelp();
  },
  true,
);

window.addEventListener('resize', () => layout(false));
// 상단 바 높이가 바뀌면(진영 칩 줄바꿈 · 웨이브 표시) 카메라의 보이는 영역도 다시 잰다
hud.watchTopBar(() => layout(false));
document.addEventListener('visibilitychange', () => {
  if (document.hidden && game && !game.spectator) togglePause(true);
  sfx.setHidden(document.hidden);
});

// ───────────────────────────── 소리 ─────────────────────────────

// 브라우저는 사용자 제스처 안에서만 소리를 허락한다: 첫 입력 때 깨운다.
// resume() 은 비동기라 첫 시도가 실패할 수도 있으므로, 실제로 돌기 시작한 뒤에야 듣기를 멈춘다
const unlockAudio = () => {
  sfx.unlock();
  if (!sfx.running) return;
  window.removeEventListener('pointerdown', unlockAudio, true);
  window.removeEventListener('keydown', unlockAudio, true);
};
window.addEventListener('pointerdown', unlockAudio, true);
window.addEventListener('keydown', unlockAudio, true);

// 버튼 '톡'. 자기 소리가 따로 있는 버튼(명령 바 · 소리 · 배속)은 각 핸들러에서 낸다
document.addEventListener('click', (e) => {
  const btn = (e.target as HTMLElement).closest('button');
  if (btn && !btn.matches('[data-cmd], #btn-sound, #btn-speed')) sfx.ui('click');
});

const soundBtn = $<HTMLButtonElement>('btn-sound');
function syncSound(): void {
  soundBtn.classList.toggle('off', sfx.muted);
  soundBtn.setAttribute('aria-pressed', String(!sfx.muted));
}
function toggleSound(): void {
  sfx.unlock();
  sfx.toggleMuted();
  syncSound();
  sfx.ui('toggle', 1); // 켤 때만 들린다 (음소거 중엔 아무 소리도 내지 않는다)
}
soundBtn.addEventListener('click', toggleSound);
window.addEventListener('keydown', (e) => {
  if (e.code === 'KeyM' && !e.repeat && !(e.target instanceof HTMLInputElement)) toggleSound();
});
syncSound();

// 선택음: 플레이어가 고른 경우만 (고른 병력이 죽어서 선택이 줄어드는 변화는 Game 이 byUser=false 로 알려 준다)
let selectTimer = 0;
function selectSound(n: number): void {
  if (n === 0) return;
  // 한 번의 입력으로 여러 번 바뀌어도(추가 선택 등) 마지막 결과로 한 번만
  window.clearTimeout(selectTimer);
  selectTimer = window.setTimeout(() => sfx.ui('select', n), 30);
}

// ?play 로 바로 시작 (개발/테스트용): ?play&ai=2&difficulty=hard&seed=42, 방어전은 &mode=defense
const params = new URLSearchParams(location.search);
if (params.has('play')) {
  startMatch({
    aiCount: Number(params.get('ai')) || 1,
    difficulty: (params.get('difficulty') as Difficulty) || 'normal',
    seed: Number(params.get('seed')) || randomSeed(),
    portrait: isPortrait(),
    mode: params.get('mode') === 'defense' ? 'defense' : 'conquest',
  });
} else {
  showMenu();
}
