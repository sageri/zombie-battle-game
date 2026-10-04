/* =====================================================================
 * verify/browser-drive.mjs
 * 可視化改版（設定/戦場の 2 画面 + 逐行動リアルタイム演出 + 9×9 戦場
 * グリッド）を Edge headless + 生 CDP で黑盒 E2E 実測するゼロ依存ドライバ。
 * 実マウス / 実キーボードでページの実コントロールを操作する。
 *
 * 使い方:  node verify/browser-drive.mjs
 * 出力:    verify/screenshots/01..05*.png   （本回合の証跡。起動時に旧 png を全消去）
 *          verify/battle-log-skip-dump.txt  （STEP3「跳到結果」戦のログ全文・UTF-8）
 *          verify/battle-log-dump.txt       （STEP5 高速自動完走戦のログ全文・UTF-8）
 *          verify/e2e-findings.json         （判定詳細・UTF-8）
 * 注意:    コンソールは cp932 のため ASCII のみ出力する。
 *          中文の判定テキストはファイルへ書き出して目視確認する。
 * 撮影補助: 飘字は 0.9 秒でフェードアウトするため、撮影の間だけ CDP の
 *          Animation.setPlaybackRate で CSS アニメを 0.1 倍速にし、
 *          撮影後すぐ 1 倍へ戻す。ページの JS / エンジンには触れない。
 * ===================================================================== */
import { spawn, execSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readdirSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SHOT_DIR = join(ROOT, 'verify', 'screenshots');
// スクリプト自身の位置から解決する（リポジトリ移動・他マシンでも成立）
const PAGE_URL = pathToFileURL(join(ROOT, 'src', 'index.html')).href;
// 他マシンでは MSEDGE_PATH で上書きできる（未指定時は下記の本機既定パスを使う）。
const EDGE = process.env.MSEDGE_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 前回合の旧スクリーンショットを全消去（証跡セットの取り違え防止）
mkdirSync(SHOT_DIR, { recursive: true });
for (const f of readdirSync(SHOT_DIR)) {
  if (f.toLowerCase().endsWith('.png')) {
    try { unlinkSync(join(SHOT_DIR, f)); } catch { /* ignore */ }
  }
}

/* ---- 判定結果の記録（コンソールは ASCII のみ） ---------------------- */
const steps = [];
const pageErrors = [];
function record(id, name, passed, detail) {
  steps.push({ id, name, passed: !!passed, detail: detail === undefined ? null : detail });
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

async function setSelect(cdp, id, value) {
  // <select> の値を実コントロール経路で変更する（headless のドロップダウン
  // 実操作は不安定なため、実 DOM の value セッター + change イベントを使う。
  // readConfig が .value を読む経路は実測される）
  const ok = await evalJS(cdp, `(() => {
    const e = document.getElementById(${JSON.stringify(id)});
    if (!e) return false;
    const d = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value');
    d.set.call(e, ${JSON.stringify(value)});
    e.dispatchEvent(new Event('input', { bubbles: true }));
    e.dispatchEvent(new Event('change', { bubbles: true }));
    return e.value === ${JSON.stringify(value)};
  })()`);
  if (!ok) throw new Error('select set failed: ' + id);
  return value;
}

// CSS アニメの再生速度を変える（撮影用スローモーション。非対応環境では false）
async function setAnimRate(cdp, rate) {
  try {
    await cdp.send('Animation.enable');
    await cdp.send('Animation.setPlaybackRate', { playbackRate: rate });
    return true;
  } catch { return false; }
}

// ビューポートの高さを文書全体に合わせる（一枚の全文スクリーンショット用）
async function fitViewport(cdp, pad = 90) {
  const h = await evalJS(cdp, 'Math.max(document.documentElement.scrollHeight, window.innerHeight)');
  const H = Math.min(Math.max(h + pad, 900), 12000);
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 1400, height: H, deviceScaleFactor: 1, mobile: false
  });
  await sleep(220);
  return H;
}

async function shotViewport(cdp, path) {
  await evalJS(cdp, 'window.scrollTo(0, 0)');
  await sleep(60);
  const r = await cdp.send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(path, Buffer.from(r.data, 'base64'));
  console.log('shot: ' + path);
}

async function shotFull(cdp, path) {
  // ビューポートを文書全体の高さに広げてから撮影する（フルページ相当）
  await fitViewport(cdp, 40);
  await shotViewport(cdp, path);
  await cdp.send('Emulation.clearDeviceMetricsOverride');
  await sleep(120);
}

// ページ側の未捕捉例外を記録する（実測中に throw されたら notes へ出す）
function watchPageErrors(cdp) {
  cdp.on('Runtime.exceptionThrown', (p) => {
    const d = p && p.exceptionDetails;
    pageErrors.push((d && ((d.exception && d.exception.description) || d.text)) || 'unknown exception');
  });
}

/* ---- DOM スナップ式（evalJS に渡す。単一 eval なので読み取りは原子的） -- */
// 飘字・順序帯強調・ログ末尾・state の位置を 1 回の eval で取る
const SNAP_EXPR = `(() => {
  const g = (id) => document.getElementById(id);
  const floats = [...document.querySelectorAll('.unit-card .float-text')].map((e) => ({
    card: e.closest('.unit-card') ? e.closest('.unit-card').id : null,
    text: e.textContent,
    cls: e.className
  }));
  const active = document.querySelector('#order-strip .chip.active');
  const current = document.querySelector('.unit-card.current');
  const log = g('battle-log');
  const st = window.GameUI.getBattleState();
  return {
    floats: floats,
    activeChip: active ? active.id : null,
    currentCard: current ? current.id : null,
    logCount: log.children.length,
    lastLog: log.children.length ? log.children[log.children.length - 1].textContent : null,
    lastLogs: [...log.children].slice(-3).map((d) => d.textContent),
    logScroll: { top: log.scrollTop, clientH: log.clientHeight, scrollH: log.scrollHeight },
    mode: window.GameUI.getMode(),
    turnIndex: st ? st.turnIndex : null,
    steps: st ? st.steps : null,
    order: st ? st.order : null
  };
})()`;

