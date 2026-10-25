import './style.css';
import type { Difficulty } from './config';
import { Game } from './game';
import { InputController } from './input/controller';
import { Minimap } from './render/minimap';
import type { MatchSettings } from './sim/match';
import { PLAYER, type GameEvent, type GameMode } from './sim/types';
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
  defense: '가장자리 게이트로 몰려오는 12번의 침공에서 모성을 지켜라',
};
const SPEEDS = [1, 2, 3];

let game: Game | null = null;
let input: InputController | null = null;
let minimap: Minimap | null = null;
let alerts: Alerts | null = null;
let hudTimer = 0;
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
  game?.stop();
  input?.dispose();
  minimap?.dispose();
  alerts?.dispose();
  window.clearInterval(hudTimer);
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
    onSelectionChange: (n) => {
      hud.setSelection(n);
      syncBanner();
    },
    onEnd: showResult,
    onFrame: (dt) => {
      alerts?.update(dt);
      minimap?.update(dt);
    },
  });
  game = g;
  if (new URLSearchParams(location.search).has('debug')) Object.assign(window, { __game: g });
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
  hudTimer = window.setInterval(() => {
    hud.update(g.world);
    syncWave();
    syncBanner();
  }, 200);
  const touch = window.matchMedia('(pointer: coarse)').matches;
  hud.toast(touch ? '아군 행성을 탭해 병력을 고르고, 목표를 탭하세요' : '아군 행성을 클릭해 병력을 고르고, 목표를 우클릭하세요', '#4fc3f7', 6000);
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
  window.setTimeout(() => (result.hidden = false), 1200);
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
  for (const e of events) {
    if (e.type === 'capture') {
      if (e.to === PLAYER) hud.toast(e.from === 0 ? '중립 행성 점령!' : `${w.factions[e.from].name}의 행성 탈취!`, w.factions[PLAYER].color);
      else if (e.from === PLAYER) hud.toast(`${w.factions[e.to].name}에게 행성을 빼앗겼습니다`, w.factions[e.to].color);
    } else if (e.type === 'eliminated' && e.faction !== PLAYER) {
      hud.toast(`${w.factions[e.faction].name} 섬멸!`, w.factions[e.faction].color, 3500);
    } else if (e.type === 'wave' && e.phase === 'warning') {
      const waves = game.match.waves;
      const color = waves ? w.factions[waves.faction].color : '#ff4fa3';
      hud.toast(e.wave === e.total ? '마지막 웨이브 접근 중!' : `웨이브 ${e.wave} 접근 중!`, color, 3500);
    }
  }
}

/** 방어전 웨이브 표시: 다음 웨이브가 예고됐거나 전장이 비어 있으면 남은 시간, 아니면 진행 중 */
function syncWave(): void {
  const waves = game?.match.waves;
  if (!game || !waves) {
    hud.setWave(null);
    return;
  }
  const head = `웨이브 ${waves.wave}/${waves.totalWaves}`;
  const next = waves.nextSpawnAt;
  const winner = game.world.winner;
  if (winner !== null) {
    hud.setWave(`${head} · ${winner === PLAYER ? '방어 성공' : '함락'}`);
  } else if (next !== null && (waves.warned || !waves.inProgress)) {
    hud.setWave(`${head} · 다음 ${clock(next - game.world.time)}`, waves.warned);
  } else {
    hud.setWave(`${head} · 진행 중`);
  }
}

function syncBanner(): void {
  hud.setBanner(game?.overlay.targeting ? '목표를 지정하세요 · 클릭/탭 (Esc 취소)' : null);
}

function togglePause(force?: boolean): void {
  if (!game) return;
  game.paused = force ?? !game.paused;
  hud.setPaused(game.paused);
}

function handleKey(action: 'pause' | 'formation' | 'speed' | 'alert'): void {
  if (!game) return;
  if (action === 'pause') togglePause();
  else if (action === 'alert') alerts?.jumpNext();
  else if (action === 'formation') hud.setFormation(game.toggleFormation());
  else {
    game.speed = SPEEDS[(SPEEDS.indexOf(game.speed) + 1) % SPEEDS.length];
    hud.setSpeed(game.speed);
  }
}

function runCommand(cmd: string): void {
  const g = game;
  if (!g) return;
  switch (cmd) {
    case 'select-all':
      g.selectAll();
      break;
    case 'halve':
      g.halveSelection();
      break;
    case 'clear':
      g.clearSelection();
      break;
    case 'formation':
      hud.setFormation(g.toggleFormation());
      break;
    case 'attack-all':
      g.attackAll();
      break;
    case 'return':
      g.commandReturn();
      break;
  }
  syncBanner();
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

$('seed-random').addEventListener('click', () => (seedInput.value = String(randomSeed())));
$('btn-start').addEventListener('click', () => {
  startMatch({
    aiCount: Number(segValue('aiCount')),
    difficulty: segValue('difficulty') as Difficulty,
    seed: Number(seedInput.value) || randomSeed(),
    portrait: isPortrait(),
    mode: segValue('mode') as GameMode,
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
$('btn-fit').addEventListener('click', () => game?.toggleOverview());
$('btn-home').addEventListener('click', () => game?.focusHome());
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
$('btn-retry').addEventListener('click', () => startMatch(settings));
$('btn-to-menu').addEventListener('click', showMenu);

window.addEventListener('resize', () => layout(false));
document.addEventListener('visibilitychange', () => {
  if (document.hidden && game && !game.spectator) togglePause(true);
});

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
