/* =====================================================================
 * verify/browser-drive.mjs
 * Edge を CDP（DevTools Protocol）で直接駆動するゼロ依存 E2E ドライバ。
 * Node 内蔵機能のみ使用（playwright / puppeteer 等は使わない）。
 *
 * 使い方:  node verify/browser-drive.mjs
 * 出力:    verify/screenshots/01..05*.png
 *          verify/battle-log-dump.txt   （戦闘ログ全文・UTF-8）
 *          verify/e2e-findings.json     （判定詳細・UTF-8）
 * 注意:    コンソールは cp932 のため ASCII のみ出力する。
 *          中文の判定テキストはファイルへ書き出して目視確認する。
 * ===================================================================== */
import { spawn, execSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SHOT_DIR = join(ROOT, 'verify', 'screenshots');
const PAGE_URL = 'file:///C:/CS/PY/93.Gm1/index.html';
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
mkdirSync(SHOT_DIR, { recursive: true });

/* ---- 判定結果の記録（コンソールは ASCII のみ） ---------------------- */
const steps = [];
function record(id, name, passed, detail) {
  steps.push({ id, name, passed, detail: detail === undefined ? null : detail });
  console.log(`[STEP ${id}] ${passed ? 'PASS' : 'FAIL'} ${name}`);
}
async function runStep(id, name, fn) {
  try {
    const d = await fn();
    record(id, name, !!d.passed, d);
  } catch (e) {
    record(id, name, false, { error: String((e && e.message) || e) });
  }
}

/* ---- CDP 接続 -------------------------------------------------------- */
let PORT = 9333;

async function pickPort() {
  // 既定ポートが既に応答する場合（残インスタンス等）は代替ポートへ切り替える
  try {
    await fetch(`http://127.0.0.1:${PORT}/json/version`, { signal: AbortSignal.timeout(800) });
    PORT = 9343;
  } catch { /* 未使用なのでそのまま使う */ }
}

async function findPageTarget(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastErr = 'unknown';
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const list = await res.json();
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page;
      lastErr = 'no page target in list';
    } catch (e) {
      lastErr = String((e && e.message) || e);
    }
    await sleep(300);
  }
  throw new Error('devtools endpoint not reachable: ' + lastErr);
}

function connectCdp(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const pending = new Map();
    const handlers = {};
    let seq = 0;
    ws.addEventListener('open', () => {
      resolve({
        send(method, params = {}) {
          return new Promise((res, rej) => {
            const id = ++seq;
            const timer = setTimeout(() => {
              pending.delete(id);
              rej(new Error('CDP timeout: ' + method));
            }, 30000);
            pending.set(id, (msg) => {
              clearTimeout(timer);
              if (msg.error) rej(new Error('CDP error ' + method + ': ' + JSON.stringify(msg.error)));
              else res(msg.result);
            });
            ws.send(JSON.stringify({ id, method, params }));
          });
        },
        on(method, fn) {
          (handlers[method] = handlers[method] || []).push(fn);
        },
        close() {
          try { ws.close(); } catch { /* ignore */ }
        }
      });
    });
    ws.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.id && pending.has(msg.id)) {
        const fn = pending.get(msg.id);
        pending.delete(msg.id);
        fn(msg);
      } else if (msg.method && handlers[msg.method]) {
        for (const fn of handlers[msg.method]) {
          try { fn(msg.params); } catch { /* ignore */ }
        }
      }
    });
    ws.addEventListener('error', () => reject(new Error('websocket error')));
  });
}

/* ---- 操作・検証ヘルパ ------------------------------------------------ */
async function evalJS(cdp, expression) {
  const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) {
    throw new Error('eval failed: ' + ((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text));
  }
  return r.result.value;
}

async function waitFor(cdp, expression, timeoutMs, intervalMs = 200) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let v = false;
    try { v = await evalJS(cdp, expression); } catch { /* 再試行 */ }
    if (v) return true;
    await sleep(intervalMs);
  }
  return false;
}

async function centerOf(cdp, selector) {
  return evalJS(cdp, `(() => {
    const e = document.querySelector(${JSON.stringify(selector)});
    if (!e) return null;
    const r = e.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), w: r.width, h: r.height };
  })()`);
}

async function clickAt(cdp, x, y) {
  // 実マウス操作（mousePressed / mouseReleased）でクリックする
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await sleep(40);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
}

