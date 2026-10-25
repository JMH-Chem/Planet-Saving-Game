import './style.css';
import { sfx } from './audio/sfx';
import type { Difficulty } from './config';
import { Game } from './game';
import { InputController } from './input/controller';
import type { MatchSettings } from './sim/match';
import { PLAYER, type GameEvent } from './sim/types';
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
const SPEEDS = [1, 2, 3];

let game: Game | null = null;
let input: InputController | null = null;
let hudTimer = 0;
let settings: MatchSettings = { aiCount: 1, difficulty: 'normal', seed: randomSeed() };

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
  window.clearInterval(hudTimer);
  game = null;
  input = null;
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
    onSelectionChange: (n) => {
      hud.setSelection(n);
      syncBanner();
      selectSound(n);
    },
    onEnd: showResult,
  });
  game = g;
  if (new URLSearchParams(location.search).has('debug')) Object.assign(window, { __game: g, __sfx: sfx });
  input = new InputController(canvas, g, { onKey: handleKey });
  hud.setSelection(0);
  hud.setFormation(g.formation);
  hud.setPaused(false);
  hud.setSpeed(1);
  hud.update(g.world);
  layout(true);
  g.start();
  sfx.startAmbient();
  hudTimer = window.setInterval(() => {
    hud.update(g.world);
    syncBanner();
  }, 200);
  const touch = window.matchMedia('(pointer: coarse)').matches;
  hud.toast(touch ? '아군 행성을 탭해 병력을 고르고, 목표를 탭하세요' : '아군 행성을 클릭해 병력을 고르고, 목표를 우클릭하세요', '#4fc3f7', 6000);
}

function showResult(winner: number): void {
  if (!game) return;
  const w = game.world;
  const me = w.factions[PLAYER];
  const won = winner === PLAYER;
  $('result-title').textContent = won ? '승리!' : '패배';
  $('result-sub').textContent = `${formatTime(w.time)} · 적 ${settings.aiCount} · ${DIFFICULTY_LABEL[settings.difficulty]} · 시드 ${settings.seed}`;
  const rows: [string, number | string][] = [
    ['점령한 행성', me.stats.planetsCaptured],
    ['생산한 병력', me.stats.produced],
    ['격추', me.stats.kills],
    ['잃은 병력', me.stats.lost],
  ];
  $('result-stats').innerHTML = rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');
  sfx.stopAmbient(2.5);
  sfx.stinger(won ? 'victory' : 'defeat');
  window.setTimeout(() => (result.hidden = false), 1200);
}

function layout(refit: boolean): void {
  if (!game) return;
  const insets = game.spectator ? { top: 24, bottom: 24, left: 24, right: 24 } : hud.insets();
  game.resize(window.innerWidth, window.innerHeight, insets, refit);
}

// ───────────────────────────── 게임 중 UI ─────────────────────────────

function handleEvents(events: readonly GameEvent[]): void {
  if (!game) return;
  const w = game.world;
  const cam = game.camera;
  const a = cam.toWorld(0, 0);
  const b = cam.toWorld(cam.width, cam.height);
  sfx.handleEvents(events, w, { x0: a.x, y0: a.y, x1: b.x, y1: b.y });
  for (const e of events) {
    if (e.type === 'capture') {
      if (e.to === PLAYER) hud.toast(e.from === 0 ? '중립 행성 점령!' : `${w.factions[e.from].name}의 행성 탈취!`, w.factions[PLAYER].color);
      else if (e.from === PLAYER) hud.toast(`${w.factions[e.to].name}에게 행성을 빼앗겼습니다`, w.factions[e.to].color);
    } else if (e.type === 'eliminated' && e.faction !== PLAYER) {
      hud.toast(`${w.factions[e.faction].name} 섬멸!`, w.factions[e.faction].color, 3500);
    }
  }
}

function syncBanner(): void {
  hud.setBanner(game?.overlay.targeting ? '목표를 지정하세요 · 클릭/탭 (Esc 취소)' : null);
}

function togglePause(force?: boolean): void {
  if (!game) return;
  game.paused = force ?? !game.paused;
  hud.setPaused(game.paused);
  sfx.setPaused(game.paused);
}

