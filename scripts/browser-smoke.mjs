// Node.js + Chromium 만 사용한다. 앱의 테스트 의존성이나 브라우저 다운로드는 추가하지 않는다.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createServer } from 'vite';

const chromium = process.env.CHROMIUM_PATH ?? 'chromium';
assert.equal(spawnSync(chromium, ['--version']).status, 0, 'Chromium 이 필요합니다. 설치된 실행 파일을 CHROMIUM_PATH 로 지정할 수 있습니다.');
const suppliedBase = process.argv.find((arg) => arg.startsWith('--base='))?.slice(7);
const screenshots = process.argv.find((arg) => arg.startsWith('--screenshots='))?.slice(14);
const server = suppliedBase ? null : await createServer({ server: { host: '127.0.0.1', port: 0 }, clearScreen: false });
await server?.listen();
const base = suppliedBase ?? server.resolvedUrls.local[0].replace(/\/$/, '');
if (screenshots) mkdirSync(screenshots, { recursive: true });
const profile = mkdtempSync(join(tmpdir(), 'planet-smoke-'));
const browser = spawn(chromium, [
  '--headless', '--no-sandbox', '--disable-dev-shm-usage', '--disable-background-networking',
  '--no-first-run', '--no-default-browser-check', '--remote-debugging-pipe',
  `--user-data-dir=${profile}`, 'about:blank',
], { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] });
let seq = 0, buffer = '', diagnostic = '', session;
let touch = false;
const pending = new Map(), errors = [];
browser.stderr.on('data', (chunk) => { diagnostic = (diagnostic + chunk).slice(-3000); });
browser.stdio[4].on('data', (chunk) => {
  buffer += chunk.toString();
  let end;
  while ((end = buffer.indexOf('\0')) >= 0) {
    const msg = JSON.parse(buffer.slice(0, end));
    buffer = buffer.slice(end + 1);
    if (msg.id && pending.has(msg.id)) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new Error(JSON.stringify(msg.error)));
      else p.resolve(msg.result);
    } else if (msg.method === 'Runtime.exceptionThrown') {
      errors.push(msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text);
    } else if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
      errors.push(msg.params.args.map((a) => a.value ?? a.description).join(' '));
    }
  }
});
function send(method, params = {}, sessionId) {
  if (browser.exitCode !== null) return Promise.reject(new Error(`Chromium exited: ${diagnostic}`));
  return new Promise((resolve, reject) => {
    const id = ++seq;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}\n${diagnostic}`)); }, 15000);
    pending.set(id, { resolve, reject, timer });
    browser.stdio[3].write(JSON.stringify({ id, method, params, sessionId }) + '\0');
  });
}
async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, session);
  assert.equal(r.exceptionDetails, undefined, JSON.stringify(r.exceptionDetails));
  return r.result.value;
}
async function until(expression) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (await evaluate(expression)) return;
    await delay(80);
  }
  throw new Error(`Readiness failed: ${expression}`);
}
async function navigate(query) {
  const previous = await evaluate('performance.timeOrigin');
  const target = new URL(base);
  if (!target.pathname.endsWith('/') && !target.pathname.endsWith('.html')) target.pathname += '/';
  target.search = query;
  const r = await send('Page.navigate', { url: target.href }, session);
  assert.equal(r.errorText, undefined);
  await until(`performance.timeOrigin !== ${previous} && document.readyState === 'complete'`);
}
async function click(selector) {
  const point = await evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    el.scrollIntoView({block:'center'});
    const r = el.getBoundingClientRect(), x = r.x + r.width/2, y = r.y + r.height/2;
    return {x,y,reachable:el.contains(document.elementFromPoint(x,y))};
  })()`);
  assert.ok(point.reachable, `Control covered or offscreen: ${selector}`);
  const { x, y } = point;
  if (touch) {
    await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] }, session);
    await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }, session);
  } else {
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 }, session);
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 }, session);
  }
}
async function screenshot(name) {
  if (!screenshots) return;
  const { data } = await send('Page.captureScreenshot', { format: 'webp', quality: 82 }, session);
  writeFileSync(join(screenshots, `${name}.webp`), Buffer.from(data, 'base64'));
}
async function viewport(width, height, mobile) {
  touch = mobile;
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile }, session);
  await send('Emulation.setTouchEmulationEnabled', { enabled: mobile }, session);
}