async function setNumberInput(cdp, id, value) {
  // 実コントロール操作: クリックでフォーカス → Ctrl+A 全選択 → Backspace → 入力
  const c = await centerOf(cdp, '#' + id);
  if (!c || c.w < 4) throw new Error('input not visible: ' + id);
  await clickAt(cdp, c.x, c.y);
  await sleep(60);
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', modifiers: 2, windowsVirtualKeyCode: 17, code: 'ControlLeft', key: 'Control' });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', modifiers: 2, windowsVirtualKeyCode: 65, code: 'KeyA', key: 'a' });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', modifiers: 2, windowsVirtualKeyCode: 65, code: 'KeyA', key: 'a' });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', modifiers: 2, windowsVirtualKeyCode: 17, code: 'ControlLeft', key: 'Control' });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', windowsVirtualKeyCode: 8, code: 'Backspace', key: 'Backspace' });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: 8, code: 'Backspace', key: 'Backspace' });
  await cdp.send('Input.insertText', { text: String(value) });
  await sleep(60);
  let got = await evalJS(cdp, `document.getElementById(${JSON.stringify(id)}).value`);
  if (got !== String(value)) {
    // フォールバック: 実 input 要素の value をネイティブセッターで設定
    await evalJS(cdp, `(() => {
      const e = document.getElementById(${JSON.stringify(id)});
      const d = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
      d.set.call(e, ${JSON.stringify(String(value))});
      e.dispatchEvent(new Event('input', { bubbles: true }));
      e.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    got = await evalJS(cdp, `document.getElementById(${JSON.stringify(id)}).value`);
  }
  return got;
}

async function shotFull(cdp, path) {
  // ビューポートを文書全体の高さに広げてから撮影する（フルページ相当）
  const h = await evalJS(cdp, 'Math.max(document.documentElement.scrollHeight, window.innerHeight)');
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 1400, height: Math.min(Math.max(h, 600), 12000), deviceScaleFactor: 1, mobile: false
  });
  await sleep(280);
  const r = await cdp.send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(path, Buffer.from(r.data, 'base64'));
  await cdp.send('Emulation.clearDeviceMetricsOverride');
  await sleep(150);
  console.log('shot: ' + path);
}

/* ---- 戦闘ログの解析（仕様との突き合わせ） ---------------------------- */
const HUMAN_MAX_HP = 12, ZOMBIE_MAX_HP = 9;
const HUMAN_DMG = [1, 3], ZOMBIE_DMG = [1, 5];
const EXPECTED_NAMES = ['玩家1', '玩家2', '玩家3', '丧尸1', '丧尸2', '丧尸3'];

function parseOrderLine(l) {
  const m = l.match(/^(\d+)\. (.+?)（d100=([\d→]+)）$/);
  return m && { no: +m[1], name: m[2], rolls: m[3].split('→').map(Number) };
}

function parseActionLine(l) {
  const m = l.match(/^([^ ]+) → ([^ ]+)：(.*)$/);
  if (!m) return null;
  const actor = m[1], target = m[2], rest = m[3];
  const fail = rest.match(/^攻击检定 d7=(\d+) ＞ 攻击(\d+)，攻击失败$/);
  if (fail) {
    return { kind: 'fail', actor, target, atkRoll: +fail[1], atkVal: +fail[2], line: l };
  }
  const dodge = rest.match(/^攻击检定 d7=(\d+) ≤ 攻击(\d+)，命中；闪避检定 d7=(\d+) ≤ 敏捷(\d+)，闪避成功$/);
  if (dodge) {
    return { kind: 'dodge', actor, target, atkRoll: +dodge[1], atkVal: +dodge[2], dodgeRoll: +dodge[3], agiVal: +dodge[4], line: l };
  }
  const hit = rest.match(/^攻击检定 d7=(\d+) ≤ 攻击(\d+)，命中；闪避检定 d7=(\d+) ＞ 敏捷(\d+)，未闪避；伤害 (\d+)，(.+) 剩余 HP (\d+)(，倒地！)?$/);
  if (hit) {
    return {
      kind: 'hit', actor, target, atkRoll: +hit[1], atkVal: +hit[2], dodgeRoll: +hit[3], agiVal: +hit[4],
      dmg: +hit[5], targetRest: hit[6], remaining: +hit[7], downed: hit[8] === '，倒地！', line: l
    };
  }
  return { kind: 'unknown', actor, target, line: l };
}

function analyzeLog(lines) {
  const a = { header: false, order: [], rerolls: [], rounds: 0, actions: [], unknown: [], victory: null };
  for (const l of lines) {
    if (l.startsWith('【行动顺序】')) a.header = true;
    else if (/^\d+\. /.test(l)) a.order.push(l);
    else if (l.startsWith('【先攻重投】')) a.rerolls.push(l);
    else if (l.startsWith('── 第')) a.rounds++;
    else if (l.startsWith('战斗结束')) a.victory = l;
    else if (l.includes('→')) a.actions.push(l);
    else a.unknown.push(l);
  }
  a.orderParsed = a.order.map(parseOrderLine);
  a.actionsParsed = a.actions.map(parseActionLine);
  return a;
}

/* ログ全文を「状態リプレイ」で検証する。違反があればその行を violations へ */
function replayValidate(a, cfgMaxHp) {
  const v = [];
  const hpNow = {};
  const downedSet = new Set();
  for (const o of a.orderParsed) {
    if (!o) { v.push('order line unparsable: ' + a.order[a.orderParsed.indexOf(o)]); continue; }
    hpNow[o.name] = o.name.startsWith('玩家') ? cfgMaxHp.human : cfgMaxHp.zombie;
  }
  let ptr = 0;
  for (const act of a.actionsParsed) {
    if (!act) { v.push('action line unparsable'); continue; }
    if (act.kind === 'unknown') { v.push('unknown action shape: ' + act.line); continue; }
    // 行動者は order の循環上の次の非倒地者であること
    let found = -1;
    const n = a.orderParsed.length;
    for (let k = 0; k < n; k++) {
      const idx = (ptr + k) % n;
      const cand = a.orderParsed[idx];
      if (cand && !downedSet.has(cand.name)) { found = idx; break; }
    }
    if (found < 0 || a.orderParsed[found].name !== act.actor) {
      v.push('turn-order mismatch, expected ' + (found >= 0 ? a.orderParsed[found].name : '?') + ' got ' + act.actor);
    } else {
      ptr = (found + 1) % n;
    }
    if (downedSet.has(act.actor)) v.push('downed actor acted: ' + act.actor);
    if (downedSet.has(act.target)) v.push('downed target chosen: ' + act.target);
    const actorHuman = act.actor.startsWith('玩家');
    if (actorHuman === act.target.startsWith('玩家')) v.push('same-faction attack: ' + act.line);
    if (act.kind === 'fail') {
      if (!(act.atkRoll > act.atkVal)) v.push('fail line but roll<=attack: ' + act.line);
    } else if (act.kind === 'dodge') {
      if (!(act.atkRoll <= act.atkVal)) v.push('dodge line but atk roll>attack: ' + act.line);
      if (!(act.dodgeRoll <= act.agiVal)) v.push('dodge line but roll>agility: ' + act.line);
    } else if (act.kind === 'hit') {
      if (!(act.atkRoll <= act.atkVal)) v.push('hit line but atk roll>attack: ' + act.line);
      if (!(act.dodgeRoll > act.agiVal)) v.push('hit line but dodge roll<=agility: ' + act.line);
      const range = actorHuman ? HUMAN_DMG : ZOMBIE_DMG;
      if (act.dmg < range[0] || act.dmg > range[1]) v.push('damage out of range: ' + act.line);
      const expect = Math.max(0, hpNow[act.target] - act.dmg);
      if (expect !== act.remaining) v.push('hp mismatch expect ' + expect + ' got ' + act.remaining + ': ' + act.line);
      if (act.remaining === 0 && !act.downed) v.push('hp 0 but no downed mark: ' + act.line);
      if (act.remaining > 0 && act.downed) v.push('downed mark with hp>0: ' + act.line);
      hpNow[act.target] = act.remaining;
      if (act.downed) downedSet.add(act.target);
    }
  }
  return { violations: v, hpNow, downed: [...downedSet] };
}

function parseVictory(line) {
  if (!line) return null;
  const m = line.match(/^战斗结束：(人类阵营|丧尸阵营)获胜！存活角色：(.+)$/);
  if (!m) return null;
  const survivors = m[2].split('、').map((s) => {
    const p = s.match(/^(.+?)（HP (\d+)\/(\d+)）$/);
    return p && { name: p[1], hp: +p[2], maxHp: +p[3] };
  });
  if (!survivors.every(Boolean)) return null;
  return { faction: m[1], survivors };
}

/* ---- メイン ---------------------------------------------------------- */
let proc = null;
let userDataDir = null;
let cdp = null;

function cleanup() {
  try { if (cdp) cdp.close(); } catch { /* ignore */ }
  try {
    if (proc && proc.pid) {
      try { proc.kill(); } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
  try {
    if (proc && proc.pid) execSync(`taskkill /F /T /PID ${proc.pid}`, { stdio: 'ignore' });
  } catch { /* 既に終了している場合は無視 */ }
  try { if (userDataDir) rmSync(userDataDir, { recursive: true, force: true }); } catch { /* ignore */ }
}

async function main() {
  await pickPort();
  userDataDir = mkdtempSync(join(tmpdir(), 'edge-e2e-'));
  proc = spawn(EDGE, [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${userDataDir}`,
    '--window-size=1400,1000',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-sync',
    '--disable-gpu',
    'about:blank'
  ], { stdio: 'ignore' });

  const target = await findPageTarget(30000);
  cdp = await connectCdp(target.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  const loaded = new Promise((res) => cdp.on('Page.loadEventFired', res));
  await cdp.send('Page.navigate', { url: PAGE_URL });
  await Promise.race([loaded, sleep(10000)]);
  await sleep(600);

  /* -- STEP 1: 既定の設定画面 ---------------------------------------- */
  await runStep(1, 'config-ui-defaults', async () => {
    const c = await evalJS(cdp, `(() => {
      const g = (id) => document.getElementById(id);
      const ids = ['human-count','human-hp','human-attack','human-agility','human-dmgMin','human-dmgMax',
                   'zombie-count','zombie-hp','zombie-attack','zombie-agility','zombie-dmgMin','zombie-dmgMax'];
      const fields = {};
      for (const id of ids) fields[id] = g(id) ? g(id).value : null;
      const members = window.GameEngine.createBattleState(window.GameEngine.DEFAULT_CONFIG).members
        .map((m) => ({ name: m.name, faction: m.faction, hp: m.hp, attack: m.attack, agility: m.agility, dmgMin: m.dmgMin, dmgMax: m.dmgMax }));
      return {
        fields, members,
        legends: [...document.querySelectorAll('fieldset.faction legend')].map((l) => l.textContent),
        inputCount: document.querySelectorAll('#faction-configs input').length,
        allEnabled: [...document.querySelectorAll('#faction-configs input')].every((i) => !i.disabled),
        startVisible: !g('btn-start').hidden && !g('btn-start').disabled,
        resetHidden: g('btn-reset').hidden,
        clearBtnExists: !!g('btn-clear-log'),
        resultHidden: g('result').hidden,
        logEmpty: g('battle-log').children.length === 0,
        title: document.title
      };
    })()`);
    const f = c.fields;
    const passed =
      c.inputCount === 12 && c.allEnabled && c.startVisible && c.resetHidden &&
      c.clearBtnExists && c.resultHidden && c.logEmpty &&
      f['human-count'] === '1' && f['zombie-count'] === '1' &&
      f['human-hp'] === '12' && f['human-attack'] === '4' && f['human-agility'] === '4' &&
      f['human-dmgMin'] === '1' && f['human-dmgMax'] === '3' &&
      f['zombie-hp'] === '9' && f['zombie-attack'] === '5' && f['zombie-agility'] === '2' &&
      f['zombie-dmgMin'] === '1' && f['zombie-dmgMax'] === '5' &&
      c.members.length === 2 && c.members[0].name === '玩家1' && c.members[1].name === '丧尸1';
    await shotFull(cdp, join(SHOT_DIR, '01-config.png'));
    return { passed, ...c };
  });

  /* -- STEP 2: 人数を 3 ずつに増やす（命名自増の確認） ---------------- */
  await runStep(2, 'count-to-3-naming', async () => {
    const humanCount = await setNumberInput(cdp, 'human-count', 3);
    const zombieCount = await setNumberInput(cdp, 'zombie-count', 3);
    const names3 = await evalJS(cdp, `(() => {
      const d = window.GameEngine.DEFAULT_CONFIG;
      const cfg = { human: Object.assign({}, d.human, { count: 3 }), zombie: Object.assign({}, d.zombie, { count: 3 }) };
      return window.GameEngine.createBattleState(cfg).members.map((m) => m.name);
    })()`);
    const expect = JSON.stringify(EXPECTED_NAMES);
    const passed = humanCount === '3' && zombieCount === '3' && JSON.stringify(names3) === expect;
    await shotFull(cdp, join(SHOT_DIR, '02-config-3v3.png'));
    return { passed, humanCount, zombieCount, names3 };
  });

  /* -- STEP 3: 開戦 → 結果が出るまで待機 → ログ全文を検証 ------------- */
  let data3 = null;
  let ana = null;
  let replay = null;
  let victoryParsed = null;
  await runStep(3, 'battle-log-complete', async () => {
    const startBtn = await centerOf(cdp, '#btn-start');
    if (!startBtn || startBtn.w < 4) throw new Error('btn-start not visible');
    const t0 = Date.now();
    await clickAt(cdp, startBtn.x, startBtn.y);
    const appeared = await waitFor(cdp, "!document.getElementById('result').hidden", 30000);
    const elapsedMs = Date.now() - t0;

    data3 = await evalJS(cdp, `(() => {
      const g = (id) => document.getElementById(id);
      return {
        lines: [...g('battle-log').children].map((d) => d.textContent),
        classes: [...g('battle-log').children].map((d) => d.className),
        resultTitle: g('result-title').textContent,
        resultText: g('result-text').textContent,
        countsLocked: ['human-count','zombie-count'].map((id) => g(id).disabled),
        statsLocked: ['human-hp','human-attack','human-agility','human-dmgMin','human-dmgMax',
                      'zombie-hp','zombie-attack','zombie-agility','zombie-dmgMin','zombie-dmgMax'].map((id) => g(id).disabled),
        startHidden: g('btn-start').hidden,
        resetVisible: !g('btn-reset').hidden
      };
    })()`);
    writeFileSync(join(ROOT, 'verify', 'battle-log-dump.txt'), data3.lines.join('\n') + '\n', 'utf8');

    ana = analyzeLog(data3.lines);
    replay = replayValidate(ana, { human: HUMAN_MAX_HP, zombie: ZOMBIE_MAX_HP });
    victoryParsed = parseVictory(ana.victory);

    const expectSorted = [...EXPECTED_NAMES].sort().join('|');
    const orderOk =
      appeared && ana.header && ana.orderParsed.length === 6 && ana.orderParsed.every(Boolean) &&
      ana.orderParsed.map((o) => o.name).sort().join('|') === expectSorted &&
      ana.orderParsed.every((o, i) => o.no === i + 1) &&
      ana.orderParsed.every((o) => o.rolls.length >= 1 && o.rolls.every((x) => x >= 1 && x <= 100));
    const actionsOk = ana.actions.length > 0 && ana.actionsParsed.every((p) => p && p.kind !== 'unknown');
    const counts = { fail: 0, dodge: 0, hit: 0 };
    for (const p of ana.actionsParsed) if (p && counts[p.kind] !== undefined) counts[p.kind]++;
    const lockedOk =
      data3.countsLocked.every(Boolean) && data3.statsLocked.every(Boolean) &&
      data3.startHidden && data3.resetVisible;

    const passed = appeared && orderOk && actionsOk && replay.violations.length === 0 &&
      !!victoryParsed && lockedOk;

    /* ログ欄を一時的に全高表示にして戦闘ログ全体を 1 枚に収める */
    await evalJS(cdp, "window.scrollTo(0, 0); document.getElementById('battle-log').style.maxHeight = 'none'");
    await sleep(120);
    const h = await evalJS(cdp, 'document.documentElement.scrollHeight');
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 1400, height: Math.min(Math.max(h, 600), 12000), deviceScaleFactor: 1, mobile: false
    });
    await sleep(300);
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(SHOT_DIR, '03-battle-log.png'), Buffer.from(shot.data, 'base64'));
    await cdp.send('Emulation.clearDeviceMetricsOverride');
    await sleep(150);
    await evalJS(cdp, "document.getElementById('battle-log').style.maxHeight = ''");
    console.log('shot: ' + join(SHOT_DIR, '03-battle-log.png'));

    return {
      passed, appeared, elapsedMs, orderOk, actionsOk, counts,
      rerolls: ana.rerolls.length, rounds: ana.rounds,
      violations: replay.violations, victoryLine: ana.victory, victoryParsed,
      lockedOk, logLineCount: data3.lines.length
    };
  });

  /* -- STEP 4: 勝敗表示 ---------------------------------------------- */
  await runStep(4, 'result-display', async () => {
    if (!data3) throw new Error('battle data unavailable (step3 failed)');
    await evalJS(cdp, 'window.scrollTo(0, 0)');
    const res = await evalJS(cdp, `(() => {
      const g = (id) => document.getElementById(id);
      return {
        hidden: g('result').hidden,
        title: g('result-title').textContent,
        text: g('result-text').textContent,
        logStillThere: g('battle-log').children.length
      };
    })()`);
    const resLines = res.text.split('\n').map((s) => {
      const m = s.match(/^(.+?)：剩余 HP (\d+)\/(\d+)$/);
      return m && { name: m[1], hp: +m[2], maxHp: +m[3] };
    });
    const linesOk = resLines.length > 0 && resLines.every(Boolean);
    const survivorNames = victoryParsed ? victoryParsed.survivors.map((s) => s.name) : [];
    const setEq = (arr1, arr2) => JSON.stringify([...arr1].sort()) === JSON.stringify([...arr2].sort());
    const sameAsVictory = linesOk && victoryParsed &&
      resLines.length === victoryParsed.survivors.length &&
      resLines.every((r) => victoryParsed.survivors.some((s) => s.name === r.name && s.hp === r.hp && s.maxHp === r.maxHp));
    const winnerPrefix = victoryParsed && victoryParsed.faction === '人类阵营' ? '玩家' : '丧尸';
    const factionOk = victoryParsed &&
      res.title.includes(victoryParsed.faction) && res.title.includes('获胜') &&
      survivorNames.every((n) => n.startsWith(winnerPrefix)) &&
      survivorNames.every((n) => !replay.downed.includes(n));
    /* ログの最終残 HP と表示の整合（ダメージを受けた生存者のみ照合可能） */
    const lastHpOk = linesOk && resLines.every((r) => {
      for (let i = ana.actions.length - 1; i >= 0; i--) {
        const m = ana.actions[i].match(new RegExp(r.name + ' 剩余 HP (\\d+)'));
        if (m) return +m[1] === r.hp;
      }
      return r.hp === r.maxHp; // 一度も攻撃されていないなら全快
    });
    const passed = !res.hidden && linesOk && sameAsVictory && factionOk && lastHpOk;
    await shotFull(cdp, join(SHOT_DIR, '04-result.png'));
    return { passed, ...res, parsed: resLines, factionOk, lastHpOk };
  });

  /* -- STEP 5: ログの一括クリア --------------------------------------- */
  await runStep(5, 'clear-log', async () => {
    const btn = await centerOf(cdp, '#btn-clear-log');
    if (!btn || btn.w < 4) throw new Error('btn-clear-log not visible');
    await clickAt(cdp, btn.x, btn.y);
    await sleep(250);
    const after = await evalJS(cdp, `(() => {
      const b = document.getElementById('battle-log');
      return { children: b.children.length, text: b.textContent, resultStillShown: !document.getElementById('result').hidden };
    })()`);
    const passed = after.children === 0 && after.text === '';
    await shotFull(cdp, join(SHOT_DIR, '05-log-cleared.png'));
    return { passed, ...after };
  });

  const allPassed = steps.every((s) => s.passed);
  writeFileSync(join(ROOT, 'verify', 'e2e-findings.json'), JSON.stringify({ allPassed, steps }, null, 2), 'utf8');
  console.log(allPassed ? 'ALL STEPS PASSED' : 'SOME STEPS FAILED');
  return allPassed ? 0 : 1;
}

try {
  const code = await main();
  cleanup();
  process.exit(code);
} catch (e) {
  console.error('FATAL: ' + String((e && e.message) || e));
  cleanup();
  try {
    writeFileSync(join(ROOT, 'verify', 'e2e-findings.json'), JSON.stringify({ allPassed: false, fatal: String((e && e.message) || e), steps }, null, 2), 'utf8');
  } catch { /* ignore */ }
  process.exit(2);
}