function handleKey(action: 'pause' | 'formation' | 'speed'): void {
  if (!game) return;
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
  // 선택이 바뀌면 선택음(selectSound), 할 수 없는 명령이면 거절음. 귀환 성공음은 명령 쪽(order)에서 낸다
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
      if (!g.overlay.targeting) sfx.ui('deny');
      break;
    case 'return':
      if (!g.commandReturn()) sfx.ui('deny');
      break;
  }
  syncBanner();
}

function formatTime(sec: number): string {
  const t = Math.floor(sec);
  return `${Math.floor(t / 60)}분 ${t % 60}초`;
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

$('seed-random').addEventListener('click', () => (seedInput.value = String(randomSeed())));
$('btn-start').addEventListener('click', () => {
  sfx.unlock();
  startMatch({
    aiCount: Number(segValue('aiCount')),
    difficulty: segValue('difficulty') as Difficulty,
    seed: Number(seedInput.value) || randomSeed(),
    portrait: isPortrait(),
  });
});

let pausedBeforeHelp = false;
const openHelp = () => {
  pausedBeforeHelp = !!game?.paused;
  if (game && !game.spectator) togglePause(true);
  help.hidden = false;
};
$('btn-howto').addEventListener('click', openHelp);
$('btn-help').addEventListener('click', openHelp);
$('btn-help-close').addEventListener('click', () => {
  help.hidden = true;
  if (game && !game.spectator) togglePause(pausedBeforeHelp);
});

$('btn-pause').addEventListener('click', () => togglePause());
$('btn-speed').addEventListener('click', () => handleKey('speed'));
$('btn-fit').addEventListener('click', () => game?.fitCamera());
// window.confirm 은 모바일 웹뷰/임베드 환경에서 막히는 경우가 있어 화면 안 확인창을 쓴다.
let pausedBeforeConfirm = false;
$('btn-menu').addEventListener('click', () => {
  pausedBeforeConfirm = !!game?.paused;
  togglePause(true);
  confirmBox.hidden = false;
});
$('btn-confirm-leave').addEventListener('click', showMenu);
$('btn-confirm-stay').addEventListener('click', () => {
  confirmBox.hidden = true;
  togglePause(pausedBeforeConfirm);
});
$('btn-retry').addEventListener('click', () => {
  sfx.unlock();
  startMatch(settings);
});
$('btn-to-menu').addEventListener('click', showMenu);

window.addEventListener('resize', () => layout(false));
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

// 선택음: 선택한 병력이 죽어서 선택이 줄어드는 변화(매 프레임 정리)에는 울리지 않도록,
// 입력 이벤트를 처리하는 중(직후 50ms)이거나 길게 누르기가 일어나는 순간의 변화만 사용자 선택으로 본다.
let inputAt = 0;
let pressAt = -1;
let selectTimer = 0;
for (const type of ['pointerdown', 'pointerup', 'click', 'keydown']) {
  window.addEventListener(type, () => (inputAt = performance.now()), true);
}
window.addEventListener('pointerdown', () => (pressAt = performance.now()), true);
window.addEventListener('pointerup', () => (pressAt = -1), true);
window.addEventListener('pointercancel', () => (pressAt = -1), true);

function selectSound(n: number): void {
  const now = performance.now();
  const longPress = pressAt >= 0 && now - pressAt > 400 && now - pressAt < 700;
  if (n === 0 || (now - inputAt > 50 && !longPress)) return;
  // 한 번의 입력으로 여러 번 바뀌어도(추가 선택 등) 마지막 결과로 한 번만
  window.clearTimeout(selectTimer);
  selectTimer = window.setTimeout(() => sfx.ui('select', n), 30);
}

// ?play 로 바로 시작 (개발/테스트용): ?play&ai=2&difficulty=hard&seed=42
const params = new URLSearchParams(location.search);
if (params.has('play')) {
  startMatch({
    aiCount: Number(params.get('ai')) || 1,
    difficulty: (params.get('difficulty') as Difficulty) || 'normal',
    seed: Number(params.get('seed')) || randomSeed(),
    portrait: isPortrait(),
  });
} else {
  showMenu();
}
