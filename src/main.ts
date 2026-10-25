import './style.css';
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
  hud.show(true);

  const g = new Game(canvas, s, {
    onEvents: handleEvents,
    onSelectionChange: (n) => {
      hud.setSelection(n);
      syncBanner();
    },
    onEnd: showResult,
  });
  game = g;
  if (new URLSearchParams(location.search).has('debug')) Object.assign(window, { __game: g });
  input = new InputController(canvas, g, { onKey: handleKey });
  hud.setSelection(0);
  hud.setFormation(g.formation);
  hud.setPaused(false);
  hud.setSpeed(1);
  hud.update(g.world);
  layout(true);
  g.start();
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
}

function handleKey(action: 'pause' | 'formation' | 'speed'): void {
  if (!game) return;
  if (action === 'pause') togglePause();
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
$('btn-menu').addEventListener('click', () => {
  togglePause(true);
  if (window.confirm('메뉴로 나갈까요? 진행 중인 게임은 사라집니다.')) showMenu();
  else togglePause(false);
});
$('btn-retry').addEventListener('click', () => startMatch(settings));
$('btn-to-menu').addEventListener('click', showMenu);

window.addEventListener('resize', () => layout(false));
document.addEventListener('visibilitychange', () => {
  if (document.hidden && game && !game.spectator) togglePause(true);
});

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