// 戦場の構造スナップ（9×9 グリッド / カード / 順序帯 / ログ先頭 / state）
const STRUCT_EXPR = `(() => {
  const cards = (sel) => [...document.querySelectorAll(sel)].map((c) => ({
    id: c.id,
    title: c.getAttribute('title'),
    emoji: c.querySelector('.unit-emoji') ? c.querySelector('.unit-emoji').textContent : null,
    fill: c.querySelector('.hp-fill') ? c.querySelector('.hp-fill').style.width : null,
    downed: c.classList.contains('downed'),
    transform: c.style.transform
  }));
  const chips = [...document.querySelectorAll('#order-strip .chip')].map((c) => ({
    id: c.id,
    name: c.querySelector('.chip-name').textContent,
    emoji: c.querySelector('.chip-emoji').textContent,
    active: c.classList.contains('active'),
    downed: c.classList.contains('downed')
  }));
  const log = document.getElementById('battle-log');
  const st = window.GameUI.getBattleState();
  return {
    screen: window.GameUI.getScreen(),
    mode: window.GameUI.getMode(),
    speed: window.GameUI.getSpeed(),
    configHidden: document.getElementById('config-screen').hidden,
    battleHidden: document.getElementById('battle-screen').hidden,
    gridCells: [...document.querySelectorAll('#battle-grid .grid-cell')].length,
    humanCards: cards('.unit-card.human'),
    zombieCards: cards('.unit-card.zombie'),
    chips: chips,
    activeCount: chips.filter((c) => c.active).length,
    logCount: log.children.length,
    logLines: [...log.children].map((d) => d.textContent),
    state: st ? { order: st.order, turnIndex: st.turnIndex, steps: st.steps, rolls: st.rolls, finished: st.finished,
      members: st.members.map((m) => ({ name: m.name, faction: m.faction, typeId: m.typeId, pos: m.pos, downed: m.downed })) } : null
  };
})()`;

// カードの transform 期待値（ui.js の transformFor と CELL_PX=64 に一致。#16 仕様）
const transformFor = (pos) => 'translate(' + (pos.col - 1) * 64 + 'px, ' + (pos.row - 1) * 64 + 'px)';

// 移動演出の観測プローブ: 移動ログ行数と全カード transform の指紋
const MOVE_PROBE_EXPR = `(() => ({
  moves: document.querySelectorAll('#battle-log .log-action-move').length,
  blocked: document.querySelectorAll('#battle-log .log-action-blocked').length,
  tf: [...document.querySelectorAll('.unit-card')].map((c) => c.style.transform).join('|')
}))()`;

// 飘字の数値が直近ログ行と整合するか（同一 applyEvent 内で原子的に取った組のみ判定）。
// 行動者が順序末尾の場合、advanceTurn が行動行の後に「第 N 轮」区切り行を
// 追加するため、直近 3 行のどこかに含まれていれば整合とみなす
function floatLogAgree(floats, lastLogs) {
  if (!lastLogs || lastLogs.length === 0) return false;
  return floats.every((f) => {
    const dmg = f.text.match(/^-(\d+)/);
    if (dmg) return lastLogs.some((l) => l.includes('伤害 ' + dmg[1]));
    const m = f.text.match(/^d7=(\d+)/);
    if (m) return lastLogs.some((l) => l.includes('d7=' + m[1]));
    return false;
  });
}

/* ---- 戦闘ログの解析（仕様第 5 条との突き合わせ） --------------------- */
// #18 T6: 陣営定数（HP / 伤害区間 / 名前接頭辞）は廃止し、
// getBattleState().members から name → { faction, maxHp, dmgMin, dmgMax, typeId }
// の写像を作って検証源にする（四属性と typeId は戦闘中不変）
const T_EMOJI = {
  militia: '🧑', guard: '🛡️', gunner: '🔫', scout: '🏃',
  walker: '🧟', rotwalker: '🦠', shredder: '🩸', sprinter: '💨', horde: '🐛',
};
function memberInfoOf(members) {
  const info = {};
  for (const m of members || []) {
    info[m.name] = { faction: m.faction, maxHp: m.maxHp, dmgMin: m.dmgMin, dmgMax: m.dmgMax, typeId: m.typeId };
  }
  return info;
}

function parseOrderLine(l) {
  // 行尾に初期座標（3,4）を伴う（规格第 7 条）
  const m = l.match(/^(\d+)\. (.+?)（d100=([\d→]+)）（(\d+),(\d+)）$/);
  return m && { no: +m[1], name: m[2], rolls: m[3].split('→').map(Number), pos: { row: +m[4], col: +m[5] } };
}

function parseMoveLine(l) {
  const m = l.match(/^(.+?) 移动：（(\d+),(\d+)）→（(\d+),(\d+)）$/);
  return m && { kind: 'move', actor: m[1], from: { row: +m[2], col: +m[3] }, to: { row: +m[4], col: +m[5] }, line: l };
}

function parseBlockLine(l) {
  const m = l.match(/^(.+?) 无法移动（无路可走）$/);
  return m && { kind: 'blocked', actor: m[1], line: l };
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
  // turns: 行動順を 1 つ消費する全行（攻撃/移動/移動不能）をログ順に並べたもの。
  // 移動行の「）→（」は攻撃行の「 → 」と区別する（→ 誤判定防止）
  const a = { header: false, order: [], rerolls: [], rounds: 0, actions: [], moves: [], blocked: [], unknown: [], victory: null, turns: [] };
  for (const l of lines) {
    if (l.startsWith('【行动顺序】')) a.header = true;
    else if (/^\d+\. /.test(l)) a.order.push(l);
    else if (l.startsWith('【先攻重投】')) a.rerolls.push(l);
    else if (l.startsWith('── 第')) a.rounds++;
    else if (l.startsWith('战斗结束')) a.victory = l;
    else if (l.includes(' 无法移动（无路可走）')) { a.blocked.push(l); a.turns.push(parseBlockLine(l)); }
    else if (l.includes(' 移动：')) { a.moves.push(l); a.turns.push(parseMoveLine(l)); }
    else if (l.includes('→')) { const p = parseActionLine(l); a.actions.push(l); a.turns.push(p); }
    else a.unknown.push(l);
  }
  a.orderParsed = a.order.map(parseOrderLine);
  a.actionsParsed = a.turns;
  return a;
}

/* ログ全文を「状態リプレイ」で検証する。違反があればその行を violations へ。
   移動・移動不能も行動順を 1 つ消費するため、循環上の行動者照合に含める */