try {
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  session = (await send('Target.attachToTarget', { targetId, flatten: true })).sessionId;
  await send('Runtime.enable', {}, session);
  await send('Page.enable', {}, session);
  for (const design of ['original', 'codex']) {
    for (const [width, height, mobile] of [[1280, 800, false], [390, 844, true], [320, 568, true], [844, 390, true]]) {
      await viewport(width, height, mobile);
      await navigate(`?design=${design}&seed=42&ai=2&difficulty=hard&debug`);
      await until(`document.documentElement.dataset.design === '${design}' && document.querySelector('#seed')?.value === '42' && document.querySelector('#game')?.width === ${width}`);
      assert.ok(await evaluate("document.querySelector('#menu').scrollWidth <= document.querySelector('#menu').clientWidth + 1"), `${design}: menu overflows at ${width}`);
      if (width === 1280 || width === 390) await screenshot(`${design}-menu-${width}`);
      await click('#btn-start');
      await until('!!window.__game && window.__game.world.time > 0.3 && !document.querySelector("#hud").hidden');
      assert.equal(await evaluate('window.__game.match.settings.seed'), 42);
      assert.equal(await evaluate('window.__game.match.settings.aiCount'), 2);
      await click('[data-cmd="select-all"]');
      assert.ok(await evaluate('window.__game.selection.size > 0'));
      await click('#btn-pause');
      assert.equal(await evaluate('window.__game.paused'), true);
      const t = await evaluate('window.__game.world.time');
      await delay(100);
      assert.equal(await evaluate('window.__game.world.time'), t);
      await click('#btn-pause');
      await until(`window.__game.world.time > ${t}`);
      if (width === 1280 || width === 390) await screenshot(`${design}-game-${width}`);
      // 3인전에서 플레이어가 먼저 전멸해도 실제 결과 화면이 열린다.
      if (width === 1280) {
        await evaluate(`(() => { const w=window.__game.world; for(const p of w.planets) if(p.owner===1) w.capture(p,2); for(const u of w.units) if(u.faction===1) u.hp=0; })()`);
        await until('!document.querySelector("#result").hidden');
        assert.equal(await evaluate('document.querySelector("#result-title").textContent'), '패배');
        assert.equal(await evaluate('window.__game.world.winner'), null);
      }
      console.log(`PASS ${design}: ${width}×${height}, start/select/pause/resume${width === 1280 ? '/defeat' : ''}`);
    }
    await viewport(390, 844, true);
    await navigate(`?design=${design}&play&mode=defense&seed=42&debug`);
    await until('!!window.__game && window.__game.world.time > 0.3');
    assert.equal(await evaluate('window.__game.match.mode'), 'defense');
    assert.equal(await evaluate('document.querySelector("#wave").hidden'), false);
    await click('#btn-help');
    assert.equal(await evaluate('window.__game.paused'), true);
    await click('#btn-help-close');
    assert.equal(await evaluate('window.__game.paused'), false);
    console.log(`PASS ${design}: mobile defense/help`);
  }
  await viewport(1280, 800, false);
  await navigate('?design=original&seed=42&ai=2&difficulty=hard&debug');
  await until('document.querySelector("#seed")?.value === "42"');
  await click('.seg[data-name="mode"] [data-v="defense"]');
  await evaluate('document.querySelector("#seed").value = "0"');
  await click('.design-switch a:last-child');
  await until('document.documentElement.dataset.design === "codex" && document.querySelector("#seed")?.value === "0"');
  assert.equal(await evaluate('document.querySelector(".seg[data-name=mode] .on").dataset.v'), 'defense');
  assert.equal(await evaluate('document.querySelector(".seg[data-name=aiCount] .on").dataset.v'), '2');
  assert.equal(await evaluate('document.querySelector(".seg[data-name=difficulty] .on").dataset.v'), 'hard');
  await click('#btn-start');
  await until('!!window.__game && window.__game.world.time > 0.2');
  assert.equal(await evaluate('window.__game.match.settings.seed'), 0);
  console.log('PASS design comparison preserves mode/AI/difficulty/seed, including seed 0');
  assert.deepEqual(errors, []);
  console.log('Browser smoke passed; no JavaScript exceptions or console errors.');
} finally {
  if (browser.exitCode === null) await send('Browser.close').catch(() => {});
  if (browser.exitCode === null) await Promise.race([new Promise((resolve) => browser.once('exit', resolve)), delay(2000)]);
  if (browser.exitCode === null) browser.kill('SIGKILL');
  for (const p of pending.values()) clearTimeout(p.timer);
  rmSync(profile, { recursive: true, force: true });
  await server?.close();
}