function replayValidate(a, info) {
  const v = [];
  const hpNow = {};
  const posNow = {};
  const downedSet = new Set();
  for (const o of a.orderParsed) {
    if (!o) { v.push('order line unparsable: ' + a.order[a.orderParsed.indexOf(o)]); continue; }
    const mi = info[o.name];
    if (!mi) { v.push('unknown order member: ' + o.name); continue; }
    hpNow[o.name] = mi.maxHp;
    posNow[o.name] = o.pos;
  }
  const isAdj = (p, q) => p && q && Math.abs(p.row - q.row) + Math.abs(p.col - q.col) === 1;
  const inB = (p) => p && p.row >= 1 && p.row <= 9 && p.col >= 1 && p.col <= 9;
  const occupiedByAlive = (cell, exceptName) => Object.keys(posNow).some((nm) =>
    nm !== exceptName && !downedSet.has(nm) && posNow[nm] &&
    posNow[nm].row === cell.row && posNow[nm].col === cell.col);
  let ptr = 0;
  for (const act of a.actionsParsed) {
    if (!act) { v.push('action line unparsable'); continue; }
    if (act.kind === 'unknown') { v.push('unknown action shape: ' + act.line); continue; }
    // 行動者は order の循環上の次の非倒地者であること（全行動種共通）
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
    if (act.kind === 'move') {
      // 移動行: 1 マス・界内・現在地から・未占拠マスへ
      if (!inB(act.from) || !inB(act.to)) { v.push('move out of bounds: ' + act.line); continue; }
      if (Math.abs(act.to.row - act.from.row) + Math.abs(act.to.col - act.from.col) !== 1) {
        v.push('move not 1 cell: ' + act.line);
      }
      const cur = posNow[act.actor];
      if (!cur || cur.row !== act.from.row || cur.col !== act.from.col) {
        v.push('move from mismatch with current pos: ' + act.line);
      }
      if (occupiedByAlive(act.to, act.actor)) v.push('move onto occupied cell: ' + act.line);
      posNow[act.actor] = act.to;
      continue;
    }
    if (act.kind === 'blocked') continue; // 移動不能: 状態変化なし
    if (downedSet.has(act.target)) v.push('downed target chosen: ' + act.target);
    const factionOf = (nm) => (info[nm] ? info[nm].faction : null);
    if (factionOf(act.actor) === null || factionOf(act.actor) === factionOf(act.target)) {
      v.push('same-faction attack: ' + act.line);
    }
    // 隣接攻撃の規則: 攻撃時点で 4 隣接にいること
    if (!isAdj(posNow[act.actor], posNow[act.target])) v.push('attack from non-adjacent cell: ' + act.line);
    if (act.kind === 'fail') {
      if (!(act.atkRoll > act.atkVal)) v.push('fail line but roll<=attack: ' + act.line);
    } else if (act.kind === 'dodge') {
      if (!(act.atkRoll <= act.atkVal)) v.push('dodge line but atk roll>attack: ' + act.line);
      if (!(act.dodgeRoll <= act.agiVal)) v.push('dodge line but roll>agility: ' + act.line);
    } else if (act.kind === 'hit') {
      if (!(act.atkRoll <= act.atkVal)) v.push('hit line but atk roll>attack: ' + act.line);
      if (!(act.dodgeRoll > act.agiVal)) v.push('hit line but dodge roll<=agility: ' + act.line);
      const ai = info[act.actor];
      if (ai && (act.dmg < ai.dmgMin || act.dmg > ai.dmgMax)) v.push('damage out of range: ' + act.line);
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

// 行動順が出目履歴の辞書順降順（エンジン cmpRollsDesc と同一規則）になっているか。
// 同点組の重投点は組内だけで比較され、組と外部の前后は元の点数で確定するため、
// 「最後の出目」の全体降順ではなく履歴列の辞書順降順で判定する
function orderSortedOk(ana) {
  const hist = ana.orderParsed.map((o) => (o ? o.rolls : null));
  for (const h of hist) {
    if (!h || h.length === 0 || h.some((r) => r < 1 || r > 100)) return false;
  }
  for (let i = 0; i + 1 < hist.length; i++) {
    const a = hist[i], b = hist[i + 1];
    const n = Math.min(a.length, b.length);
    let c = 0;
    for (; c < n; c++) if (a[c] !== b[c]) break;
    if (c < n) {
      if (b[c] > a[c]) return false; // 最初の差異は降順であること
    } else if (b.length > a.length) {
      return false; // 保険: 接頭辞が全等なら短い方が後、は規則外
    }
  }
  return true;
}

// 重投履歴を持つ者は【先攻重投】行に名前があるか
function rerollConsistent(ana) {
  const rerollText = ana.rerolls.join('\n');
  return ana.orderParsed.every((o) => !o || o.rolls.length === 1 || rerollText.includes(o.name));
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
  // Edge 起動失敗（パス誤り等）は非同期の error イベントで届く。放置すると
  // 30 秒のポート待ちタイムアウトまで黙るため、即座に終了して原因を示す
  // （コンソールは ASCII のみ出力する規約どおり）。
  proc.on('error', (err) => {
    console.error('EDGE_LAUNCH_FAILED: ' + String(err.message));
    process.exit(2);
  });

  const target = await findPageTarget(30000);
  cdp = await connectCdp(target.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable').catch(() => {});
  watchPageErrors(cdp);
  const loaded = new Promise((res) => cdp.on('Page.loadEventFired', res));
  await cdp.send('Page.navigate', { url: PAGE_URL });
  await Promise.race([loaded, sleep(10000)]);
  await sleep(600);

  /* -- STEP 1: 既定の設定画面（既定値 + 入力可編集 + 初期站位セレクト） -- */
  await runStep(1, 'config-screen-defaults', async () => {
    const c = await evalJS(cdp, `(() => {
      const g = (id) => document.getElementById(id);
      const ids = ['human-militia','human-guard','human-gunner','human-scout',
                   'zombie-walker','zombie-rotwalker','zombie-shredder','zombie-sprinter','zombie-horde'];
      const fields = {};
      for (const id of ids) fields[id] = g(id) ? { value: g(id).value, disabled: g(id).disabled } : null;
      const sel = g('config-placement');
      const names = window.GameEngine.createBattleState(window.GameEngine.DEFAULT_CONFIG).members.map((m) => m.name);
      return {
        fields, names,
        budgetHuman: g('budget-num-human') ? g('budget-num-human').textContent : null,
        budgetZombie: g('budget-num-zombie') ? g('budget-num-zombie').textContent : null,
        budgetInput: g('config-budget') ? { value: g('config-budget').value, disabled: g('config-budget').disabled } : null,
        placement: sel ? { value: sel.value, disabled: sel.disabled, options: [...sel.options].map((o) => o.value) } : null,
        screen: window.GameUI.getScreen(),
        configVisible: !g('config-screen').hidden,
        battleHidden: g('battle-screen').hidden,
        startVisible: !g('btn-start').hidden && !g('btn-start').disabled,
        logEmpty: g('battle-log').children.length === 0,
        title: document.title
      };
    })()`);
    const f = c.fields;
    // 期待値は #18 仕様表の独立写し（既定編成＝特色三人組、他は 0）
    const expect = { 'human-militia': '0', 'human-guard': '1', 'human-gunner': '1', 'human-scout': '1',
                     'zombie-walker': '0', 'zombie-rotwalker': '1', 'zombie-shredder': '1', 'zombie-sprinter': '1', 'zombie-horde': '0' };
    let valuesOk = true, editableOk = true;
    for (const id of Object.keys(expect)) {
      if (!f[id] || f[id].value !== expect[id]) valuesOk = false;
      if (!f[id] || f[id].disabled) editableOk = false;
    }
    const placementOk = !!c.placement && c.placement.value === 'mixed' &&
      !c.placement.disabled &&
      JSON.stringify(c.placement.options) === JSON.stringify(['mixed', 'split']);
    const budgetTextOk = c.budgetHuman === '已用 32 / 100' && c.budgetZombie === '已用 32 / 100'
      && !!c.budgetInput && c.budgetInput.value === '100' && !c.budgetInput.disabled;
    const passed =
      c.screen === 'config' && c.configVisible && c.battleHidden &&
      Object.keys(f).length === 9 && valuesOk && editableOk && placementOk && budgetTextOk &&
      c.startVisible && c.logEmpty &&
      JSON.stringify(c.names) === JSON.stringify(['守卫1', '枪手1', '侦察兵1', '腐行者1', '撕裂者1', '疾行者1']) &&
      c.title.includes('丧尸 vs 人类');
    // 予算バーの動作（実 input イベント経由）: 民兵 +11 → 142 点で超支赤表示 → 戻す。
    // さらに予算入力を 20 に下げると 32 > 20 で即超支に変わる（両バー連動）
    const budgetProbe = await evalJS(cdp, `(() => {
      const e = document.getElementById('human-militia');
      const num = document.getElementById('budget-num-human');
      const bar = document.getElementById('budget-bar-human');
      const bi = document.getElementById('config-budget');
      const d = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
      const set = (el, v) => { d.set.call(el, String(v)); el.dispatchEvent(new Event('input', { bubbles: true })); };
      set(e, 11);
      const over = { num: num.textContent, over: bar.className.includes('over') };
      set(e, 0);
      const back = { num: num.textContent, over: bar.className.includes('over') };
      set(bi, 20);
      const low = { num: num.textContent, over: bar.className.includes('over') };
      set(bi, 100);
      const lowBack = { num: num.textContent, over: bar.className.includes('over') };
      return { over, back, low, lowBack };
    })()`);
    const budgetDynOk = budgetProbe.over.num === '已用 142 / 100' && budgetProbe.over.over === true
      && budgetProbe.back.num === '已用 32 / 100' && budgetProbe.back.over === false
      && budgetProbe.low.num === '已用 32 / 20' && budgetProbe.low.over === true
      && budgetProbe.lowBack.num === '已用 32 / 100' && budgetProbe.lowBack.over === false;
    await shotFull(cdp, join(SHOT_DIR, '01-config.png'));
    return { passed: passed && budgetDynOk, names: c.names, valuesOk, editableOk, placement: c.placement,
             budgetTextOk, budgetDynOk, budgetProbe, startVisible: c.startVisible, title: c.title };
  });

  /* -- STEP 2: 3v3 で開戦 → 戦場画面 + 順序帯 + ログ + 飘字 ----------- */
  await runStep(2, 'battlefield-3v3-live', async () => {
    // 異構成 3v3（人類: 民兵1+偵察兵2 = 26 点 / 丧屍: 丧屍1+尸潮2 = 16 点）
    const hc = await setNumberInput(cdp, 'human-militia', 1);
    await setNumberInput(cdp, 'human-guard', 0);
    await setNumberInput(cdp, 'human-gunner', 0);
    await setNumberInput(cdp, 'human-scout', 2);
    await setNumberInput(cdp, 'zombie-walker', 1);
    await setNumberInput(cdp, 'zombie-rotwalker', 0);
    await setNumberInput(cdp, 'zombie-shredder', 0);
    await setNumberInput(cdp, 'zombie-sprinter', 0);
    const zc = await setNumberInput(cdp, 'zombie-horde', 2);
    const startBtn = await centerOf(cdp, '#btn-start');
    if (!startBtn || startBtn.w < 4) throw new Error('btn-start not visible');
    await clickAt(cdp, startBtn.x, startBtn.y);
    const appeared = await waitFor(cdp, "window.GameUI.getScreen() === 'battle' && !document.getElementById('battle-screen').hidden", 10000);
    if (!appeared) throw new Error('battle screen did not appear');
    await sleep(250);

    const s = await evalJS(cdp, STRUCT_EXPR);
    await fitViewport(cdp, 100); // 戦場〜ログまで一枚に収める（終局横幅ぶんの余白も確保）

    const humanNames = s.humanCards.map((x) => x.title);
    const zombieNames = s.zombieCards.map((x) => x.title);
    const chipNames = s.chips.map((x) => x.name);
    const orderOk = !!s.state && JSON.stringify(chipNames) === JSON.stringify(s.state.order);
    // 先攻重投がある場合、ログ先頭は【先攻重投】行になり得るため
    // 「見出し行が存在し、その前には重投行しかない」形で判定する
    // （order 行は行尾に初期座標（r,c）を伴う）
    const hdrIdx = s.logLines.indexOf('【行动顺序】（d100 点数，从大到小）');
    const preHeader = hdrIdx >= 0 ? s.logLines.slice(0, hdrIdx) : [];
    const headerOk =
      hdrIdx >= 0 && preHeader.every((l) => l.startsWith('【先攻重投】')) &&
      s.logLines.filter((l) => /^\d+\. .+（d100=[\d→]+）（\d+,\d+）$/.test(l)).length === 6;
    // カード位置（transform）が state の pos と同期していること
    const posMap = new Map((s.state && s.state.members ? s.state.members : []).map((m) => [m.name, m.pos]));
    const transformOk = s.humanCards.concat(s.zombieCards).every((x) => {
      const pos = posMap.get(x.title);
      return pos && x.transform === transformFor(pos);
    });
    const step2Info = memberInfoOf(s.state.members);
    const cardOk = (x) => {
      const m = step2Info[x.title];
      return !!m && x.emoji === T_EMOJI[m.typeId] && x.fill === '100%' && !x.downed;
    };
    const structOk =
      s.screen === 'battle' && s.mode === 'live' && s.configHidden && !s.battleHidden &&
      s.gridCells === 81 &&
      s.humanCards.length === 3 && s.zombieCards.length === 3 &&
      JSON.stringify(humanNames) === JSON.stringify(['民兵1', '侦察兵1', '侦察兵2']) &&
      JSON.stringify(zombieNames) === JSON.stringify(['丧尸1', '尸潮1', '尸潮2']) &&
      s.humanCards.every(cardOk) &&
      s.zombieCards.every(cardOk) &&
      s.humanCards.every((x) => step2Info[x.title] && step2Info[x.title].faction === 'human') &&
      s.zombieCards.every((x) => step2Info[x.title] && step2Info[x.title].faction === 'zombie') &&
      transformOk &&
      s.chips.length === 6 && s.activeCount === 1 && orderOk &&
      (s.state.steps === 0 ? s.chips.find((x) => x.active).id === 'chip-' + s.state.order[0] : true) &&
      headerOk &&
      s.logLines.filter((l) => /^── 第 1 轮 ──$/.test(l)).length === 1;

    // 移動・移動不能の観測: 移動系ログ行（action-move / action-blocked の
    // いずれか）が出て、その前後でカードの transform が変わること
    // （滑り移動の基盤 = pos 同期の実測）。待ち選択器は両クラスをカバーする
    const probe1 = await evalJS(cdp, MOVE_PROBE_EXPR);
    const moveAppeared = await waitFor(cdp,
      `(document.querySelectorAll('#battle-log .log-action-move').length`
      + ` + document.querySelectorAll('#battle-log .log-action-blocked').length)`
      + ` > ${probe1.moves + probe1.blocked}`,
      30000, 120);
    const probe2 = await evalJS(cdp, MOVE_PROBE_EXPR);
    const moveAnimSeen = moveAppeared && probe2.tf !== probe1.tf;
    const moveSeen = moveAppeared && (probe2.moves + probe2.blocked) >= 1;

    // 行動が 2 つ以上出演するまで待つ（中速 800ms/ステップ）
    const actionsSeen = await waitFor(cdp,
      "document.querySelectorAll('#battle-log .log-action-hit,#battle-log .log-action-fail,#battle-log .log-action-dodge').length >= 2",
      30000, 120);
    if (!actionsSeen) throw new Error('no 2+ actions within 30s at middle speed');

    // 撮影: CSS アニメを 0.1 倍速にして飘字の可視時間を伸ばし、
    // pre/post スナップが一致する（=撮影中にステップが差し替わっていない）
    // 最初の 1 枚を採用する。伤害飘字を優先。
    const slowed = await setAnimRate(cdp, 0.1);
    let caught = null;
    // 飘字の観測証跡は「ログと突き合わせ可能なもの」（伤害 -N / 骰点 d7=N）に
    // 限る。移動・无法移动の飘字は floatLogAgree が常に false になるため受け付けない
    for (let i = 0; i < 24 && !(caught && caught.hasDmg); i++) {
      const pre = await evalJS(cdp, SNAP_EXPR);
      if (!pre || pre.floats.length === 0) { await sleep(90); continue; }
      if (!floatLogAgree(pre.floats, pre.lastLogs)) { await sleep(90); continue; }
      const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
      const post = await evalJS(cdp, SNAP_EXPR);
      const same = JSON.stringify(pre.floats) === JSON.stringify(post.floats) && pre.logCount === post.logCount;
      if (!same) continue; // 撮影中に次ステップが乗った可能性 → 撮り直し
      const hasDmg = pre.floats.some((f) => /^-\d+/.test(f.text));
      caught = {
        floats: pre.floats, lastLog: pre.lastLog, lastLogs: pre.lastLogs, logCount: pre.logCount,
        activeChip: pre.activeChip, currentCard: pre.currentCard,
        hasDmg, attempts: i + 1, agree: floatLogAgree(pre.floats, pre.lastLogs)
      };
      writeFileSync(join(SHOT_DIR, '02-battlefield.png'), Buffer.from(shot.data, 'base64'));
      console.log('shot: ' + join(SHOT_DIR, '02-battlefield.png'));
      if (hasDmg) break;
      await sleep(150);
    }
    await setAnimRate(cdp, 1); // 撮影後は必ず 1 倍へ戻す
    if (!caught) {
      // 飘字を捕まえられなかった場合のフォールバック証跡
      await shotViewport(cdp, join(SHOT_DIR, '02-battlefield.png'));
    }

    // ---- 表示シームの実測（#16 仕様: 態勢ゲージ / 意図 SVG / 倒地のスポットライト） ----
    // 態勢ゲージ: 双バーの幅が state からの独立計算（Σ存活hp/ΣmaxHp）と一致するか。
    // 実 DOM の CSSOM は設定文字列を丸めて読み返す（91.666666…% → 91.6667%）
    // ため、比較は数値（±0.001%）で行う。スタブ検査（engine.test.mjs）は
    // 設定文字列そのものを検査しているので両者で役割分担になる
    const powerPaneOk = await evalJS(cdp, `(() => {
      const st = window.GameUI.getBattleState();
      if (!st) return { ok: false, why: 'no state' };
      const sum = { human: 0, zombie: 0 }, max = { human: 0, zombie: 0 };
      for (const m of st.members) {
        max[m.faction] += m.maxHp;
        if (!m.downed) sum[m.faction] += m.hp;
      }
      const g = (id) => document.getElementById(id);
      const expH = (sum.human / max.human) * 100;
      const expZ = (sum.zombie / max.zombie) * 100;
      const near = (v, exp) => v !== undefined && v !== null && !isNaN(parseFloat(v)) && Math.abs(parseFloat(v) - exp) < 0.001;
      const fh = g('power-fill-human'), fz = g('power-fill-zombie');
      return {
        ok: !!fh && !!fz && near(fh.style.width, expH) && near(fz.style.width, expZ),
        why: 'human=' + (fh ? fh.style.width : 'none') + ' exp=' + expH
          + ' zombie=' + (fz ? fz.style.width : 'none') + ' exp=' + expZ,
        num: (g('power-num-human') || {}).textContent + ' / ' + (g('power-num-zombie') || {}).textContent
      };
    })()`);

    // 意図 SVG: 「ここから」の移動拍を待ち、移動行の from→to と座標（格中心
    // 64px の独立計算）を照合（blocked 拍は意図を描かないので移動行のみで待つ）
    const movesBase = await evalJS(cdp, "document.querySelectorAll('#battle-log .log-action-move').length");
    const moveAppeared2 = await waitFor(cdp,
      `document.querySelectorAll('#battle-log .log-action-move').length > ${movesBase}`,
      30000, 100);
    const intentSeen = await evalJS(cdp, `(() => {
      const moves = [...document.querySelectorAll('#battle-log .log-action-move')];
      const last = moves[moves.length - 1];
      const svg = document.querySelector('#intent-layer svg');
      if (!last || !svg) return { ok: false, why: 'no move row or no svg' };
      const m = last.textContent.match(/（(\\d+),(\\d+)）→（(\\d+),(\\d+)）$/);
      if (!m) return { ok: false, why: 'unparsable move row: ' + last.textContent };
      const c = (n) => (n - 0.5) * 64;
      const line = svg.querySelector('line');
      const ring = svg.querySelector('circle');
      const dash = line && line.getAttribute('stroke-dasharray');
      return {
        ok: line && ring && dash
          && Number(line.getAttribute('x1')) === c(+m[2]) && Number(line.getAttribute('y1')) === c(+m[1])
          && Number(line.getAttribute('x2')) === c(+m[4]) && Number(line.getAttribute('y2')) === c(+m[3])
          && Number(ring.getAttribute('cx')) === c(+m[4]) && Number(ring.getAttribute('cy')) === c(+m[3]),
        why: last.textContent + ' line=' + (line ? [line.getAttribute('x1'), line.getAttribute('y1'), line.getAttribute('x2'), line.getAttribute('y2')].join(',') : 'none')
          + ' ring=' + (ring ? ring.getAttribute('cx') + ',' + ring.getAttribute('cy') : 'none') + ' dash=' + dash,
        cls: svg.getAttribute('class')
      };
    })()`);

    // 倒地拍のスポットライト: 「，倒地！」行が新たに増えた拍で #fx-spot に on クラス
    // （行と on クラスは同一 applyEvent で原子に出る。過去行の存在で待ちを誤魔化され
    // ないよう基数からの増分で待つ。次拍の頭で外れる＝猶予は中速 800ms＋演出尺 900ms）
    const downedBase = await evalJS(cdp,
      "[...document.querySelectorAll('#battle-log .log-action-hit')].filter((r) => r.textContent.includes('，倒地！')).length");
    const downedWaited = await waitFor(cdp,
      "[...document.querySelectorAll('#battle-log .log-action-hit')].filter((r) => r.textContent.includes('，倒地！')).length > " + downedBase,
      60000, 100);
    const spotSeen = downedWaited ? await evalJS(cdp,
      "document.getElementById('fx-spot').classList.contains('on')") : false;

    const fin = await evalJS(cdp, SNAP_EXPR);

    const passed = structOk && actionsSeen && moveSeen && moveAnimSeen && !!caught && caught.agree
      && powerPaneOk.ok && moveAppeared2 && !!intentSeen.ok && downedWaited && spotSeen;
    return {
      passed, countsSet: { human: hc, zombie: zc }, structOk, actionsSeen, slowed,
      moveSeen, moveAnimSeen, moveProbe: { moves: probe2.moves, blocked: probe2.blocked },
      powerPaneOk, intentSeen, downedWaited, spotSeen,
      humanNames, zombieNames, chipNames, activeCount: s.activeCount,
      activeChip: s.chips.filter((x) => x.active).map((x) => x.id),
      firstOrderLines: s.logLines.slice(0, 8), logCountAtStart: s.logCount,
      caught: caught || null, floatsNow: fin.floats, modeNow: fin.mode, stepsNow: fin.steps
    };
  });

  /* -- STEP 3: 跳到結果 → 終局横幅 + 敗側全員💀 ------------------------ */
  await runStep(3, 'skip-to-result', async () => {
    const modeBefore = await evalJS(cdp, 'window.GameUI.getMode()');
    const skipBtn = await centerOf(cdp, '#btn-skip');
    if (!skipBtn || skipBtn.w < 4) throw new Error('btn-skip not visible');
    const skipDisabled = await evalJS(cdp, "document.getElementById('btn-skip').disabled");
    await clickAt(cdp, skipBtn.x, skipBtn.y);
    const done = await waitFor(cdp, "window.GameUI.getMode() === 'done' && !document.getElementById('battle-banner').hidden", 15000);

    const c = await evalJS(cdp, `(() => {
      const g = (id) => document.getElementById(id);
      const st = window.GameUI.getBattleState();
      const cards = [...document.querySelectorAll('.unit-card')].map((el) => ({
        id: el.id, downed: el.classList.contains('downed'),
        emoji: el.querySelector('.unit-emoji').textContent,
        title: el.getAttribute('title'),
        transform: el.style.transform
      }));
      const chips = [...document.querySelectorAll('#order-strip .chip')].map((el) => ({
        id: el.id, downed: el.classList.contains('downed'),
        emoji: el.querySelector('.chip-emoji').textContent
      }));
      return {
        banner: { hidden: g('battle-banner').hidden, title: g('banner-title').textContent, body: g('banner-body').textContent },
        members: st ? st.members.map((m) => ({ name: m.name, faction: m.faction, typeId: m.typeId, hp: m.hp, maxHp: m.maxHp, downed: m.downed, pos: m.pos })) : null,
        winner: st ? st.winner : null,
        survivors: st ? st.survivors : null,
        cards, chips,
        activeChips: [...document.querySelectorAll('#order-strip .chip.active')].length,
        currentCards: [...document.querySelectorAll('.unit-card.current')].length,
        floats: [...document.querySelectorAll('.float-text')].length,
        log: [...g('battle-log').children].map((d) => ({ cls: d.className, text: d.textContent }))
      };
    })()`);

    writeFileSync(join(ROOT, 'verify', 'battle-log-skip-dump.txt'), c.log.map((x) => x.text).join('\n') + '\n', 'utf8');

    const ana = analyzeLog(c.log.map((x) => x.text));
    const replay = replayValidate(ana, memberInfoOf(c.members));
    const victory = parseVictory(ana.victory);
    const bodyLines = c.banner.body.split('\n').filter((x) => x.length > 0);
    const bodyParsed = bodyLines.map((l) => {
      const m = l.match(/^(.+?)：剩余 HP (\d+)\/(\d+)$/);
      return m && { name: m[1], hp: +m[2], maxHp: +m[3] };
    });

    const loserFaction = c.winner === 'human' ? 'zombie' : (c.winner === 'zombie' ? 'human' : null);
    const loserMembers = loserFaction ? c.members.filter((m) => m.faction === loserFaction) : [];
    const loserAllDowned = loserMembers.length > 0 && loserMembers.every((m) => m.downed && m.hp === 0);
    const cardsOk = c.members.every((m) => {
      const card = c.cards.find((x) => x.id === 'card-' + m.name);
      const chip = c.chips.find((x) => x.id === 'chip-' + m.name);
      if (!card || !chip) return false;
      return card.downed === m.downed && chip.downed === m.downed &&
        card.emoji === (m.downed ? '💀' : T_EMOJI[m.typeId]) &&
        chip.emoji === (m.downed ? '💀' : T_EMOJI[m.typeId]) &&
        card.title === m.name &&
        (!m.pos || card.transform === transformFor(m.pos));
    });
    const bodyOk = bodyParsed.length > 0 && bodyParsed.every(Boolean) &&
      JSON.stringify(bodyParsed) === JSON.stringify((c.survivors || []).map((m) => ({ name: m.name, hp: m.hp, maxHp: m.maxHp })));
    const logVictoryOk = !!victory && !!c.survivors &&
      JSON.stringify(victory.survivors) === JSON.stringify(c.survivors.map((m) => ({ name: m.name, hp: m.hp, maxHp: m.maxHp })));
    const titleOk = c.banner.title.includes('🏆') && c.banner.title.includes('战斗结束') &&
      c.banner.title.includes((c.winner === 'human' ? '人类阵营' : '丧尸阵营')) && c.banner.title.includes('获胜');
    const settledOk = c.activeChips === 0 && c.currentCards === 0 && c.floats === 0;

    // 三級分層の実測（#16: 倒地/初接戦/終局行は log-key、行動行は陣営色）
    const keyTargets = c.log.filter((x) => x.text.indexOf('，倒地！') >= 0
      || x.text.indexOf('战斗结束') === 0 || x.text.indexOf('已达 ') === 0);
    const keyRowsOk = keyTargets.length > 0 && keyTargets.every((x) => (x.cls || '').indexOf('log-key') >= 0);
    const firstHitRow = c.log.find((x) => (x.cls || '').indexOf('log-action-hit') >= 0);
    const firstHitKeyOk = !!firstHitRow && firstHitRow.cls.indexOf('log-key') >= 0;
    const factionRowsOk = c.log.some((x) => x.cls && (x.cls.indexOf(' log-human') >= 0 || x.cls.indexOf(' log-zombie') >= 0));

    const passed = done && !c.banner.hidden && titleOk && bodyOk && logVictoryOk &&
      loserAllDowned && cardsOk && settledOk && keyRowsOk && firstHitKeyOk && factionRowsOk &&
      replay.violations.length === 0 &&
      orderSortedOk(ana) && rerollConsistent(ana);

    await fitViewport(cdp, 60);
    await shotViewport(cdp, join(SHOT_DIR, '03-victory.png'));

    return {
      passed, modeBefore, skipDisabledWhenClicked: skipDisabled, done,
      bannerTitle: c.banner.title, bannerBody: c.banner.body, bodyParsed,
      winner: c.winner, survivors: c.survivors, victoryLog: ana.victory, victoryParsed: victory,
      loserFaction, loserAllDowned, cardsOk, settledOk,
      keyRowsOk, keyRowCount: keyTargets.length, firstHitKeyOk, factionRowsOk,
      counts: (function () { const k = { fail: 0, dodge: 0, hit: 0 }; for (const p of ana.actionsParsed) if (p && k[p.kind] !== undefined) k[p.kind]++; return k; })(),
      rerolls: ana.rerolls.length, rounds: ana.rounds, logLines: c.log.length,
      orderSortedOk: orderSortedOk(ana), rerollConsistent: rerollConsistent(ana),
      violations: replay.violations
    };
  });

  /* -- STEP 4: 重置 → 配置画面へ戻り入力が編集可能に戻る --------------- */
  await runStep(4, 'reset-to-config', async () => {
    const resetBtn = await centerOf(cdp, '#btn-reset');
    if (!resetBtn || resetBtn.w < 4) throw new Error('btn-reset not visible');
    await clickAt(cdp, resetBtn.x, resetBtn.y);
    const back = await waitFor(cdp, "window.GameUI.getScreen() === 'config' && !document.getElementById('config-screen').hidden", 10000);

    const c = await evalJS(cdp, `(() => {
      const g = (id) => document.getElementById(id);
      const ids = ['human-militia','human-guard','human-gunner','human-scout',
                   'zombie-walker','zombie-rotwalker','zombie-shredder','zombie-sprinter','zombie-horde'];
      const fields = {};
      for (const id of ids) fields[id] = g(id) ? { value: g(id).value, disabled: g(id).disabled } : null;
      return {
        screen: window.GameUI.getScreen(), mode: window.GameUI.getMode(), fields,
        placementEnabled: !!g('config-placement') && !g('config-placement').disabled,
        battleHidden: g('battle-screen').hidden,
        startEnabled: !g('btn-start').disabled,
        gridEmpty: g('battle-grid').children.length === 0,
        stripEmpty: g('order-strip').children.length === 0,
        logEmpty: g('battle-log').children.length === 0,
        bannerHidden: g('battle-banner').hidden
      };
    })()`);
    const editableOk = Object.keys(c.fields).length === 9 && Object.keys(c.fields).every((id) => !c.fields[id].disabled) &&
      c.placementEnabled;
    const valuesKept = c.fields['human-militia'].value === '1' && c.fields['human-scout'].value === '2'
      && c.fields['zombie-horde'].value === '2';
    const passed = back && c.screen === 'config' && c.battleHidden && c.mode === 'idle' &&
      editableOk && c.startEnabled && c.gridEmpty &&
      c.stripEmpty && c.logEmpty && c.bannerHidden;
    await shotFull(cdp, join(SHOT_DIR, '04-reset-config.png'));
    return { passed, back, editableOk, valuesKept, startEnabled: c.startEnabled, emptied: { grid: c.gridEmpty, strip: c.stripEmpty, log: c.logEmpty, bannerHidden: c.bannerHidden } };
  });

  /* -- STEP 5: 初期站位を「阵营分区」へ切替 → 「快」で自動完走まで待つ
         （上限 120s）。速度ボタンは戦場ページの操作バー内（配置ページには
         存在しない）。実 UI の流れに沿い「配置切替 → 開戦 → 直後に「快」へ
         切替 → 待機」とする。分区配置の半区判定もここで行う ------------- */
  await runStep(5, 'fast-speed-autoplay-complete', async () => {
    const placementSet = await setSelect(cdp, 'config-placement', 'split');
    const startBtn = await centerOf(cdp, '#btn-start');
    if (!startBtn || startBtn.w < 4) throw new Error('btn-start not visible');
    await clickAt(cdp, startBtn.x, startBtn.y);
    const started = await waitFor(cdp, "window.GameUI.getScreen() === 'battle' && window.GameUI.getMode() === 'live'", 10000);
    if (!started) throw new Error('battle screen did not appear');
    const t0 = Date.now();

    const fastBtn = await centerOf(cdp, '#speed-fast');
    if (!fastBtn || fastBtn.w < 4) throw new Error('speed-fast not visible on battle screen');
    await clickAt(cdp, fastBtn.x, fastBtn.y);
    await sleep(150);
    const speedState = await evalJS(cdp, `(() => ({
      speed: window.GameUI.getSpeed(),
      activeBtn: (document.querySelector('.speed-btn.active') || {}).id || null
    }))()`);
    const finished = await waitFor(cdp, "window.GameUI.getMode() === 'done'", 120000, 250);
    const elapsedMs = Date.now() - t0;
    if (!started || !finished) throw new Error('battle did not auto-complete: started=' + started + ' finished=' + finished);

    const c = await evalJS(cdp, `(() => {
      const g = (id) => document.getElementById(id);
      const st = window.GameUI.getBattleState();
      const log = g('battle-log');
      return {
        banner: { hidden: g('battle-banner').hidden, title: g('banner-title').textContent, body: g('banner-body').textContent },
        winner: st ? st.winner : null,
        survivors: st ? st.survivors : null,
        steps: st ? st.steps : null,
        members: st ? st.members.map((m) => ({ name: m.name, faction: m.faction, typeId: m.typeId, hp: m.hp, maxHp: m.maxHp, downed: m.downed, pos: m.pos })) : null,
        logLines: [...log.children].map((d) => d.textContent),
        logScroll: { top: log.scrollTop, clientH: log.clientHeight, scrollH: log.scrollHeight }
      };
    })()`);

    writeFileSync(join(ROOT, 'verify', 'battle-log-dump.txt'), c.logLines.join('\n') + '\n', 'utf8');

    const ana = analyzeLog(c.logLines);
    const step5Info = memberInfoOf(c.members);
    const replay = replayValidate(ana, step5Info);
    const victory = parseVictory(ana.victory);
    const bodyParsed = c.banner.body.split('\n').filter((x) => x.length > 0).map((l) => {
      const m = l.match(/^(.+?)：剩余 HP (\d+)\/(\d+)$/);
      return m && { name: m[1], hp: +m[2], maxHp: +m[3] };
    });
    const loserFaction = c.winner === 'human' ? 'zombie' : (c.winner === 'zombie' ? 'human' : null);
    const loserMembers = loserFaction ? c.members.filter((m) => m.faction === loserFaction) : [];
    const loserAllDowned = loserMembers.length > 0 && loserMembers.every((m) => m.downed && m.hp === 0);
    const bodyOk = bodyParsed.length > 0 && bodyParsed.every(Boolean) &&
      JSON.stringify(bodyParsed) === JSON.stringify((c.survivors || []).map((m) => ({ name: m.name, hp: m.hp, maxHp: m.maxHp })));
    const logVictoryOk = !!victory && !!c.survivors &&
      JSON.stringify(victory.survivors) === JSON.stringify(c.survivors.map((m) => ({ name: m.name, hp: m.hp, maxHp: m.maxHp })));
    // ログ末尾の残 HP とバナー表示の整合（攻撃された生存者のみ照合可能）
    const lastHpOk = !!victory && victory.survivors.every((s) => {
      for (let i = ana.actions.length - 1; i >= 0; i--) {
        const m = ana.actions[i].match(new RegExp(s.name + ' 剩余 HP (\\d+)'));
        if (m) return +m[1] === s.hp;
      }
      return s.hp === s.maxHp;
    });
    const autoscrollOk = c.logScroll.scrollH > c.logScroll.clientH
      ? c.logScroll.top + c.logScroll.clientH >= c.logScroll.scrollH - 6
      : null;
    const replayDowned = [...replay.downed].sort();
    // 勝側にも陣亡者は出る（survivors から外れるだけ）ため、
    // 期待する倒地集合は「state で downed===true の全メンバー」とする
    const expectDowned = c.members.filter((m) => m.downed).map((m) => m.name).sort();
    const downedSetOk = JSON.stringify(replayDowned) === JSON.stringify(expectDowned);

    const counts = { fail: 0, dodge: 0, hit: 0 };
    for (const p of ana.actionsParsed) if (p && counts[p.kind] !== undefined) counts[p.kind]++;

    // 実コントロール（実クリック）で「快」へ切替できたことが合格条件
    const switchOk = speedState.speed === 'fast' && speedState.activeBtn === 'speed-fast';

    // 阵营分区の実測（初期配置に対して）: 人类は列 1..4、丧尸は列 6..9、
    // 中列 5 空置。最終 pos は移動で中列を跨ぐため、order 行の行尾座標で判定する
    const splitOk = ana.orderParsed.length === 6 && ana.orderParsed.every((o) => o && step5Info[o.name] && (
      step5Info[o.name].faction === 'human'
        ? (o.pos.col >= 1 && o.pos.col <= 4)
        : (o.pos.col >= 6 && o.pos.col <= 9)));
    const midColEmpty = ana.orderParsed.every((o) => o && o.pos.col !== 5);

    const passed = started && finished && !c.banner.hidden && c.winner &&
      placementSet === 'split' && switchOk && loserAllDowned && bodyOk && logVictoryOk && lastHpOk &&
      downedSetOk && splitOk && midColEmpty &&
      replay.violations.length === 0 && orderSortedOk(ana) && rerollConsistent(ana) &&
      ana.orderParsed.length === 6 && ana.actions.length > 0;

    await fitViewport(cdp, 60);
    await shotViewport(cdp, join(SHOT_DIR, '05-fast-complete.png'));

    // 診断用プローブ（判定には使わない）: GameUI.setSpeed API 経由なら
    // 切替が効くことを確認し、欠陥を「ボタン未配線」に特定する
    const apiProbe = await evalJS(cdp, `(() => {
      const before = { speed: window.GameUI.getSpeed(), activeBtn: (document.querySelector('.speed-btn.active') || {}).id || null };
      window.GameUI.setSpeed('fast');
      return { before, after: { speed: window.GameUI.getSpeed(), activeBtn: (document.querySelector('.speed-btn.active') || {}).id || null } };
    })()`);

    return {
      passed, placementSet, speedState, switchOk, apiProbe, started, finished, elapsedMs, engineSteps: c.steps,
      bannerTitle: c.banner.title, bannerBody: c.banner.body,
      winner: c.winner, survivors: c.survivors, victoryLog: ana.victory,
      loserFaction, loserAllDowned, downedSetOk, replayDowned, expectDowned, bodyOk, logVictoryOk, lastHpOk,
      splitOk, midColEmpty, moves: ana.moves.length, blocked: ana.blocked.length,
      counts, rerolls: ana.rerolls.length, rounds: ana.rounds, orderLines: ana.orderParsed,
      orderSortedOk: orderSortedOk(ana), rerollConsistent: rerollConsistent(ana),
      logLines: c.logLines.length, autoscrollOk, violations: replay.violations
    };
  });

  const allPassed = steps.every((s) => s.passed);
  writeFileSync(join(ROOT, 'verify', 'e2e-findings.json'),
    JSON.stringify({ allPassed, pageErrors, steps }, null, 2), 'utf8');
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
    writeFileSync(join(ROOT, 'verify', 'e2e-findings.json'),
      JSON.stringify({ allPassed: false, fatal: String((e && e.message) || e), pageErrors, steps }, null, 2), 'utf8');
  } catch { /* ignore */ }
  process.exit(2);
}
