// ======================================================================
// 丧尸 vs 人类 自動バトラー — 戦闘エンジン決定論テスト
//
// 実行方法:
//   node verify/engine.test.mjs
//
// * Node 組み込み機能のみ使用（サードパーティ依存ゼロ）。
// * 読み込み対象は src/engine.js / src/ui.js / src/index.html
//   （いずれも一切書き換えない）。
// * 両スクリプトを最小 DOM スタブ（Proxy の偽要素:
//   addEventListener / querySelector / value / textContent / innerHTML 等
//   を飲み込む）上でサンドボックス評価し、window.GameEngine と
//   window.GameUI を取得する。
// * 検証は 5 本立て:
//   (a) スクリプト済み乱数列（RngScript）による境界テスト
//       （先攻同点の重投、攻撃/回避の d7 境界、伤害区間、倒地とスキップ、
//        終局と勝者表示、純関数性、同一シード再現性）
//   (b) GameEngine.createRng(seed) による 223 戦のストレス試験と
//       ログ全面再生（HP 収支・ダイス境界・重投整合・行動数の有界性）
//   (c) 可視化改版（ADR 0001・逐行動リアルタイム実行）: startBattle/
//       stepBattle のステップ実行経路と runBattle 整場経路の完全一致
//       （同一シードなら終局 state とログが JSON レベルで一致）、
//       event と state 遷移・ログ追記の毎歩照合、倒地スキップの event、
//       終局後 stepBattle の無副作用、stepBattle==takeTurn の毎歩一致
//   (d) 戦場グリッド（9×9）: 初期配置の抽選アルゴリズム（作成順・残り
//       空きマスの行列表順）、mixed/split の候補プール、人数 1..36 と
//       placement の設定検査、隣接攻撃・1 マス移動の選路（唯一/並列/
//       受限/四面皆阻）、倒地マスの解放、移動・移動不能ログの逐字、
//       rng 消費計数、event↔state 照合（move/blocked）
//   (e) window.GameUI を DOM スタブ + 同期スケジューラ（遅延 ms を記録
//       するスパイを GameUI.createSyncScheduler() でラップ）で駆動する
//       UI 流程テスト（画面切替・設定ロック/解放・9×9 戦場グリッドと
//       カード transform の同期・逐次演出の飄字/血条/ログ同期・速度 3 段階
//       切替・跳到結果・重置・一键清空・終局横幅）
//
// 出力: 最終行に必ず RESULT {"assertions":N,"failures":[...]} を出す。
//       全件パスなら exit 0、失敗があれば exit 1。
//
// 仕様参照: src/engine.js 冒頭の GameEngine/GameUI API コメント塊、
//           src/engine.js・src/ui.js の実装本体、docs/adr/0001・0002。
// ======================================================================
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const INDEX_HTML_PATH = path.resolve(here, '..', 'src', 'index.html');
const ENGINE_PATH = path.resolve(here, '..', 'src', 'engine.js');
const UI_PATH = path.resolve(here, '..', 'src', 'ui.js');

// ------------------------------------------------ アサーション設備
let assertions = 0;
const failures = [];
let suppressedFailures = 0;
const MAX_LISTED_FAILURES = 500;

function pushFailure(label) {
  if (failures.length < MAX_LISTED_FAILURES) failures.push(String(label));
  else suppressedFailures++;
}
function check(cond, label) {
  assertions++;
  if (!cond) pushFailure(label);
  return !!cond;
}
function checkEq(actual, expected, label) {
  assertions++;
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) pushFailure(String(label) + ' | expected=' + b + ' | actual=' + a);
  return a === b;
}

// --------------------------------------- 乱数スクリプト用ヘルパ
// 引擎の公表セマンティクス（src/engine.js の実装）:
//   rollD(sides) = floor(rng() * sides) + 1
//   randInt(min,max) = min + floor(rng() * (max - min + 1))
// 指定値 v を出す生乱数 r は「積が k+0.5 の中点に来る」よう逆算する。
// 中点狙いなので倍精度誤差で隣の整数バケツに跨ることはない。
function rawForDie(v, sides) { return (v - 0.5) / sides; }
function rawForInt(v, min, max) { return (v - min + 0.5) / (max - min + 1); }

// スクリプト済み乱数列。積んだ値を順に返し、使い切ってさらに呼ばれたら
// 例外を投げる（引擎が想定外のロールをしたら即座に検出できる）。
class RngScript {
  constructor() { this.values = []; this.usedCount = 0; }
  pushDie(v, sides) { this.values.push(rawForDie(v, sides)); return this; }
  pushInt(v, min, max) { this.values.push(rawForInt(v, min, max)); return this; }
  get rng() {
    const self = this;
    return function () {
      if (self.usedCount >= self.values.length) {
        throw new Error('乱数スクリプトが枯渇（used=' + self.usedCount + '）');
      }
      return self.values[self.usedCount++];
    };
  }
  get used() { return this.usedCount; }
}

// ------------------------------------------------ 最小 DOM スタブ
// あらゆる要素参照・代入・未定義メソッド呼び出しを飲み込む Proxy 偽要素。
// UI 側 <script> の評価と GameUI 駆動テストのためのもの。エンジン自身は
// DOM に触れない。UI テストの観測を正確にするため、実 DOM の挙動のうち
// UI 層が依存する次の副作用だけを再現する:
//   * className 代入 → classList の内容を同期させる
//   * innerHTML / textContent への '' 代入 → children を空にする
//   * createElement で作った要素に id を付けたら document に登録する
//     （getElementById が同じ要素を返す。実 DOM と同じ参照関係にする）
//   * DocumentFragment の appendChild は子要素を展開して取り込む
function makeFakeElement(tag, id, onRegister) {
  const classSet = new Set();
  const store = {
    tagName: String(tag || 'div').toUpperCase(),
    id: id || '',
    children: [],
    listeners: {},
    style: {},
    textContent: '',
    innerHTML: '',
    value: '',
    hidden: false,
    disabled: false,
    className: '',
    type: '',
    min: '',
    max: '',
    step: '',
    scrollTop: 0,
    scrollHeight: 0,
  };
  const generic = {
    addEventListener(type, fn) { (store.listeners[type] = store.listeners[type] || []).push(fn); },
    removeEventListener() {},
    appendChild(child) {
      // DocumentFragment は実 DOM と同様に「子要素だけ」を挿入する
      if (child && child.tagName === '#DOCUMENT-FRAGMENT' && Array.isArray(child.children)) {
        const kids = child.children;
        for (let i = 0; i < kids.length; i++) store.children.push(kids[i]);
        return child;
      }
      store.children.push(child);
      return child;
    },
    insertBefore(child) { return child; },
    removeChild() { return null; },
    querySelector() { return makeFakeElement('div'); },
    querySelectorAll() { return []; },
    setAttribute() {},
    getAttribute() { return null; },
    removeAttribute() {},
    focus() {}, blur() {}, click() {},
    contains() { return false; },
    getBoundingClientRect() { return { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }; },
  };
  const el = new Proxy(store, {
    get(_t, prop) {
      if (typeof prop === 'symbol') return undefined;
      if (prop in store) return store[prop];
      if (prop in generic) return generic[prop];
      return undefined;
    },
    set(_t, prop, value) {
      if (typeof prop === 'symbol') return true;
      store[prop] = value;
      if (prop === 'id' && typeof onRegister === 'function' && value) {
        onRegister(String(value), el);
      } else if (prop === 'className') {
        classSet.clear();
        String(value == null ? '' : value).split(/\s+/).forEach(function (c) { if (c) classSet.add(c); });
      } else if ((prop === 'innerHTML' || prop === 'textContent') && value === '') {
        store.children.length = 0;
      }
      return true;
    },
  });
  store.classList = {
    add: function () { for (let i = 0; i < arguments.length; i++) if (arguments[i]) classSet.add(arguments[i]); },
    remove: function () { for (let i = 0; i < arguments.length; i++) classSet.delete(arguments[i]); },
    toggle: function (c, force) {
      const want = force === undefined ? !classSet.has(c) : !!force;
      if (want) classSet.add(c); else classSet.delete(c);
      return want;
    },
    contains: function (c) { return classSet.has(c); },
  };
  return el;
}

function makeDocumentStub() {
  const byId = new Map();
  return {
    getElementById(id) {
      if (!byId.has(id)) byId.set(id, makeFakeElement('div', id));
      return byId.get(id);
    },
    querySelector() { return makeFakeElement('div'); },
    querySelectorAll() { return []; },
    // createElement で作った要素に id が付いたら document に登録する
    //（実 DOM と同じく getElementById で同じ要素が取れるようにするため）
    createElement(tag) {
      return makeFakeElement(tag, '', function (vid, el) { byId.set(vid, el); });
    },
    createDocumentFragment() { return makeFakeElement('#document-fragment'); },
    addEventListener() {},
    body: makeFakeElement('body'),
    documentElement: makeFakeElement('html'),
  };
}

// ------------------- src/engine.js・src/ui.js から GameEngine を組み立てる
function loadGameEngine(engineSrc, uiSrc, html) {
  const iEngine = html.indexOf('<script src="engine.js">');
  const iUi = html.indexOf('<script src="ui.js">');
  check(iEngine !== -1, 'src/index.html が engine.js を参照する');
  check(iUi !== -1, 'src/index.html が ui.js を参照する');
  if (iEngine !== -1 && iUi !== -1) {
    check(iEngine < iUi, 'src/index.html は engine.js を ui.js より先に読む');
  }
  const doc = makeDocumentStub();
  const sandbox = {
    window: { document: doc },
    document: doc,
    module: { exports: {} },
    console: { log() {}, warn() {}, error() {} },
  };
  vm.createContext(sandbox);
  vm.runInContext(engineSrc, sandbox, { filename: 'src/engine.js' });
  // UI 側もスタブ DOM 上で評価を通す（エンジン評価の後。UI は window.GameEngine
  // に依存するため順序は固定）
  vm.runInContext(uiSrc, sandbox, { filename: 'src/ui.js' });
  const GE = sandbox.window.GameEngine || sandbox.module.exports;
  check(!!GE, 'window.GameEngine（または module.exports）が公開されている');
  // UI 層の公開面と評価に使った document スタブを UI 流程テスト用に保持する
  GUI = sandbox.window.GameUI || null;
  DOC = doc;
  check(!!GUI, 'window.GameUI が公開されている');
  return GE;
}

// ------------------------------------------- ログ書式リテラルの裏取り
// 正規表現に埋め込る書式断片は、src/engine.js の実装から採取したリテラル。
// ゲームソース内に実在しない断片を使っていたら、実装でなく
// テスト側の写し間違いとして即検出できるようにする。
const LOG_LITERALS = {
  headSep: ' → ',
  colon: '：',
  atk: '攻击检定 d7=',
  atkMid: ' ≤ 攻击',
  failMid: ' ＞ 攻击',
  failEnd: '，攻击失败',
  dodgeMid: '，命中；闪避检定 d7=',
  dodgeMid2: ' ≤ 敏捷',
  dodgeEnd: '，闪避成功',
  unevaded: ' ＞ 敏捷',
  dmgMid: '，未闪避；伤害 ',
  hpLeft: ' 剩余 HP ',
  downedEnd: '，倒地！',
  rerollHead: '【先攻重投】',
  rerollAnchor: '（同为 ',
  rerollTail: ' 点）重投 d100：',
  orderMark: '（d100=',
  orderHeader: '【行动顺序】',
  roundHead: '── 第 ',
  roundTail: ' 轮 ──',
  victoryHead: '战斗结束：',
  victoryWin: '获胜！存活角色：',
  hpShow: '（HP ',
  pairSep: '、',
  histSep: '→',
  moveMark: ' 移动：',
  blockedTail: ' 无法移动（无路可走）',
};
function checkLogLiterals(gameSrc) {
  for (const k of Object.keys(LOG_LITERALS)) {
    check(gameSrc.includes(LOG_LITERALS[k]),
      'ログ書式リテラル「' + LOG_LITERALS[k] + '」がゲームソース（src/engine.js / src/ui.js）に実在する（' + k + '）');
  }
}

function esc(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// 行動ログ行の正規表現（LOG_LITERALS から組み立てるので写し間違いがない）
const RE_FAIL = new RegExp(
  '^(.+?)' + esc(' → ') + '(.+?)' + esc('：攻击检定 d7=') + '(\\d+)'
  + esc(' ＞ 攻击') + '(\\d+)' + esc('，攻击失败') + '$');
const RE_DODGE = new RegExp(
  '^(.+?)' + esc(' → ') + '(.+?)' + esc('：攻击检定 d7=') + '(\\d+)'
  + esc(' ≤ 攻击') + '(\\d+)' + esc('，命中；闪避检定 d7=') + '(\\d+)'
  + esc(' ≤ 敏捷') + '(\\d+)' + esc('，闪避成功') + '$');
const RE_HIT = new RegExp(
  '^(.+?)' + esc(' → ') + '(.+?)' + esc('：攻击检定 d7=') + '(\\d+)'
  + esc(' ≤ 攻击') + '(\\d+)' + esc('，命中；闪避检定 d7=') + '(\\d+)'
  + esc(' ＞ 敏捷') + '(\\d+)' + esc('，未闪避；伤害 ') + '(\\d+)'
  + esc('，') + '\\2' + esc(' 剩余 HP ') + '(\\d+)' + '(' + esc('，倒地！') + ')?$');
const RE_ORDER = new RegExp(
  '^(\\d+)\\. (.+?)' + esc('（d100=') + '([\\d→]+)' + esc('）')
  + esc('（') + '(\\d+)' + esc(',') + '(\\d+)' + esc('）') + '$');
const RE_REROLL = new RegExp(
  '^' + esc('【先攻重投】') + '(.+?)' + esc('（同为 ') + '(\\d+)'
  + esc(' 点）重投 d100：') + '(.+)$');
const RE_REROLL_PAIR = new RegExp('^(.+?)' + esc('→') + '(\\d+)$');
const RE_ROUND = new RegExp('^' + esc('── 第 ') + '(\\d+)' + esc(' 轮 ──') + '$');
// 移動行「玩家1 移动：（3,4）→（3,5）」・移動不能行「玩家1 无法移动（无路可走）」
const RE_MOVE = new RegExp(
  '^(.+?)' + esc(' 移动：') + esc('（') + '(\\d+)' + esc(',') + '(\\d+)'
  + esc('）→（') + '(\\d+)' + esc(',') + '(\\d+)' + esc('）') + '$');
const RE_BLOCKED = new RegExp('^(.+?)' + esc(' 无法移动（无路可走）') + '$');

// エンジンの cmpRollsDesc（298〜304 行目）と同じ「履歴の辞書順降順」比較。
// 戻り値の符号規約はエンジンどおり: 第 1 引数が後ろに来るほど正、
// 降順に整列済みの隣接対 (prev, cur) では cmpHistDesc(prev, cur) < 0 になる。
function cmpHistDesc(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) return b[i] - a[i];
  }
  return b.length - a.length;
}

function deepCopy(x) { return JSON.parse(JSON.stringify(x)); }

// ------------------------------------------- 戦場グリッド用ヘルパ
// マンハッタン距離（座標は 1 始まりの {row, col}）
function manhattan(a, b) {
  return Math.abs(a.row - b.row) + Math.abs(a.col - b.col);
}
function isAdjacent(a, b) {
  return !!a && !!b && manhattan(a, b) === 1;
}
function inBounds9(p) {
  return !!p && p.row >= 1 && p.row <= 9 && p.col >= 1 && p.col <= 9;
}

// エンジンと同じ「残り空きマス（行列表順）」管理をテスト側で再現し、
// 目標セル（作成順）を得るための randInt(0, k-1) の抽選値を逆算する。
// mixed 前提（両陣営で 81 マスの共有プールを消費する）。戻り値は
// [{v, k}]（v: 抽選値, k: その時点の残り数）。目標セルが重複・範囲外なら例外。
function placementDraws(targetCells) {
  const free = [];
  for (let r = 1; r <= 9; r++) {
    for (let c = 1; c <= 9; c++) free.push({ row: r, col: c });
  }
  return targetCells.map((cell) => {
    const idx = free.findIndex((f) => f.row === cell.row && f.col === cell.col);
    if (idx < 0) throw new Error('placementDraws: 目標セルが不正または占有済み');
    const k = free.length;
    free.splice(idx, 1);
    return { v: idx, k: k };
  });
}

// UI の transform 文字列（ui.js の transformFor と CELL_PX=44 を模倣）。
// カードの transform と state の pos の照合に使う
function transformFor(pos) {
  return 'translate(' + (pos.col - 1) * 44 + 'px, ' + (pos.row - 1) * 44 + 'px)';
}

// ----------------------------------------- ステップ実行テスト用の補助
// state の安価なフィンガープリント。stepBattle が入力 state を破壊して
// いないことの毎歩チェックに使う（ログ本文は末尾 1 行だけ見る。全文の
// JSON 比較は重いので、全入りは代表ケースでのみ行う）。
function fp(s) {
  const parts = [s.turnIndex, s.round, s.steps, s.finished, s.winner,
    s.order.length, s.log.length];
  for (const m of s.members) {
    parts.push(m.name, m.hp, m.downed ? 1 : 0,
      m.pos ? m.pos.row : 0, m.pos ? m.pos.col : 0);
  }
  parts.push(s.log.length > 0 ? s.log[s.log.length - 1].text : '');
  return JSON.stringify(parts);
}

// stepBattle の 1 ステップを照合する（純関数: 失敗理由の文字列を返すだけ）。
// event が「実際に起きた state 遷移・ログ追記」と整合すること、および
// 行動種ごとのダイス境界・伤害収支を検査する。ok=false のとき diag に
// 人間が読める理由を入れる。
function stepOk(p, n, ev) {
  const KINDS = ['skip', 'none', 'fail', 'dodge', 'hit', 'move', 'blocked', 'forced-draw'];
  const bad = (msg) => ({ ok: false, diag: msg });
  const mByName = (s, name) => {
    for (const m of s.members) if (m.name === name) return m;
    return null;
  };
  if (!ev || typeof ev !== 'object') return bad('event がオブジェクトでない: ' + String(ev));
  if (KINDS.indexOf(ev.kind) < 0) return bad('未知の event.kind: ' + ev.kind);
  if (n.steps !== p.steps + 1) return bad('steps が +1 でない: ' + p.steps + '→' + n.steps);
  const added = n.log.slice(p.log.length);

  // 終局ステップ: 最終追記は victory 行で、ev.winner が state と一致
  if (ev.finished === true) {
    if (!n.finished) return bad('ev.finished なのに state.finished が偽');
    if (ev.winner !== n.winner) return bad('ev.winner 不一致: ' + ev.winner + ' vs ' + n.winner);
    if (added.length === 0 || added[added.length - 1].type !== 'victory') {
      return bad('終局ステップの最終追記が victory でない: '
        + JSON.stringify(added.map(e => e.type)));
    }
  } else {
    if (n.finished) return bad('ev.finished がないのに state が終局している');
    if (added.some(e => e.type === 'victory')) return bad('非終局ステップで victory 行が追記された');
  }

  // 行動位置の規則: 終局ステップでは advance しない。それ以外は 1 つ進み、
  // 末尾で折り返したら round を 1 増やす（skip/fail/dodge/hit/move/blocked 共通）
  let expTurn = p.turnIndex;
  let expRound = p.round;
  const advances = !n.finished
    && (ev.kind === 'skip' || ev.kind === 'fail' || ev.kind === 'dodge' || ev.kind === 'hit'
      || ev.kind === 'move' || ev.kind === 'blocked');
  if (advances) {
    expTurn = p.turnIndex + 1;
    if (expTurn >= p.order.length) { expTurn = 0; expRound = p.round + 1; }
  }
  if (n.turnIndex !== expTurn) {
    return bad('turnIndex 不一致: ' + p.turnIndex + '→' + n.turnIndex + '（期待 ' + expTurn + '）');
  }
  if (n.round !== expRound) {
    return bad('round 不一致: ' + p.round + '→' + n.round + '（期待 ' + expRound + '）');
  }

  if (ev.kind === 'skip') {
    // 倒地者の番: 何も起きず、追記はラップ時の round 行あっても 1 行だけ
    const a = mByName(p, ev.actor);
    if (!a) return bad('skip の actor が実在しない: ' + ev.actor);
    if (!a.downed) return bad('skip の actor が倒地していない: ' + ev.actor);
    if (added.length > 1) return bad('skip で 2 行以上追記: ' + JSON.stringify(added.map(e => e.type)));
    if (added.length === 1 && added[0].type !== 'round') {
      return bad('skip の追記は round 行のみのはず: ' + added[0].type);
    }
    return { ok: true, diag: '' };
  }
  if (ev.kind === 'none' || ev.kind === 'forced-draw') {
    // 保険経路。発生件数自体は呼び出し側で数えて別途検査する
    return { ok: true, diag: '' };
  }
  if (ev.kind === 'move' || ev.kind === 'blocked') {
    // 移動系: actor の番で、攻撃ログは出ない。move は 1 マス移動で
    // from/to が該当ステップ前後の pos と一致し、to は界内かつ未占拠。
    // blocked は移動候補が 1 つもないこと（四面皆阻）の裏取りをする。
    const a = mByName(p, ev.actor);
    if (!a) return bad('move/blocked の actor が実在しない: ' + ev.actor);
    if (a.downed) return bad('move/blocked の actor が倒地している: ' + ev.actor);
    if (added.length > 2) return bad('移動系で 3 行以上追記: ' + JSON.stringify(added.map(e => e.type)));
    if (added.length === 2 && added[1].type !== 'round') {
      return bad('移動系の追記 2 行目は折り返し round 行のはず: ' + added[1].type);
    }
    const actLine = added.length >= 1 ? added[0] : null;
    if (!actLine) return bad('移動系なのにログ無追記');
    if (!inBounds9(a.pos)) return bad('移動系の actor が界外');
    // 前提: 移動系が起きるのは隣接敵が 1 人もいないときだけ
    const adjEnemy = p.members.some((m) => !m.downed && m.faction !== a.faction
      && isAdjacent(m.pos, a.pos));
    if (adjEnemy) return bad('隣接敵がいるのに攻撃でなく移動系になった');
    const occupied = (c, st) => st.members.some((m) => !m.downed
      && m.pos && m.pos.row === c.row && m.pos.col === c.col);
    if (ev.kind === 'blocked') {
      if (actLine.type !== 'action-blocked') return bad('blocked なのに ' + actLine.type);
      if (actLine.text !== ev.actor + ' 无法移动（无路可走）') return bad('blocked 行の文言: ' + actLine.text);
      const cands = [[a.pos.row - 1, a.pos.col], [a.pos.row, a.pos.col - 1],
        [a.pos.row, a.pos.col + 1], [a.pos.row + 1, a.pos.col]]
        .filter(([r, c]) => r >= 1 && r <= 9 && c >= 1 && c <= 9)
        .filter(([r, c]) => !occupied({ row: r, col: c }, p));
      if (cands.length !== 0) return bad('候補があるのに blocked になった');
      const a2 = mByName(n, ev.actor);
      if (!a2 || !a2.pos || a2.pos.row !== a.pos.row || a2.pos.col !== a.pos.col) {
        return bad('blocked なのに pos が変化した');
      }
      return { ok: true, diag: '' };
    }
    // move
    if (actLine.type !== 'action-move') return bad('move なのに ' + actLine.type);
    if (!ev.from || !ev.to) return bad('move event に from/to がない');
    if (!inBounds9(ev.to)) return bad('move の to が界外');
    if (manhattan(ev.from, ev.to) !== 1) return bad('move が 1 マスでない');
    if (!ev.from || ev.from.row !== a.pos.row || ev.from.col !== a.pos.col) {
      return bad('ev.from が遷移前 pos と不一致');
    }
    if (occupied(ev.to, p)) return bad('移動先が未倒地メンバーに占拠されている');
    const a2 = mByName(n, ev.actor);
    if (!a2 || !a2.pos || a2.pos.row !== ev.to.row || a2.pos.col !== ev.to.col) {
      return bad('ev.to が遷移後 pos と不一致');
    }
    const expected = ev.actor + ' 移动：'
      + '（' + ev.from.row + ',' + ev.from.col + '）'
      + '→' + '（' + ev.to.row + ',' + ev.to.col + '）';
    if (actLine.text !== expected) return bad('move 行の文言不一致: ' + actLine.text);
    return { ok: true, diag: '' };
  }

  // fail / dodge / hit: 行動ログ 1 行（+終局の victory 行 or 折り返しの round 行）
  let actLine = null;
  if (added.length === 1) {
    actLine = added[0];
  } else if (added.length === 2) {
    if (!n.finished && added[1].type === 'round') actLine = added[0];
    else if (n.finished && added[1].type === 'victory') actLine = added[0];
    else return bad('行動ステップの追記 2 行目が不正: ' + JSON.stringify(added.map(e => e.type)));
  } else {
    return bad('行動ステップの追記行数が不正: ' + JSON.stringify(added.map(e => e.type)));
  }
  const a = mByName(p, ev.actor);
  const t = mByName(p, ev.target);
  if (!a || !t) return bad('actor/target が実在しない: ' + ev.actor + ', ' + ev.target);
  if (a.downed || t.downed) return bad('倒地者が actor/target になった');
  if (a.faction === t.faction) return bad('target が同一陣営');
  // 隣接攻撃の規則: 攻撃対象は行動者の上下左右 4 隣接にいること
  if (!isAdjacent(a.pos, t.pos)) return bad('非隣接の target が選ばれた: ' + ev.target);
  const head = ev.actor + ' → ' + ev.target + '：';
  if (!actLine.text.startsWith(head)) return bad('ログ行の actor/target が event と不一致: ' + actLine.text);

  if (ev.kind === 'fail') {
    if (actLine.type !== 'action-fail') return bad('fail なのに ' + actLine.type);
    if (actLine.text.indexOf('攻击失败') < 0) return bad('fail 行の文言: ' + actLine.text);
    if (ev.attack !== a.attack) return bad('ev.attack が行動者の攻撃と不一致');
    if (!(ev.atkRoll >= 1 && ev.atkRoll <= 7)) return bad('atkRoll が d7 の範囲外: ' + ev.atkRoll);
    if (!(ev.atkRoll > a.attack)) return bad('攻撃失敗なのに d7<=攻撃: ' + ev.atkRoll);
    return { ok: true, diag: '' };
  }
  if (ev.attack !== a.attack || ev.agility !== t.agility) {
    return bad('ev.attack/ev.agility が行動者/目標の値と不一致');
  }
  if (!(ev.atkRoll >= 1 && ev.atkRoll <= 7 && ev.dodgeRoll >= 1 && ev.dodgeRoll <= 7)) {
    return bad('d7 出目が範囲外: ' + ev.atkRoll + ',' + ev.dodgeRoll);
  }
  if (!(ev.atkRoll <= a.attack)) return bad('命中扱いなのに d7>攻撃: ' + ev.atkRoll);
  if (ev.kind === 'dodge') {
    if (actLine.type !== 'action-dodge') return bad('dodge なのに ' + actLine.type);
    if (actLine.text.indexOf('闪避成功') < 0) return bad('dodge 行の文言: ' + actLine.text);
    if (!(ev.dodgeRoll <= t.agility)) return bad('回避成功なのに d7>敏捷: ' + ev.dodgeRoll);
    const t2 = mByName(n, ev.target);
    if (!t2 || t2.hp !== t.hp || t2.downed) return bad('回避で目標の HP/倒地が変化した');
    return { ok: true, diag: '' };
  }
  // hit
  if (actLine.type !== 'action-hit') return bad('hit なのに ' + actLine.type);
  if (actLine.text.indexOf('伤害 ' + ev.damage) < 0) return bad('hit 行に伤害値がない: ' + actLine.text);
  if ((actLine.text.indexOf('倒地！') >= 0) !== !!ev.downed) return bad('倒地表示と ev.downed の不一致');
  if (!(ev.damage >= a.dmgMin && ev.damage <= a.dmgMax)) {
    return bad('damage が行動者の区間外: ' + ev.damage + ' 区間=[' + a.dmgMin + ',' + a.dmgMax + ']');
  }
  if (ev.hpBefore !== t.hp) return bad('hpBefore が遷移前の目標 HP と不一致');
  if (ev.hpAfter !== Math.max(0, ev.hpBefore - ev.damage)) return bad('hpAfter の収支不一致');
  if (!!ev.downed !== (ev.hpAfter === 0)) return bad('downed と hpAfter==0 の不一致');
  const t2 = mByName(n, ev.target);
  if (!t2 || t2.hp !== ev.hpAfter || !!t2.downed !== !!ev.downed) {
    return bad('遷移後の目標 HP/倒地が event と不一致');
  }
  return { ok: true, diag: '' };
}

// stepBattle / takeTurn の両経路を同じシードで並走させ、毎歩の state が
// 完全一致すること（= 同じ内部経路であること）を検証する。
function compareTakeTurnChain(cfg, seed, label) {
  const rngS = GE.createRng(seed);
  const rngT = GE.createRng(seed);
  let s = GE.startBattle(deepCopy(cfg), rngS);
  let t = GE.startBattle(deepCopy(cfg), rngT);
  checkEq(JSON.stringify(t), JSON.stringify(s), label + ': takeTurn 側の開始 state も一致');
  let i = 0;
  let guard = 0;
  while (!s.finished) {
    if (++guard > 500000) { pushFailure(label + ': ステップ連鎖が終わらない（guard）'); return i; }
    const r = GE.stepBattle(s, rngS);
    s = r.state;
    t = GE.takeTurn(t, rngT);
    i++;
    checkEq(JSON.stringify(s), JSON.stringify(t), label + ' の ' + i + ' 歩目: stepBattle==takeTurn');
  }
  checkEq(JSON.stringify(t), JSON.stringify(GE.runBattle(deepCopy(cfg), GE.createRng(seed))),
    label + ': takeTurn 連鎖の終局も整場一括と一致');
  return i;
}

let GE = null;
let GUI = null; // window.GameUI（loadGameEngine が評価時に設定する）
let DOC = null; // 評価に使った document スタブ（要素の観測用）

// ------------------------------------------------ state 生成ヘルパ
// 既定設定に上書きをマージし、初期配置と先攻 d100 を制御した初期 state を
// 作る。開戦経路（startBattle = 検査 → state 生成 → 初期配置 → 先攻）を
// RngScript で駆動するため、乱数消費順は「配置（1 人 1 回）→ d100」。
// opts.pos: メンバー作成順の目標セル一覧（省略時は下記の隣接既定配置）。
// rolls を指定しなければ first 側が 90,89…、もう一方は 40,39…（同点なし）。
function defaultPos(h, z) {
  // 1v1: (1,1) と (1,2)。2v1: 丧尸1 の四隣のうち 2 マスに 2 人類を取り、
  // 全員が誰か 1 体と隣接する形（攻撃境界テストがその前提で組まれている）
  if (h === 1 && z === 1) return [{ row: 1, col: 1 }, { row: 1, col: 2 }];
  if (h === 2 && z === 1) return [{ row: 1, col: 2 }, { row: 2, col: 3 }, { row: 2, col: 2 }];
  throw new Error('makeState: この構成の既定配置はないので opts.pos を指定してください');
}
function makeState(opts) {
  const human = { ...GE.DEFAULT_CONFIG.human, ...(opts.human || {}) };
  const zombie = { ...GE.DEFAULT_CONFIG.zombie, ...(opts.zombie || {}) };
  const cfg = { human, zombie };
  const n = human.count + zombie.count;
  const cells = opts.pos || defaultPos(human.count, zombie.count);
  checkEq(cells.length, n, 'makeState: 目標セルはメンバー数分');
  const draws = placementDraws(cells);
  const hRolls = opts.humanRolls
    || Array.from({ length: human.count }, (_, i) => (opts.first === 'human' ? 90 - i : 40 - i));
  const zRolls = opts.zombieRolls
    || Array.from({ length: zombie.count }, (_, i) => (opts.first === 'zombie' ? 90 - i : 40 - i));
  const rs = new RngScript();
  for (const d of draws) rs.pushInt(d.v, 0, d.k - 1);
  for (const v of hRolls) rs.pushDie(v, 100);
  for (const v of zRolls) rs.pushDie(v, 100);
  const s = GE.startBattle(cfg, rs.rng);
  checkEq(rs.used, n * 2, 'makeState: 初期配置（人数分）＋先攻 d100（人数分）だけ消費');
  // 抽選列どおりのセルに落ちたこと（=抽選アルゴリズムの裏取り）も毎回確認
  s.members.forEach((m, i) => {
    checkEq(m.pos, cells[i], 'makeState: ' + m.name + ' の初期配置は目標セルと一致');
  });
  return { state: s, cfg };
}

// 手作り state: config + 作成順の pos + 作成順の d100 出目から、
// 開戦済み state を組み立てる（配置抽選をスクリプトせず pos を直接置く。
// 戦闘中の選路シナリオで自由な盤面を作るためのテスト専用ヘルパ）
function placedState(cfg, posByCreation, rollsByCreation) {
  let s = GE.createBattleState(cfg);
  checkEq(posByCreation.length, s.members.length, 'placedState: pos はメンバー数分');
  s.members.forEach((m, i) => {
    check(inBounds9(posByCreation[i]), 'placedState: pos は界内');
    m.pos = { row: posByCreation[i].row, col: posByCreation[i].col };
  });
  const rs = new RngScript();
  for (const v of rollsByCreation) rs.pushDie(v, 100);
  s = GE.rollInitiative(s, rs.rng);
  checkEq(rs.used, rollsByCreation.length, 'placedState: 先攻 d100 だけ消費');
  return s;
}

// takeTurn 1 回分の新規ログから行動エントリ（fail/dodge/hit）を拾う
function actionEntriesBetween(s, from) {
  const out = [];
  for (let i = from; i < s.log.length; i++) {
    if (/^action-/.test(s.log[i].type)) out.push(s.log[i]);
  }
  return out;
}

// ---------------------------------------------- 行動ログ 1 行の検証
// 書式・ダイス境界・伤害区間・HP 収支・倒地者は行動者/目標にならない、を検証。
function verifyActionEntry(e, sim, label) {
  if (e.type === 'action-fail') {
    const m = e.text.match(RE_FAIL);
    check(!!m, label + ': fail 行の書式: ' + e.text);
    if (!m) return;
    const a = sim[m[1]], t = sim[m[2]];
    const atk = Number(m[3]), atkShown = Number(m[4]);
    check(!!a && !!t, label + ': 行動者・目標が実在: ' + e.text);
    if (!a || !t) return;
    check(isAdjacent(a.pos, t.pos), label + ': 攻撃は隣接（4 隣接）時のみ: ' + e.text);
    check(atk >= 1 && atk <= 7, label + ': d7 出目は 1..7: ' + e.text);
    checkEq(atkShown, a.attack, label + ': 表記攻撃値 == 行動者の攻撃');
    check(atk > a.attack, label + ': 攻撃失敗は d7 > 攻撃 のときだけ: ' + e.text);
    check(!a.downed, label + ': 倒地者が行動ログに現れない: ' + m[1]);
    check(!t.downed, label + ': 倒地者が目標に選ばれない: ' + m[2]);
    check(a.faction !== t.faction, label + ': 目標は対立陣営');
  } else if (e.type === 'action-dodge') {
    const m = e.text.match(RE_DODGE);
    check(!!m, label + ': dodge 行の書式: ' + e.text);
    if (!m) return;
    const a = sim[m[1]], t = sim[m[2]];
    const atk = Number(m[3]), atkShown = Number(m[4]);
    const dg = Number(m[5]), agShown = Number(m[6]);
    check(!!a && !!t, label + ': 行動者・目標が実在: ' + e.text);
    if (!a || !t) return;
    check(isAdjacent(a.pos, t.pos), label + ': 攻撃は隣接（4 隣接）時のみ: ' + e.text);
    check(atk >= 1 && atk <= 7 && dg >= 1 && dg <= 7, label + ': d7 出目は 1..7: ' + e.text);
    checkEq(atkShown, a.attack, label + ': 表記攻撃値 == 行動者の攻撃');
    checkEq(agShown, t.agility, label + ': 表記敏捷値 == 目標の敏捷');
    check(atk <= a.attack, label + ': 命中は d7 <= 攻撃 のときだけ: ' + e.text);
    check(dg <= t.agility, label + ': 回避成功は d7 <= 敏捷 のときだけ: ' + e.text);
    check(!a.downed && !t.downed, label + ': 倒地者は行動者・目標にならない');
    check(a.faction !== t.faction, label + ': 目標は対立陣営');
  } else if (e.type === 'action-hit') {
    const m = e.text.match(RE_HIT);
    check(!!m, label + ': hit 行の書式: ' + e.text);
    if (!m) return;
    const a = sim[m[1]], t = sim[m[2]];
    const atk = Number(m[3]), atkShown = Number(m[4]);
    const dg = Number(m[5]), agShown = Number(m[6]);
    const dmg = Number(m[7]), hpLeft = Number(m[8]);
    const downedMark = m[9] !== undefined;
    check(!!a && !!t, label + ': 行動者・目標が実在: ' + e.text);
    if (!a || !t) return;
    check(isAdjacent(a.pos, t.pos), label + ': 攻撃は隣接（4 隣接）時のみ: ' + e.text);
    check(atk >= 1 && atk <= 7 && dg >= 1 && dg <= 7, label + ': d7 出目は 1..7: ' + e.text);
    checkEq(atkShown, a.attack, label + ': 表記攻撃値 == 行動者の攻撃');
    checkEq(agShown, t.agility, label + ': 表記敏捷値 == 目標の敏捷');
    check(atk <= a.attack, label + ': 命中は d7 <= 攻撃 のときだけ: ' + e.text);
    check(dg > t.agility, label + ': 未回避は d7 > 敏捷 のときだけ: ' + e.text);
    check(dmg >= a.dmgMin && dmg <= a.dmgMax,
      label + ': 伤害は行動者の区間内（両端含む）: dmg=' + dmg
      + ' 区間=[' + a.dmgMin + ',' + a.dmgMax + ']');
    check(!a.downed && !t.downed, label + ': 倒地者は行動者・目標にならない');
    check(a.faction !== t.faction, label + ': 目標は対立陣営');
    const expected = Math.max(0, t.hp - dmg);
    checkEq(hpLeft, expected, label + ': 剩余 HP は再生 HP - 伤害（0 丸め）: ' + m[2]);
    t.hp = hpLeft;
    if (downedMark) {
      checkEq(hpLeft, 0, label + ': 「倒地！」は HP0 とセット');
      t.downed = true;
    } else {
      check(hpLeft >= 1, label + ': 倒地表示なしで HP0 にはならない');
    }
  } else {
    check(false, label + ': 想定外の行動ログ type: ' + e.type);
  }
}

// ------------------------------------- state + ログ全面再生の整合検証
// ログだけから HP / 倒地 / 先攻履歴を再生し、最終 state と完全一致させる。
// 「HP は命中ログ以外で減らない」「行動ログは全行動を網羅」「行動数は有界」
// 「重投は同点組だけ・決着まで」の裏取りになる。
function verifyStateAndLog(state, cfg, label) {
  const n = state.members.length;

  // 再生用: name → 陣営設定由来の初期値（pos は order 行の行尾座標から復元）
  const sim = {};
  for (const m of state.members) {
    const c = cfg[m.faction];
    check(!!c, label + ': config に陣営 ' + m.faction + ' の設定がある');
    sim[m.name] = {
      faction: m.faction,
      hp: c ? c.hp : m.maxHp,
      attack: c ? c.attack : m.attack,
      agility: c ? c.agility : m.agility,
      dmgMin: c ? c.dmgMin : m.dmgMin,
      dmgMax: c ? c.dmgMax : m.dmgMax,
      downed: false,
      pos: null,
    };
  }

  let lastRoundNo = 0;
  let actionCount = 0;
  let moveCount = 0;
  let blockedCount = 0;
  let victoryCount = 0;
  let afterVictory = false;
  const orderParsed = []; // {name, history, pos}
  const rerollTexts = [];

  for (let i = 0; i < state.log.length; i++) {
    const e = state.log[i];
    check(e !== null && typeof e === 'object' && typeof e.type === 'string' && typeof e.text === 'string',
      label + ': log[' + i + '] は {type,text} 形');
    if (!e || typeof e.text !== 'string') continue;
    if (victoryCount > 0) afterVictory = true;
    switch (e.type) {
      case 'round': {
        const m = e.text.match(RE_ROUND);
        check(!!m, label + ': round 行の書式: ' + e.text);
        if (m) {
          const no = Number(m[1]);
          checkEq(no, lastRoundNo + 1, label + ': round 番号は 1 から 1 ずつ増える');
          lastRoundNo = no;
        }
        break;
      }
      case 'order-header': {
        check(e.text.includes('【行动顺序】'), label + ': 順序ヘッダ行: ' + e.text);
        break;
      }
      case 'order': {
        const m = e.text.match(RE_ORDER);
        check(!!m, label + ': order 行の書式（行尾に初期座標を含む）: ' + e.text);
        if (m) {
          checkEq(Number(m[1]), orderParsed.length + 1, label + ': order 行番号は連番');
          const history = m[3].split('→').map(Number);
          check(history.length >= 1 && history.every(v => v >= 1 && v <= 100),
            label + ': d100 出目は 1..100: ' + m[2]);
          const pos = { row: Number(m[4]), col: Number(m[5]) };
          check(inBounds9(pos), label + ': 初期座標は界内: ' + e.text);
          orderParsed.push({ name: m[2], history, pos });
          if (sim[m[2]]) sim[m[2]].pos = pos;
        }
        break;
      }
      case 'reroll':
        rerollTexts.push(e.text);
        break;
      case 'action-fail':
      case 'action-dodge':
      case 'action-hit':
        actionCount++;
        verifyActionEntry(e, sim, label + ' log[' + i + ']');
        break;
      case 'action-move': {
        const m = e.text.match(RE_MOVE);
        check(!!m, label + ': move 行の書式: ' + e.text);
        if (m) {
          moveCount++;
          const name = m[1];
          check(!!sim[name], label + ': 移動者が実在: ' + e.text);
          const from = { row: Number(m[2]), col: Number(m[3]) };
          const to = { row: Number(m[4]), col: Number(m[5]) };
          check(inBounds9(from) && inBounds9(to), label + ': 移動座標は界内: ' + e.text);
          checkEq(manhattan(from, to), 1, label + ': 移動はちょうど 1 マス: ' + e.text);
          if (sim[name] && sim[name].pos) {
            checkEq(sim[name].pos, from, label + ': 移動元は再生上の現在地と一致: ' + e.text);
          }
          if (sim[name]) sim[name].pos = to;
        }
        break;
      }
      case 'action-blocked': {
        const m = e.text.match(RE_BLOCKED);
        check(!!m, label + ': blocked 行の書式: ' + e.text);
        if (m) {
          blockedCount++;
          check(!!sim[m[1]], label + ': 移動不能者が実在: ' + e.text);
        }
        break;
      }
      case 'victory':
        victoryCount++;
        break;
      default:
        check(false, label + ': 未知のログ type: ' + e.type);
    }
  }
  checkEq(afterVictory, false, label + ': victory 行より後ろにログ行がない');
  checkEq(victoryCount, 1, label + ': victory 行はちょうど 1 件');
  checkEq(orderParsed.length, n, label + ': order 行は全員分');
  checkEq(state.log.length,
    rerollTexts.length + 1 + n + lastRoundNo + actionCount + moveCount + blockedCount + victoryCount,
    label + ': ログ全行が分類し切れている（行数の帳尻）');

  // ---- 初期配置の裏取り: order 行の行尾座標から再現する ----
  {
    const seenCells = new Set();
    for (const op of orderParsed) {
      if (!op || !op.pos) continue;
      const key = op.pos.row + ',' + op.pos.col;
      check(!seenCells.has(key), label + ': 初期配置は互いに重複しない: ' + key);
      seenCells.add(key);
      if (cfg.placement === 'split') {
        const isHuman = op.name.startsWith('玩家');
        check(isHuman ? (op.pos.col >= 1 && op.pos.col <= 4)
            : (op.pos.col >= 6 && op.pos.col <= 9),
          label + ': split 配置は自陣営の半区に収まる: ' + op.name + ' ' + key);
      }
    }
  }

  // ---- 先攻パートの再生: reroll 行を順に適用し、order 行の履歴と照合 ----
  const hist = {};
  for (const op of orderParsed) hist[op.name] = [op.history[0]];
  let rerollDice = 0;
  for (const text of rerollTexts) {
    const m = text.match(RE_REROLL);
    check(!!m, label + ': reroll 行の書式: ' + text);
    if (!m) continue;
    const group = m[1].split('、');
    const anchor = Number(m[2]);
    const pairs = m[3].split('、');
    check(group.length >= 2, label + ': 重投は 2 人以上の同点組: ' + text);
    rerollDice += group.length;
    checkEq(pairs.length, group.length, label + ': 重投記録は組全員分: ' + text);
    for (const nm of group) {
      check(Object.prototype.hasOwnProperty.call(hist, nm),
        label + ': 重投対象は order 行に現れる: ' + nm);
      if (hist[nm]) {
        checkEq(hist[nm][hist[nm].length - 1], anchor, label + ': 重投前の有効点が同点値と一致: ' + nm);
      }
    }
    for (const p of pairs) {
      const pm = p.match(RE_REROLL_PAIR);
      check(!!pm, label + ': 重投ペアの書式: ' + p);
      if (!pm) continue;
      const v = Number(pm[2]);
      check(v >= 1 && v <= 100, label + ': 重投 d100 の範囲: ' + p);
      check(group.includes(pm[1]), label + ': 重投ペアの名前は組に含まれる: ' + pm[1]);
      if (hist[pm[1]]) hist[pm[1]].push(v);
    }
  }
  for (const op of orderParsed) {
    checkEq(hist[op.name], op.history, label + ': 重投再生が order 行の履歴と一致: ' + op.name);
    checkEq(state.rolls[op.name], op.history, label + ': state.rolls が order 行の履歴と一致: ' + op.name);
  }
  checkEq(rerollDice, orderParsed.reduce((acc, op) => acc + op.history.length - 1, 0),
    label + ': 重投ダイス総数 == 履歴延長の総数');
  // 重投した者がいるなら、その初投は少なくとも 2 人で同点のはず
  const firstCount = {};
  for (const op of orderParsed) firstCount[op.history[0]] = (firstCount[op.history[0]] || 0) + 1;
  for (const op of orderParsed) {
    if (op.history.length > 1) {
      check(firstCount[op.history[0]] >= 2, label + ': 重投した者は初投で同点の相手がいる: ' + op.name);
    }
  }
  // 最終順序: order 行の並び == state.order、かつ履歴の辞書順で厳密降順（同点残存なし）
  checkEq(orderParsed.map(op => op.name), state.order, label + ': order 行の並び == state.order');
  for (let i = 1; i < orderParsed.length; i++) {
    check(cmpHistDesc(orderParsed[i - 1].history, orderParsed[i].history) < 0,
      label + ': 行動順は d100 履歴の厳密降順（'
      + orderParsed[i - 1].name + ' > ' + orderParsed[i].name + '）');
  }
  checkEq(Object.keys(state.rolls).length, n, label + ': rolls は全員分');

  // ---- 終局整合 ----
  checkEq(state.finished, true, label + ': 戦闘は正常終了');
  check(state.winner === 'human' || state.winner === 'zombie',
    label + ': 勝者は human|zombie（draw はステップ上限時のみ）: actual=' + state.winner);
  if (state.winner !== 'human' && state.winner !== 'zombie') return actionCount;
  const loser = state.winner === 'human' ? 'zombie' : 'human';
  for (const m of state.members) {
    const sm = sim[m.name];
    checkEq(m.hp, sm.hp, label + ': 最終 HP はログ再生と一致: ' + m.name);
    checkEq(m.downed, sm.downed, label + ': 倒地状態はログ再生と一致: ' + m.name);
    checkEq(m.pos, sm.pos, label + ': 最終 pos はログ再生（初期座標＋移動行）と一致: ' + m.name);
    if (m.faction === loser) {
      check(m.downed && m.hp === 0, label + ': 敗側は全員倒地: ' + m.name);
    }
  }
  check(state.members.some(m => m.faction === state.winner && !m.downed),
    label + ': 勝側に生存者がいる');
  const expSurvivors = state.members
    .filter(m => m.faction === state.winner && !m.downed)
    .map(m => ({ name: m.name, hp: m.hp, maxHp: m.maxHp }));
  checkEq(state.survivors, expSurvivors, label + ': survivors == 勝側の生存者一覧');
  for (const sv of state.survivors) {
    check(sv.hp >= 1, label + ': 生存者の HP は 1 以上: ' + sv.name);
  }
  checkEq(state.round, lastRoundNo, label + ': state.round == ログ上の最終輪数');

  // 行動数の有界性
  check(actionCount >= 1, label + ': 行動ログは 1 件以上');
  check(actionCount <= state.steps, label + ': 行動ログ数 <= steps（スキップ含む）');
  check(state.steps <= GE.MAX_STEPS, label + ': steps は上限以内');

  // victory 行の文言（勝者ラベル + 各生存者の残り HP）
  const vLine = state.log[state.log.length - 1];
  checkEq(vLine.type, 'victory', label + ': 最終ログ行は victory');
  const expectVictory = '战斗结束：' + GE.FACTION_LABEL[state.winner] + '获胜！存活角色：'
    + expSurvivors.map(m => m.name + '（HP ' + m.hp + '/' + m.maxHp + '）').join('、');
  checkEq(vLine.text, expectVictory, label + ': victory 行は勝者と生存者の残り HP を表示');
  return actionCount;
}

// ============================================================ 本体
function main() {
  const engineSrc = readFileSync(ENGINE_PATH, 'utf8');
  const uiSrc = readFileSync(UI_PATH, 'utf8');
  const html = readFileSync(INDEX_HTML_PATH, 'utf8');
  checkLogLiterals(engineSrc + uiSrc);

  GE = loadGameEngine(engineSrc, uiSrc, html);
  if (!GE) throw new Error('GameEngine を取得できなかったため、以降の検証を継続できない');

  // --- API 表面（src/engine.js 冒頭コメントの公表 API） ---
  for (const k of ['MAX_STEPS', 'DEFAULT_CONFIG', 'FACTION_LABEL', 'NAME_PREFIX',
    'createRng', 'rollD', 'randInt', 'validateConfig', 'createBattleState',
    'rollInitiative', 'takeTurn', 'runBattle']) {
    check(typeof GE[k] !== 'undefined', 'GameEngine.' + k + ' が公開されている');
  }

  // --- createRng（mulberry32）の再現性 ---
  {
    const a = GE.createRng(42), b = GE.createRng(42);
    let same = true, okRange = true;
    for (let i = 0; i < 200; i++) {
      const x = a(), y = b();
      if (x !== y) same = false;
      if (!(x >= 0 && x < 1)) okRange = false;
    }
    check(same, 'createRng(42): 同一シードは同一系列');
    check(okRange, 'createRng の出力は [0,1)');
  }
  console.log('[progress] engine loaded, failures=' + failures.length);

  // --- ダイス・スクリプトヘルパの裏付け（rollD / randInt の公表セマンティクス） ---
  checkEq(GE.rollD(7, () => 0), 1, 'rollD(7) の下端');
  checkEq(GE.rollD(7, () => rawForDie(7, 7)), 7, 'rollD(7) の上端');
  checkEq(GE.rollD(100, () => 0), 1, 'rollD(100) の下端');
  checkEq(GE.rollD(100, () => rawForDie(100, 100)), 100, 'rollD(100) の上端');
  for (const v of [1, 2, 3, 4, 5, 6, 7]) {
    checkEq(GE.rollD(7, () => rawForDie(v, 7)), v, 'rollD(7) スクリプト値 ' + v);
  }
  for (const v of [1, 50, 100]) {
    checkEq(GE.rollD(100, () => rawForDie(v, 100)), v, 'rollD(100) スクリプト値 ' + v);
  }
  checkEq(GE.randInt(2, 6, () => 0), 2, 'randInt の下端');
  checkEq(GE.randInt(2, 6, () => rawForInt(6, 2, 6)), 6, 'randInt の上端');
  for (const v of [2, 3, 4, 5, 6]) {
    checkEq(GE.randInt(2, 6, () => rawForInt(v, 2, 6)), v, 'randInt スクリプト値 ' + v);
  }
  checkEq(GE.randInt(3, 3, () => 0.5), 3, 'randInt(min==max) は常に min');

  // --- 既定値・命名・設定検査 ---
  checkEq(GE.DEFAULT_CONFIG.placement, 'mixed', 'placement の既定値は mixed');
  checkEq(GE.DEFAULT_CONFIG.human,
    { count: 1, hp: 12, attack: 4, agility: 4, dmgMin: 1, dmgMax: 3 },
    'human の既定値は仕様どおり');
  checkEq(GE.DEFAULT_CONFIG.zombie,
    { count: 1, hp: 9, attack: 5, agility: 2, dmgMin: 1, dmgMax: 5 },
    'zombie の既定値は仕様どおり');
  checkEq(GE.validateConfig(GE.DEFAULT_CONFIG), [], '既定設定は正当');
  {
    const cfgN = {
      human: { count: 3, hp: 10, attack: 3, agility: 2, dmgMin: 1, dmgMax: 2 },
      zombie: { count: 2, hp: 7, attack: 6, agility: 1, dmgMin: 2, dmgMax: 4 },
    };
    const s = GE.createBattleState(cfgN);
    checkEq(s.members.map(m => m.name), ['玩家1', '玩家2', '玩家3', '丧尸1', '丧尸2'],
      '命名は 玩家n / 丧尸n の自増');
    for (const m of s.members) {
      const c = cfgN[m.faction];
      checkEq(
        { hp: m.hp, maxHp: m.maxHp, attack: m.attack, agility: m.agility,
          dmgMin: m.dmgMin, dmgMax: m.dmgMax, downed: m.downed, faction: m.faction },
        { hp: c.hp, maxHp: c.hp, attack: c.attack, agility: c.agility,
          dmgMin: c.dmgMin, dmgMax: c.dmgMax, downed: false, faction: m.faction },
        'メンバー ' + m.name + ' は設定値を反映');
    }
    checkEq(s.members.map(m => m.pos), [null, null, null, null, null],
      '初期 state の pos は未配置の null（初期配置は開戦経路で行う）');
    checkEq(s.order, [], '初期 state の order は空');
    checkEq(s.rolls, {}, '初期 state の rolls は空');
    checkEq(s.finished, false, '初期 state の finished');
    checkEq(s.winner, null, '初期 state の winner');
  }
  {
    // 人数 0 は不可（開戦時 各陣営 1 人以上、上限は 9×9 に収まる 36）
    const bad = deepCopy(GE.DEFAULT_CONFIG);
    bad.human.count = 0;
    const errs = GE.validateConfig(bad);
    check(errs.length >= 1 && errs.join('；').includes('人数'),
      '人数 0 は検査に引っかかる: ' + JSON.stringify(errs));
    let threw = false;
    try { GE.runBattle(bad, GE.createRng(2)); } catch (e) { threw = true; }
    check(threw, '不正設定で runBattle は例外を投げる');
    const bad2 = deepCopy(GE.DEFAULT_CONFIG);
    bad2.zombie.dmgMin = 5; bad2.zombie.dmgMax = 2;
    check(GE.validateConfig(bad2).some(t => t.includes('伤害下限')),
      'dmgMin > dmgMax は検査に引っかかる');
    const bad3 = deepCopy(GE.DEFAULT_CONFIG);
    bad3.human.hp = 1.5;
    check(GE.validateConfig(bad3).some(t => t.includes('HP')),
      '非整数は検査に引っかかる');
    // 人数の上限は 36（1..36 は正当、37 はエラーで文言に 36 を含む）
    for (const v of [1, 36]) {
      const okCfg = deepCopy(GE.DEFAULT_CONFIG);
      okCfg.human.count = v; okCfg.zombie.count = v;
      checkEq(GE.validateConfig(okCfg), [], '人数 ' + v + ' は正当（1..36 の境界）');
    }
    for (const v of [-1, 37, 99]) {
      const ngCfg = deepCopy(GE.DEFAULT_CONFIG);
      ngCfg.human.count = v;
      const es = GE.validateConfig(ngCfg);
      check(es.some(t => t.includes('人数') && t.includes('36')),
        '人数 ' + v + ' は検査に引っかかり文言に 36 を含む: ' + JSON.stringify(es));
    }
    // placement: 欠落 / undefined / 'mixed' / 'split' は正当
    for (const placement of [undefined, 'mixed', 'split']) {
      const okCfg = deepCopy(GE.DEFAULT_CONFIG);
      if (placement === undefined) delete okCfg.placement;
      else okCfg.placement = placement;
      checkEq(GE.validateConfig(okCfg), [], 'placement=' + String(placement) + ' は正当');
    }
    // placement: null・空文字・非文字列・未知値は簡体中文エラー
    for (const placement of [null, '', 'sideways', 0, true, {}]) {
      const ngCfg = deepCopy(GE.DEFAULT_CONFIG);
      ngCfg.placement = placement;
      const es = GE.validateConfig(ngCfg);
      check(es.some(t => t.includes('初始站位')),
        'placement=' + String(placement) + ' は検査に引っかかる: ' + JSON.stringify(es));
    }
    {
      const ngCfg = deepCopy(GE.DEFAULT_CONFIG);
      ngCfg.placement = 'sideways';
      let threw2 = false;
      try { GE.runBattle(ngCfg, GE.createRng(3)); } catch (e) { threw2 = true; }
      check(threw2, '不正 placement で runBattle は例外を投げる');
    }
  }
  console.log('[progress] defaults/validate done, failures=' + failures.length);

  // --- 純関数性と同一シード再現性 ---
  {
    const cfg = deepCopy(GE.DEFAULT_CONFIG);
    cfg.human.count = 2; cfg.zombie.count = 2;
    const cfgSnap = JSON.stringify(cfg);
    const st0 = GE.createBattleState(cfg);
    checkEq(JSON.stringify(cfg), cfgSnap, 'createBattleState は config を破壊しない');
    // 戦闘ステップには配置済み state が必要なので、テスト側で pos を置く
    st0.members[0].pos = { row: 1, col: 1 };
    st0.members[1].pos = { row: 1, col: 2 };
    st0.members[2].pos = { row: 2, col: 1 };
    st0.members[3].pos = { row: 2, col: 2 };
    const snap0 = JSON.stringify(st0);
    const st1 = GE.rollInitiative(st0, GE.createRng(9));
    checkEq(JSON.stringify(st0), snap0, 'rollInitiative は入力 state を破壊しない');
    const snap1 = JSON.stringify(st1);
    const st2 = GE.takeTurn(st1, GE.createRng(9));
    checkEq(JSON.stringify(st1), snap1, 'takeTurn は入力 state を破壊しない');
    check(st2 !== st1, 'takeTurn は新しい state を返す');
    const a = JSON.stringify(GE.runBattle(cfg, GE.createRng(123)));
    const b = JSON.stringify(GE.runBattle(cfg, GE.createRng(123)));
    checkEq(a, b, '同一シードなら戦闘結果は完全一致');
    checkEq(JSON.stringify(cfg), cfgSnap, 'runBattle は config を破壊しない');
  }

  // =============================================== 1) 行動順（先攻決定）
  // 1a. 同点なし: d100 降順に並ぶ
  {
    const cfg = {
      human: { count: 2, hp: 12, attack: 4, agility: 4, dmgMin: 1, dmgMax: 3 },
      zombie: { count: 2, hp: 9, attack: 5, agility: 2, dmgMin: 1, dmgMax: 5 },
    };
    let s = GE.createBattleState(cfg);
    checkEq(s.members.map(m => m.name), ['玩家1', '玩家2', '丧尸1', '丧尸2'],
      'members は human 側から順に生成');
    const rs = new RngScript();
    // メンバー生成順に d100: 玩家1=30, 玩家2=90, 丧尸1=50, 丧尸2=70
    rs.pushDie(30, 100); rs.pushDie(90, 100); rs.pushDie(50, 100); rs.pushDie(70, 100);
    s = GE.rollInitiative(s, rs.rng);
    checkEq(rs.used, 4, '同点がなければ d100 は各 1 回ずつ');
    checkEq(s.rolls['玩家1'], [30], 'rolls 履歴 玩家1');
    checkEq(s.rolls['玩家2'], [90], 'rolls 履歴 玩家2');
    checkEq(s.rolls['丧尸1'], [50], 'rolls 履歴 丧尸1');
    checkEq(s.rolls['丧尸2'], [70], 'rolls 履歴 丧尸2');
    checkEq(s.order, ['玩家2', '丧尸2', '丧尸1', '玩家1'], 'order は d100 降順');
    const orderLines = s.log.filter(e => e.type === 'order');
    checkEq(orderLines.length, 4, 'order 行は人数分');
    check(orderLines[0].text.includes('玩家2（d100=90）'),
      'order 行に d100 点数を含む: ' + orderLines[0].text);
    checkEq(s.log.filter(e => e.type === 'reroll').length, 0, '同点なしなら重投ログなし');
    checkEq(s.round, 1, 'rollInitiative 後 round==1');
    checkEq(s.turnIndex, 0, 'rollInitiative 後 turnIndex==0');
  }

  // 1b. 同点が絡む場合: 重投は同点組だけ、決着まで繰り返される
  //     （README 三.3 の公表セマンティクス: 重投点は組内だけで比較し、
  //      組と組外の前后は初投点で確定済み）
  {
    const cfg = {
      human: { count: 2, hp: 12, attack: 4, agility: 4, dmgMin: 1, dmgMax: 3 },
      zombie: { count: 1, hp: 9, attack: 5, agility: 2, dmgMin: 1, dmgMax: 5 },
    };
    let s = GE.createBattleState(cfg);
    const rs = new RngScript();
    // 初投: 玩家1=80, 玩家2=80, 丧尸1=85 → 玩家 2 人が同点
    rs.pushDie(80, 100); rs.pushDie(80, 100); rs.pushDie(85, 100);
    // 重投 1: 玩家1=10, 玩家2=10（まだ同点 → さらに重投）
    rs.pushDie(10, 100); rs.pushDie(10, 100);
    // 重投 2: 玩家1=5, 玩家2=95（これで組内決着）
    rs.pushDie(5, 100); rs.pushDie(95, 100);
    s = GE.rollInitiative(s, rs.rng);
    checkEq(rs.used, 7, '重投は同点組だけ・決着まで（合計 7 ダイス）');
    checkEq(s.rolls['玩家1'], [80, 10, 5], '玩家1 の d100 履歴');
    checkEq(s.rolls['玩家2'], [80, 10, 95], '玩家2 の d100 履歴');
    checkEq(s.rolls['丧尸1'], [85], '同点でない丧尸1 は重投しない');
    // 組内 95>5、組と外の関係は初投 85>80 を維持
    checkEq(s.order, ['丧尸1', '玩家2', '玩家1'],
      '組内は重投点で、組の位置は初投点で確定');
    const rr = s.log.filter(e => e.type === 'reroll');
    checkEq(rr.length, 2, '重投ログは 2 バッチ（同点が続いたぶん繰り返す）');
    check(rr.length > 0 && rr[0].text.includes('玩家1') && rr[0].text.includes('玩家2')
      && rr[0].text.includes('同为 80 点'),
      '重投ログ 1 に組員と同点値: ' + (rr[0] ? rr[0].text : ''));
    check(rr.length > 1 && rr[1].text.includes('玩家1') && rr[1].text.includes('玩家2'),
      '重投ログ 2 に組員: ' + (rr[1] ? rr[1].text : ''));
    check(rr.every(e => !e.text.includes('丧尸1')),
      '同点でない者は重投ログに現れない');
  }

  // 1c. 単発の同点: 1 回の重投で決着
  {
    const cfg = {
      human: { count: 2, hp: 12, attack: 4, agility: 4, dmgMin: 1, dmgMax: 3 },
      zombie: { count: 1, hp: 9, attack: 5, agility: 2, dmgMin: 1, dmgMax: 5 },
    };
    let s = GE.createBattleState(cfg);
    const rs = new RngScript();
    rs.pushDie(50, 100); rs.pushDie(50, 100); rs.pushDie(55, 100); // 初投（玩家 2 人同点）
    rs.pushDie(60, 100); rs.pushDie(20, 100);                      // 重投 1 回で決着
    s = GE.rollInitiative(s, rs.rng);
    checkEq(rs.used, 5, '1 回の重投で決着（合計 5 ダイス）');
    checkEq(s.rolls['玩家1'], [50, 60], '玩家1 の履歴');
    checkEq(s.rolls['玩家2'], [50, 20], '玩家2 の履歴');
    checkEq(s.rolls['丧尸1'], [55], '丧尸1 は重投しない');
    checkEq(s.order, ['丧尸1', '玩家1', '玩家2'],
      '組内は重投点 60>20、組の位置は初投 55 を維持');
    checkEq(s.log.filter(e => e.type === 'reroll').length, 1, '重投ログは 1 バッチ');
    for (let i = 1; i < s.order.length; i++) {
      check(cmpHistDesc(s.rolls[s.order[i - 1]], s.rolls[s.order[i]]) < 0,
        '1c: 行動順は履歴の厳密降順');
    }
  }
  console.log('[progress] initiative done, failures=' + failures.length);

  // =============================================== 2) 攻撃検定の境界
  // d7 == 攻撃値 → 攻撃は続行（失敗にならず、回避・伤害まで進む）
  {
    const { state } = makeState({
      first: 'zombie', human: { agility: 0 }, zombie: { dmgMin: 2, dmgMax: 2 },
    });
    const rs = new RngScript();
    rs.pushInt(0, 0, 0);   // 目標選択（候補 1 体）
    rs.pushDie(5, 7);      // 攻撃 d7 = 5 == attack 5 → 失敗ではない
    rs.pushDie(1, 7);      // 回避 d7 = 1 > 敏捷 0 → 未回避
    rs.pushInt(2, 2, 2);   // 伤害 2
    const lenBefore = state.log.length;
    const s2 = GE.takeTurn(state, rs.rng);
    checkEq(rs.used, 4, 'd7==攻撃 のときは回避・伤害まで進む（乱数 4 回）');
    const acts = actionEntriesBetween(s2, lenBefore);
    checkEq(acts.length, 1, '1 takeTurn == 1 行動ログ');
    checkEq(acts[0].type, 'action-hit', 'd7==攻撃 → 攻撃続行');
    check(acts[0].text.includes('攻击检定 d7=5 ≤ 攻击5'),
      'd7==攻撃 は失敗でない: ' + acts[0].text);
    check(!acts[0].text.includes('攻击失败'), '攻撃失敗の文言がない');
    check(acts[0].text.includes('伤害 2') && acts[0].text.includes('玩家1 剩余 HP 10'),
      '伤害と目標残り HP の記録: ' + acts[0].text);
    checkEq(s2.members.find(m => m.name === '玩家1').hp, 10, '玩家1 は 12→10');
  }
  // d7 == 攻撃値+1 → 攻撃失敗・行動終了（以降のダイスを消費しない）
  {
    const { state } = makeState({
      first: 'zombie', human: { agility: 0 }, zombie: { dmgMin: 2, dmgMax: 2 },
    });
    const rs = new RngScript();
    rs.pushInt(0, 0, 0);
    rs.pushDie(6, 7);      // d7 = 6 > attack 5 → 失敗
    const lenBefore = state.log.length;
    const s2 = GE.takeTurn(state, rs.rng);
    checkEq(rs.used, 2, '攻撃失敗なら行動終了（乱数は 2 回で止まる）');
    const acts = actionEntriesBetween(s2, lenBefore);
    checkEq(acts.length, 1, '1 takeTurn == 1 行動ログ');
    checkEq(acts[0].type, 'action-fail', 'd7==攻撃+1 → 攻撃失敗');
    check(acts[0].text.includes('攻击检定 d7=6 ＞ 攻击5，攻击失败'),
      '失敗ログの文言: ' + acts[0].text);
    checkEq(s2.members.find(m => m.name === '玩家1').hp, 12, '失敗なら HP 減なし');
  }
  // 境界の外側: attack 0 は d7=1 でも必ず失敗 / attack 7 は d7=7 でも失敗しない
  {
    const { state } = makeState({ first: 'human', human: { attack: 0 }, zombie: { agility: 0 } });
    const rs = new RngScript(); rs.pushInt(0, 0, 0); rs.pushDie(1, 7);
    const lenBefore = state.log.length;
    const s2 = GE.takeTurn(state, rs.rng);
    checkEq(rs.used, 2, 'attack 0 は d7=1 でも失敗で終わる');
    const acts = actionEntriesBetween(s2, lenBefore);
    checkEq(acts.length, 1, '1 takeTurn == 1 行動ログ');
    checkEq(acts[0].type, 'action-fail', 'attack 0 → 必ず攻撃失敗');
  }
  {
    const { state } = makeState({
      first: 'zombie', zombie: { attack: 7 }, human: { agility: 0 },
    });
    const rs = new RngScript();
    rs.pushInt(0, 0, 0); rs.pushDie(7, 7); rs.pushDie(1, 7); rs.pushInt(1, 1, 3);
    const lenBefore = state.log.length;
    const s2 = GE.takeTurn(state, rs.rng);
    checkEq(rs.used, 4, 'attack 7 は d7=7 でも命中側へ進む');
    const acts = actionEntriesBetween(s2, lenBefore);
    checkEq(acts[0].type, 'action-hit', 'attack 7 → d7=7 は失敗でない');
  }
  console.log('[progress] attack boundary done, failures=' + failures.length);

  // =============================================== 3) 回避検定の境界
  // d7 == 敏捷 → 回避成功（伤害なし・行動終了）
  {
    const { state } = makeState({
      first: 'zombie', human: { agility: 4 },
      zombie: { attack: 7, dmgMin: 1, dmgMax: 1 },
    });
    const rs = new RngScript();
    rs.pushInt(0, 0, 0); rs.pushDie(1, 7); rs.pushDie(4, 7);
    const lenBefore = state.log.length;
    const s2 = GE.takeTurn(state, rs.rng);
    checkEq(rs.used, 3, '回避成功なら行動終了（乱数 3 回）');
    const acts = actionEntriesBetween(s2, lenBefore);
    checkEq(acts.length, 1, '1 takeTurn == 1 行動ログ');
    checkEq(acts[0].type, 'action-dodge', 'd7==敏捷 → 回避成功');
    check(acts[0].text.includes('闪避检定 d7=4 ≤ 敏捷4，闪避成功'),
      '回避ログの文言: ' + acts[0].text);
    checkEq(s2.members.find(m => m.name === '玩家1').hp, 12, '回避なら HP 減なし');
  }
  // d7 == 敏捷+1 → 未回避で伤害を受ける
  {
    const { state } = makeState({
      first: 'zombie', human: { agility: 4 },
      zombie: { attack: 7, dmgMin: 1, dmgMax: 1 },
    });
    const rs = new RngScript();
    rs.pushInt(0, 0, 0); rs.pushDie(1, 7); rs.pushDie(5, 7); rs.pushInt(1, 1, 1);
    const lenBefore = state.log.length;
    const s2 = GE.takeTurn(state, rs.rng);
    checkEq(rs.used, 4, '未回避なら伤害まで進む（乱数 4 回）');
    const acts = actionEntriesBetween(s2, lenBefore);
    checkEq(acts[0].type, 'action-hit', 'd7==敏捷+1 → 未回避で伤害');
    check(acts[0].text.includes('闪避检定 d7=5 ＞ 敏捷4，未闪避'),
      '未回避ログの文言: ' + acts[0].text);
    checkEq(s2.members.find(m => m.name === '玩家1').hp, 11, '玩家1 は 12→11');
  }
  // 敏捷 0 は d7=1 でも回避できない / 敏捷 7 は d7=7 でも必ず回避
  {
    const { state } = makeState({
      first: 'zombie', human: { agility: 0 },
      zombie: { attack: 7, dmgMin: 1, dmgMax: 1 },
    });
    const rs = new RngScript();
    rs.pushInt(0, 0, 0); rs.pushDie(1, 7); rs.pushDie(1, 7); rs.pushInt(1, 1, 1);
    const lenBefore = state.log.length;
    const s2 = GE.takeTurn(state, rs.rng);
    const acts = actionEntriesBetween(s2, lenBefore);
    checkEq(acts[0].type, 'action-hit', '敏捷 0 は d7=1 でも回避できない');
    check(acts[0].text.includes('闪避检定 d7=1 ＞ 敏捷0'), '敏捷 0 の文言: ' + acts[0].text);
  }
  {
    const { state } = makeState({
      first: 'zombie', human: { agility: 7 }, zombie: { attack: 7 },
    });
    const rs = new RngScript();
    rs.pushInt(0, 0, 0); rs.pushDie(1, 7); rs.pushDie(7, 7);
    const lenBefore = state.log.length;
    const s2 = GE.takeTurn(state, rs.rng);
    checkEq(rs.used, 3, '敏捷 7 は d7=7 でも回避成功で終わる');
    const acts = actionEntriesBetween(s2, lenBefore);
    checkEq(acts[0].type, 'action-dodge', '敏捷 7 → 必ず回避成功');
    check(acts[0].text.includes('闪避检定 d7=7 ≤ 敏捷7'), '敏捷 7 の文言: ' + acts[0].text);
  }
  console.log('[progress] dodge boundary done, failures=' + failures.length);

  // =============================================== 4) 伤害は行動者の区間内
  {
    // 攻撃 7（必中）× 敏捷 0（必ず未回避）の 1v1 で全行動が命中。
    // HP 9999 なので 1500 行動では誰も倒れない。
    const cfg = {
      human: { count: 1, hp: 9999, attack: 7, agility: 0, dmgMin: 1, dmgMax: 3 },
      zombie: { count: 1, hp: 9999, attack: 7, agility: 0, dmgMin: 2, dmgMax: 6 },
    };
    const rng = GE.createRng(424242);
    // 隣接配置（(1,1) と (1,2)）に手で置き、1500 行動すべてを攻撃にする。
    // （未配置 state は戦闘ステップに入れないため、テスト側で pos を設定する）
    let s = GE.createBattleState(cfg);
    s.members[0].pos = { row: 1, col: 1 };
    s.members[1].pos = { row: 1, col: 2 };
    s = GE.rollInitiative(s, rng);
    const factionOf = {};
    for (const m of s.members) factionOf[m.name] = m.faction;
    const seen = { human: new Set(), zombie: new Set() };
    let guard = 0;
    while (!s.finished && guard < 1500) {
      guard++;
      const actorName = s.order[s.turnIndex];
      const actorFaction = factionOf[actorName];
      const targetFaction = actorFaction === 'human' ? 'zombie' : 'human';
      const targetBefore = s.members.find(m => m.faction === targetFaction).hp;
      const lenBefore = s.log.length;
      s = GE.takeTurn(s, rng);
      let hitFound = false;
      for (let i = lenBefore; i < s.log.length; i++) {
        if (s.log[i].type === 'action-hit') hitFound = true;
      }
      if (hitFound) {
        const targetAfter = s.members.find(m => m.faction === targetFaction).hp;
        const dmg = targetBefore - targetAfter;
        const range = actorFaction === 'human' ? [1, 3] : [2, 6];
        check(dmg >= range[0] && dmg <= range[1],
          '伤害は行動者区間内: dmg=' + dmg + ' (' + actorFaction + ')');
        seen[actorFaction].add(dmg);
      } else {
        check(false, '攻撃7/敏捷0 の 1v1 では全行動が命中するはず');
      }
    }
    checkEq(guard, 1500, '大標本 1500 行動を実行');
    checkEq(s.finished, false, 'サンプリング中に戦闘が終わらない HP 余裕');
    check(seen.human.has(1) && seen.human.has(3),
      'human 伤害区間 [1,3] の両端が出た: ' + [...seen.human].join(','));
    check(seen.zombie.has(2) && seen.zombie.has(6),
      'zombie 伤害区間 [2,6] の両端が出た: ' + [...seen.zombie].join(','));
  }
  console.log('[progress] damage range done, failures=' + failures.length);

  // =============================================== 5) 倒地とスキップ
  {
    // 玩家は攻撃 0（絶対命中しない）・HP 2。丧尸は攻撃 7・固定伤害 3。
    // 順序を 玩家1(90) → 玩家2(80) → 丧尸1(10) に固定。
    const { state: s0 } = makeState({
      humanRolls: [90, 80], zombieRolls: [10],
      human: { count: 2, hp: 2, attack: 0, agility: 0, dmgMin: 1, dmgMax: 1 },
      zombie: { count: 1, hp: 100, attack: 7, agility: 9, dmgMin: 3, dmgMax: 3 },
    });
    const order0 = JSON.stringify(s0.order);
    checkEq(s0.order, ['玩家1', '玩家2', '丧尸1'], '順序固定');
    let s = s0;
    // t1: 玩家1 → 丧尸1 に攻撃するが attack 0 で失敗
    let rs = new RngScript(); rs.pushInt(0, 0, 0); rs.pushDie(1, 7);
    let lenBefore = s.log.length;
    s = GE.takeTurn(s, rs.rng);
    checkEq(rs.used, 2, 't1 玩家1 の攻撃失敗（乱数 2 回）');
    checkEq(s.turnIndex, 1, 't1 後 turnIndex');
    checkEq(s.members.find(m => m.name === '丧尸1').hp, 100, 't1 で HP 変化なし');
    // t2: 玩家2 も失敗
    rs = new RngScript(); rs.pushInt(0, 0, 0); rs.pushDie(1, 7);
    s = GE.takeTurn(s, rs.rng);
    checkEq(s.turnIndex, 2, 't2 後 turnIndex');
    // t3: 丧尸1 が 玩家1 を選んで命中・固定伤害 3 → HP2 から 0（超過丸め）→ 倒地
    rs = new RngScript();
    rs.pushInt(0, 0, 1);   // 目標候補 2 体のうち 0 番（玩家1）
    rs.pushDie(7, 7);      // 攻撃命中
    rs.pushDie(1, 7);      // 玩家1 敏捷 0 → 未回避
    rs.pushInt(3, 3, 3);   // 伤害 3
    lenBefore = s.log.length;
    s = GE.takeTurn(s, rs.rng);
    checkEq(rs.used, 4, 't3 命中経路の乱数 4 回');
    const p1 = s.members.find(m => m.name === '玩家1');
    checkEq(p1.hp, 0, '超過伤害でも HP は 0 に丸められる（負にならない）');
    checkEq(p1.downed, true, 'hp<=0 で倒地');
    const t3Acts = actionEntriesBetween(s, lenBefore);
    checkEq(t3Acts.length, 1, 't3 は 1 行動ログ');
    check(t3Acts[0].text.includes('玩家1 剩余 HP 0，倒地！'),
      '倒地ログ: ' + t3Acts[0].text);
    checkEq(s.finished, false, '玩家2 が生存 → 戦闘は終了しない');
    checkEq(s.turnIndex, 0, 't3 後は順序の先頭へ戻る');
    check(s.log.slice(lenBefore).some(e => e.type === 'round' && e.text.includes('第 2 轮')),
      'ラウンド送りログがある');
    // t4: 番が来た 玩家1 は倒地 → 何もせずスキップ（ログ増えず・乱数消費 0）
    rs = new RngScript();
    const logLen = s.log.length;
    const stepsBefore = s.steps;
    const idxBefore = s.turnIndex;
    s = GE.takeTurn(s, rs.rng);
    checkEq(rs.used, 0, '倒地者の番は乱数を消費しない');
    checkEq(s.log.length, logLen, '倒地者のスキップはログに残らない');
    checkEq(s.steps, stepsBefore + 1, 'steps カウンタは進む');
    checkEq(s.turnIndex, idxBefore + 1, 'turnIndex だけ進む');
    checkEq(JSON.stringify(s.order), order0, 'order は戦闘中不変');
    // t5: 玩家2 も失敗
    rs = new RngScript(); rs.pushInt(0, 0, 0); rs.pushDie(1, 7);
    s = GE.takeTurn(s, rs.rng);
    // t6: 丧尸1 の目標候補は 玩家2 だけ（倒地した 玩家1 は選ばれない）→ 玩家2 倒地 → 丧尸勝利
    rs = new RngScript();
    rs.pushInt(0, 0, 0); rs.pushDie(7, 7); rs.pushDie(1, 7); rs.pushInt(3, 3, 3);
    s = GE.takeTurn(s, rs.rng);
    const p2 = s.members.find(m => m.name === '玩家2');
    checkEq(p2.downed, true, 't6 で 玩家2 倒地');
    checkEq(s.finished, true, 'human 全滅 → 戦闘終了');
    checkEq(s.winner, 'zombie', '勝者は zombie');
    checkEq(s.survivors, [{ name: '丧尸1', hp: 100, maxHp: 100 }], '勝者生存者の表示');
    checkEq(s.turnIndex, 2, '決着ターンでは turnIndex を進めない');
    const hitTexts = s.log.filter(e => e.type === 'action-hit').map(e => e.text);
    checkEq(hitTexts.length, 2, '命中ログは 2 件');
    check(hitTexts[1].includes('丧尸1 → 玩家2：'),
      '倒地した 玩家1 は再度目標に選ばれない: ' + hitTexts[1]);
  }
  console.log('[progress] downed/skip done, failures=' + failures.length);

  // =============================================== 6) 終局と勝者表示
  {
    const cfg = {
      human: { count: 3, hp: 10, attack: 4, agility: 3, dmgMin: 1, dmgMax: 3 },
      zombie: { count: 2, hp: 8, attack: 5, agility: 2, dmgMin: 1, dmgMax: 5 },
    };
    const fin = GE.runBattle(cfg, GE.createRng(7));
    checkEq(fin.finished, true, 'runBattle は必ず終局する');
    check(fin.winner === 'human' || fin.winner === 'zombie', '勝者: ' + fin.winner);
    const loser = fin.winner === 'human' ? 'zombie' : 'human';
    checkEq(fin.members.filter(m => m.faction === loser).every(m => m.downed && m.hp === 0),
      true, '敗側は全員倒地（HP 0）');
    checkEq(fin.members.some(m => m.faction === fin.winner && !m.downed),
      true, '勝側に生存者がいる');
    const expSurv = fin.members
      .filter(m => m.faction === fin.winner && !m.downed)
      .map(m => ({ name: m.name, hp: m.hp, maxHp: m.maxHp }));
    checkEq(fin.survivors, expSurv, 'survivors は終局 state の生存者と一致');
    for (const sv of fin.survivors) check(sv.hp >= 1, '生存者 HP >= 1: ' + sv.name);
    const v = fin.log[fin.log.length - 1];
    checkEq(v.type, 'victory', '最終ログ行は victory');
    const expectText = '战斗结束：' + GE.FACTION_LABEL[fin.winner] + '获胜！存活角色：'
      + expSurv.map(m => m.name + '（HP ' + m.hp + '/' + m.maxHp + '）').join('、');
    checkEq(v.text, expectText, 'victory 行は勝者ラベルと各生存者の残り HP を表示');
  }
  // 行動ステップ上限の安全弁: 誰も命中できない設定で draw に落ちる
  {
    const saved = GE.MAX_STEPS;
    try {
      GE.MAX_STEPS = 5;
      const cfg = {
        human: { count: 1, hp: 9, attack: 0, agility: 0, dmgMin: 1, dmgMax: 1 },
        zombie: { count: 1, hp: 9, attack: 0, agility: 0, dmgMin: 1, dmgMax: 1 },
      };
      const fin = GE.runBattle(cfg, GE.createRng(1));
      checkEq(fin.finished, true, 'ステップ上限で強制終了');
      checkEq(fin.winner, 'draw', '上限到達は draw');
      checkEq(fin.survivors, [], 'draw のとき survivors は空');
      check(fin.steps > 5, 'steps が上限を超えた: ' + fin.steps);
      check(fin.log.some(e => e.type === 'victory' && e.text.includes('平局')),
        'draw の文言がある');
      checkEq(fin.members.every(m => !m.downed && m.hp === m.maxHp), true,
        'draw 戦では誰も倒れていない');
    } finally {
      GE.MAX_STEPS = saved;
    }
    checkEq(GE.MAX_STEPS, saved, 'MAX_STEPS を復元');
  }
  console.log('[progress] battle end done, failures=' + failures.length);

  // =============================================== 7) ストレス試験 223 戦
  const stressCases = [];
  // 1v1 既定設定 × 60 シード
  for (let i = 0; i < 60; i++) {
    stressCases.push({ label: '1v1-default#' + i, seed: 1000 + i, cfg: deepCopy(GE.DEFAULT_CONFIG) });
  }
  // 非対称・変則スタット × 160 シード（人数 1..4 ずつ、攻撃 2..6 で必ず終局する）
  for (let i = 0; i < 160; i++) {
    const h = {
      count: 1 + (i % 4),
      hp: 8 + (i % 6) * 2,
      attack: 2 + (i % 5),
      agility: i % 6,
      dmgMin: 1,
      dmgMax: 2 + (i % 4),
    };
    const z = {
      count: 1 + ((i * 3 + 1) % 4),
      hp: 6 + ((i * 2) % 5) * 2,
      attack: 2 + ((i + 3) % 5),
      agility: (i * 2 + 1) % 6,
      dmgMin: 1 + (i % 2),
      dmgMax: 0,
    };
    z.dmgMax = z.dmgMin + (i % 3);
    stressCases.push({ label: 'mixed#' + i, seed: 2000 + i, cfg: { human: h, zombie: z } });
  }
  // 大人数の非対称 3 戦
  const extraCfgs = [
    {
      human: { count: 5, hp: 10, attack: 3, agility: 2, dmgMin: 1, dmgMax: 3 },
      zombie: { count: 3, hp: 9, attack: 5, agility: 2, dmgMin: 1, dmgMax: 5 },
    },
    {
      human: { count: 3, hp: 12, attack: 4, agility: 4, dmgMin: 1, dmgMax: 3 },
      zombie: { count: 5, hp: 9, attack: 3, agility: 3, dmgMin: 1, dmgMax: 4 },
    },
    {
      human: { count: 5, hp: 12, attack: 4, agility: 4, dmgMin: 1, dmgMax: 3 },
      zombie: { count: 5, hp: 9, attack: 5, agility: 2, dmgMin: 1, dmgMax: 5 },
    },
  ];
  extraCfgs.forEach((cfg, i) => {
    stressCases.push({ label: 'extra#' + i, seed: 3000 + i, cfg });
  });

  let stressActionsTotal = 0;
  for (let i = 0; i < stressCases.length; i++) {
    const c = stressCases[i];
    const cfgSnap = JSON.stringify(c.cfg);
    checkEq(GE.validateConfig(c.cfg), [], c.label + ': 設定は正当');
    const fin = GE.runBattle(c.cfg, GE.createRng(c.seed));
    checkEq(JSON.stringify(c.cfg), cfgSnap, c.label + ': runBattle は config を破壊しない');
    stressActionsTotal += verifyStateAndLog(fin, c.cfg, c.label);
    if (i % 25 === 0) {
      // 再現性のスポット確認（同一シード → 完全一致）
      const again = JSON.stringify(GE.runBattle(c.cfg, GE.createRng(c.seed)));
      checkEq(again, JSON.stringify(fin), c.label + ': 同一シード再実行で完全一致');
    }
  }
  check(stressCases.length >= 200, 'ストレス戦は 200 戦以上: ' + stressCases.length);
  check(stressActionsTotal >= stressCases.length, '全戦で行動ログが存在');
  console.log('[progress] stress done: battles=' + stressCases.length
    + ' actions=' + stressActionsTotal + ' failures=' + failures.length);

  // =============================================== 8) ステップ実行 API（可視化改版・ADR 0001）
  // runBattle（整場一括）と startBattle+stepBattle（逐次）が同一経路である
  // ことを、終局 state（members / order / rolls / log すべて）の JSON 一致で
  // 固定する。event は観測データとして state 遷移・ログ追記と毎歩照合する。

  // 8a. API 表面
  for (const k of ['startBattle', 'stepBattle', 'getInitiativeOrder', 'isBattleOver', 'getResult']) {
    check(typeof GE[k] === 'function', 'GameEngine.' + k + ' が関数として公開されている');
  }

  // 8b. startBattle の経路と補助 API の意味論
  {
    const cfg = deepCopy(GE.DEFAULT_CONFIG);
    const snap = JSON.stringify(cfg);
    const st = GE.startBattle(cfg, GE.createRng(11));
    checkEq(JSON.stringify(cfg), snap, 'startBattle は config を破壊しない');
    // 開戦経路（検査 → state 生成 → 初期配置 → 先攻 d100）は同一シードで完全再現。
    // （初期配置が経路に加わったため、旧来の rollInitiative(createBattleState)
    //   との直接比較は「配置なしの部分 state」との比較になり意義を失った。
    //   経路全体の等価性は 8e の整場≡逐次の完全一致が引き続き执法する）
    checkEq(JSON.stringify(GE.startBattle(deepCopy(cfg), GE.createRng(11))),
      JSON.stringify(st),
      'startBattle は同一シードで完全再現（配置→先攻の固定経路を含む）');
    // 初期配置済み: 全員の pos が界内かつ互いに重複しない
    const seen = new Set();
    for (const m of st.members) {
      check(inBounds9(m.pos), '8b: startBattle 直後に pos は界内: ' + m.name);
      const key = m.pos.row + ',' + m.pos.col;
      check(!seen.has(key), '8b: startBattle 直後の pos は重複しない: ' + key);
      seen.add(key);
    }
    checkEq(st.finished, false, 'startBattle 直後は未終局');
    checkEq(GE.isBattleOver(st), false, 'isBattleOver は未終局で false');
    checkEq(st.round, 1, 'startBattle 直後の round');
    checkEq(st.turnIndex, 0, 'startBattle 直後の turnIndex');
    checkEq(Object.keys(st.rolls).length, st.members.length, 'startBattle 直後の rolls は全員分');
    // getInitiativeOrder はコピー（外で壊しても state に影響しない）
    const ord = GE.getInitiativeOrder(st);
    checkEq(ord, st.order, 'getInitiativeOrder は行動順と同じ内容');
    ord.push('ダミー');
    checkEq(st.order.length, st.members.length, 'getInitiativeOrder の戻り値を壊しても state は無傷');
    // getResult は新しいプレーンオブジェクト
    const r1 = GE.getResult(st);
    checkEq(r1, { finished: false, winner: null, survivors: [] }, '未終局の getResult');
    const r2 = GE.getResult(st);
    check(r1 !== r2, 'getResult は毎回新しいオブジェクトを返す');
    checkEq(r2, r1, 'getResult の内容は安定');
    // 不正設定は例外（runBattle と同じ検査を通る）
    const badCfg = deepCopy(GE.DEFAULT_CONFIG);
    badCfg.zombie.count = 0;
    let threw = false;
    try { GE.startBattle(badCfg, GE.createRng(1)); } catch (e) { threw = true; }
    check(threw, '不正設定で startBattle は例外を投げる');
  }

  // 8c. スクリプト済み乱数によるステップ境界: 倒地スキップの event と終局後の安全再ステップ
  {
    // 順序を 玩家1(90) → 玩家2(80) → 丧尸1(10) に固定。玩家は攻撃 0・HP 2、
    // 丧尸は攻撃 7・固定伤害 3（既存 5) 節と同じ局面をステップ経路で再現する）
    const cfg = {
      human: { count: 2, hp: 2, attack: 0, agility: 0, dmgMin: 1, dmgMax: 1 },
      zombie: { count: 1, hp: 100, attack: 7, agility: 9, dmgMin: 3, dmgMax: 3 },
    };
    const rs0 = new RngScript();
    // 初期配置（3 人 × 1 抽選）を先に固定: 玩家1=(1,2) 玩家2=(2,3) 丧尸1=(2,2)。
    // 全員が 丧尸1 と 4 隣接し、以降の攻撃境界スクリプトがそのまま成立する
    const draws8c = placementDraws(defaultPos(2, 1));
    for (const d of draws8c) rs0.pushInt(d.v, 0, d.k - 1);
    rs0.pushDie(90, 100); rs0.pushDie(80, 100); rs0.pushDie(10, 100);
    let s = GE.startBattle(cfg, rs0.rng);
    checkEq(rs0.used, 6, '8c: startBattle は初期配置 3 回＋先攻 d100 3 回だけ消費');
    checkEq(s.members.find(m => m.name === '玩家1').pos, { row: 1, col: 2 }, '8c: 玩家1 の初期配置');
    checkEq(s.members.find(m => m.name === '玩家2').pos, { row: 2, col: 3 }, '8c: 玩家2 の初期配置');
    checkEq(s.members.find(m => m.name === '丧尸1').pos, { row: 2, col: 2 }, '8c: 丧尸1 の初期配置');
    checkEq(s.order, ['玩家1', '玩家2', '丧尸1'], '8c: 順序固定');

    // step1: 玩家1 の攻撃失敗
    let snap = JSON.stringify(s);
    let rs = new RngScript();
    rs.pushInt(0, 0, 0);   // 目標は 候補 1 体の 丧尸1
    rs.pushDie(1, 7);      // d7=1 > attack 0 → 失敗
    let lenBefore = s.log.length;
    let res = GE.stepBattle(s, rs.rng);
    checkEq(rs.used, 2, '8c step1: 乱数 2 回（目標選択+攻撃）');
    checkEq(JSON.stringify(s), snap, '8c step1: 入力 state は無傷');
    check(res.state !== s, '8c step1: 新しい state を返す');
    checkEq(res.event.kind, 'fail', '8c step1: event は fail');
    checkEq(res.event.actor, '玩家1', '8c step1: actor');
    checkEq(res.event.target, '丧尸1', '8c step1: target');
    checkEq(res.event.atkRoll, 1, '8c step1: atkRoll');
    checkEq(res.event.attack, 0, '8c step1: attack');
    checkEq(res.event.finished, undefined, '8c step1: 非終局なので finished は付かない');
    checkEq(res.state.log.length, lenBefore + 1, '8c step1: ログ 1 行追記');
    s = res.state;

    // step2: 玩家2 も失敗
    rs = new RngScript(); rs.pushInt(0, 0, 0); rs.pushDie(1, 7);
    res = GE.stepBattle(s, rs.rng);
    checkEq(res.event.kind, 'fail', '8c step2: fail');
    checkEq(res.state.turnIndex, 2, '8c step2: turnIndex');
    s = res.state;

    // step3: 丧尸1 が 玩家1 に命中・固定伤害 3 → 倒地（戦闘は続行）
    snap = JSON.stringify(s);
    rs = new RngScript();
    rs.pushInt(0, 0, 1);   // 目標候補 2 体のうち 0 番（玩家1）
    rs.pushDie(7, 7);      // 攻撃命中
    rs.pushDie(1, 7);      // 玩家1 敏捷 0 → 未回避
    rs.pushInt(3, 3, 3);   // 伤害 3
    lenBefore = s.log.length;
    res = GE.stepBattle(s, rs.rng);
    checkEq(rs.used, 4, '8c step3: 命中経路の乱数 4 回');
    checkEq(JSON.stringify(s), snap, '8c step3: 入力 state は無傷');
    checkEq(res.event.kind, 'hit', '8c step3: event は hit');
    checkEq(res.event.actor, '丧尸1', '8c step3: actor');
    checkEq(res.event.target, '玩家1', '8c step3: target');
    checkEq(res.event.damage, 3, '8c step3: damage');
    checkEq(res.event.hpBefore, 2, '8c step3: hpBefore');
    checkEq(res.event.hpAfter, 0, '8c step3: hpAfter');
    checkEq(res.event.downed, true, '8c step3: downed');
    checkEq(res.event.finished, undefined, '8c step3: 玩家2 が生存なので非終局');
    checkEq(res.state.log.length, lenBefore + 2, '8c step3: hit 行 + 折り返し round 行');
    check(res.state.log[res.state.log.length - 1].type === 'round'
      && res.state.log[res.state.log.length - 1].text.includes('第 2 轮'),
      '8c step3: 折り返しで第 2 轮の行');
    checkEq(res.state.round, 2, '8c step3: round は 2 へ');
    s = res.state;

    // step4: 倒地した 玩家1 の番 → event skip、乱数 0、ログ無追記
    snap = JSON.stringify(s);
    rs = new RngScript(); // 1 回でも乱数を使ったら例外で落ちる
    lenBefore = s.log.length;
    res = GE.stepBattle(s, rs.rng);
    checkEq(rs.used, 0, '8c step4: 倒地者のスキップは乱数を消費しない');
    checkEq(JSON.stringify(s), snap, '8c step4: 入力 state は無傷');
    checkEq(res.event.kind, 'skip', '8c step4: event は skip');
    checkEq(res.event.actor, '玩家1', '8c step4: actor は倒地者');
    checkEq(res.state.log.length, lenBefore, '8c step4: ログ無追記');
    checkEq(res.state.turnIndex, 1, '8c step4: turnIndex だけ進む');
    checkEq(res.state.steps, s.steps + 1, '8c step4: steps は進む');
    s = res.state;

    // step5: 玩家2 失敗
    rs = new RngScript(); rs.pushInt(0, 0, 0); rs.pushDie(1, 7);
    res = GE.stepBattle(s, rs.rng);
    checkEq(res.event.kind, 'fail', '8c step5: fail');
    s = res.state;

    // step6: 丧尸1 が 玩家2 を倒す → 終局ステップは hit + finished + winner
    snap = JSON.stringify(s);
    rs = new RngScript();
    rs.pushInt(0, 0, 0); rs.pushDie(7, 7); rs.pushDie(1, 7); rs.pushInt(3, 3, 3);
    lenBefore = s.log.length;
    res = GE.stepBattle(s, rs.rng);
    checkEq(rs.used, 4, '8c step6: 乱数 4 回');
    checkEq(JSON.stringify(s), snap, '8c step6: 入力 state は無傷');
    checkEq(res.event.kind, 'hit', '8c step6: event は hit');
    checkEq(res.event.target, '玩家2', '8c step6: target（倒地した 玩家1 は選ばれない）');
    checkEq(res.event.downed, true, '8c step6: downed');
    checkEq(res.event.finished, true, '8c step6: 終局ステップ');
    checkEq(res.event.winner, 'zombie', '8c step6: winner');
    checkEq(res.state.finished, true, '8c step6: state も終局');
    checkEq(res.state.winner, 'zombie', '8c step6: state の winner');
    checkEq(res.state.turnIndex, s.turnIndex, '8c step6: 終局ステップでは turnIndex を進めない');
    checkEq(res.state.log.length, lenBefore + 2, '8c step6: hit 行 + victory 行');
    s = res.state;

    // step7 以降: 終局済み state への stepBattle は無副作用
    snap = JSON.stringify(s);
    const bomb = () => { throw new Error('終局後の stepBattle で乱数を使ってはいらない'); };
    res = GE.stepBattle(s, bomb);
    check(res.state === s, '8c step7: 終局済みなら入力 state をそのまま返す');
    checkEq(res.event, null, '8c step7: event は null');
    checkEq(JSON.stringify(s), snap, '8c step7: state 無変化');
    res = GE.stepBattle(s, bomb); // もう 1 回も同じ
    check(res.state === s && res.event === null, '8c step7: 2 度目も同じ');
    checkEq(GE.isBattleOver(s), true, '8c: isBattleOver は終局で true');
    checkEq(GE.getResult(s), { finished: true, winner: 'zombie', survivors: [{ name: '丧尸1', hp: 100, maxHp: 100 }] },
      '8c: getResult は終局スナップショット');
    checkEq(GE.takeTurn(s, bomb), s, '8c: 終局済み state の takeTurn も入力をそのまま返す');
    checkEq(JSON.stringify(s), snap, '8c: 終局後の一連の呼び出しで state 無変化');
  }

  // 8d. MAX_STEPS 到達の強制終了をステップ経路でも（event forced-draw）
  {
    const saved = GE.MAX_STEPS;
    try {
      GE.MAX_STEPS = 5;
      const cfg = {
        human: { count: 1, hp: 9, attack: 0, agility: 0, dmgMin: 1, dmgMax: 1 },
        zombie: { count: 1, hp: 9, attack: 0, agility: 0, dmgMin: 1, dmgMax: 1 },
      };
      const rng = GE.createRng(1);
      let s = GE.startBattle(cfg, rng);
      let guard = 0;
      let lastEv = null;
      while (!s.finished && guard < 100) {
        guard++;
        const r = GE.stepBattle(s, rng);
        s = r.state;
        lastEv = r.event;
      }
      checkEq(lastEv.kind, 'forced-draw', '8d: 上限到達ステップの event は forced-draw');
      checkEq(lastEv.finished, true, '8d: forced-draw は終局イベント');
      checkEq(lastEv.winner, 'draw', '8d: winner は draw');
      checkEq(s.winner, 'draw', '8d: state の winner も draw');
      checkEq(s.survivors, [], '8d: draw のとき survivors は空');
      check(s.log.some(e => e.type === 'victory' && e.text.includes('平局')),
        '8d: 平局の victory 行');
      checkEq(JSON.stringify(s), JSON.stringify(GE.runBattle(cfg, GE.createRng(1))),
        '8d: ステップ経路の draw 終局も整場一括と完全一致');
    } finally {
      GE.MAX_STEPS = saved;
    }
    checkEq(GE.MAX_STEPS, saved, '8d: MAX_STEPS を復元');
  }

  // 8e. 一貫性の主力: 既存 223 戦のストレス構成を「整場 vs 逐次」で全件突き合わせる
  {
    let noneEvents = 0;
    let forcedEvents = 0;
    let finishedEvents = 0;
    let skipEvents = 0;
    let failEvents = 0;
    let dodgeEvents = 0;
    let hitEvents = 0;
    let moveEvents = 0;
    let blockedEvents = 0;
    let totalSteps = 0;
    for (let i = 0; i < stressCases.length; i++) {
      const c = stressCases[i];
      const ref = GE.runBattle(deepCopy(c.cfg), GE.createRng(c.seed));
      const rngS = GE.createRng(c.seed);
      let s = GE.startBattle(deepCopy(c.cfg), rngS);
      let guard = 0;
      let okAll = true;
      let diag = '';
      while (!s.finished) {
        if (++guard > 500000) { okAll = false; diag = 'guard 超過'; break; }
        const p = s;
        const fpb = fp(p);
        const r = GE.stepBattle(p, rngS);
        s = r.state;
        const o = stepOk(p, s, r.event);
        if (!o.ok) { okAll = false; diag = o.diag; break; }
        if (fp(p) !== fpb) { okAll = false; diag = 'stepBattle が入力 state を破壊した'; break; }
        totalSteps++;
        if (r.event.kind === 'skip') skipEvents++;
        else if (r.event.kind === 'fail') failEvents++;
        else if (r.event.kind === 'dodge') dodgeEvents++;
        else if (r.event.kind === 'hit') hitEvents++;
        else if (r.event.kind === 'move') moveEvents++;
        else if (r.event.kind === 'blocked') blockedEvents++;
        else if (r.event.kind === 'none') noneEvents++;
        else if (r.event.kind === 'forced-draw') forcedEvents++;
        if (r.event.finished === true) finishedEvents++;
      }
      checkEq(okAll, true, c.label + '/step: 毎歩の event・遷移・入力無破壊 ' + diag);
      checkEq(s.finished, true, c.label + '/step: 逐次実行でも終局する');
      checkEq(JSON.stringify(s), JSON.stringify(ref),
        c.label + '/step: 同一シードの整場一括と終局 state・ログが完全一致');
      // 逐次経路の終局 state も、ログ全面再生の独立検証を通ること
      verifyStateAndLog(s, c.cfg, c.label + '/step');
    }
    checkEq(noneEvents, 0, '保険経路 none のイベントは通常発生しない');
    checkEq(forcedEvents, 0, '通常構成では forced-draw は発生しない');
    checkEq(finishedEvents, stressCases.length, '終局イベントは各戦ちょうど 1 回');
    check(hitEvents >= stressCases.length, 'hit イベントは各戦 1 回以上: ' + hitEvents);
    check(failEvents >= 1 && dodgeEvents >= 1, 'fail/dodge も観測される: '
      + failEvents + '/' + dodgeEvents);
    check(skipEvents >= 1, '倒地者スキップも観測される: ' + skipEvents);
    check(moveEvents >= 1, '移動イベントも観測される: ' + moveEvents);
    check(totalSteps >= stressCases.length, '逐次ステップ総数は戦数以上: ' + totalSteps);
    console.log('[progress] step-consistency done: battles=' + stressCases.length
      + ' steps=' + totalSteps + ' events(f/d/dg/h/mv/bl/skip)=' + failEvents + '/'
      + dodgeEvents + '/' + hitEvents + '/' + moveEvents + '/' + blockedEvents + '/'
      + skipEvents + ' failures=' + failures.length);
  }

  // 8f. stepBattle と takeTurn の毎歩一致（部分集合: 同一シードで並走）
  {
    let compared = 0;
    for (let i = 0; i < 10; i++) {
      compared += compareTakeTurnChain(deepCopy(GE.DEFAULT_CONFIG), 1000 + i, '1v1-default#' + i);
    }
    for (let i = 0; i < stressCases.length; i += 40) {
      const c = stressCases[i];
      compared += compareTakeTurnChain(c.cfg, c.seed, c.label);
    }
    check(compared >= 100, '毎歩比較のステップ数は十分: ' + compared);
  }

  // 8g. 代表構成（1v1・人数不对称・長期戦）で毎歩の詳細照合 + 毎歩 takeTurn 一致
  {
    const dualCases = [
      { label: 'dual-1v1-a', seed: 4242, cfg: deepCopy(GE.DEFAULT_CONFIG) },
      { label: 'dual-1v1-b', seed: 4243, cfg: deepCopy(GE.DEFAULT_CONFIG) },
      {
        label: 'dual-1v3', seed: 4244,
        cfg: { human: { count: 1, hp: 14, attack: 4, agility: 3, dmgMin: 1, dmgMax: 3 },
               zombie: { count: 3, hp: 8, attack: 5, agility: 2, dmgMin: 1, dmgMax: 5 } },
      },
      {
        label: 'dual-4v1', seed: 4245,
        cfg: { human: { count: 4, hp: 10, attack: 4, agility: 3, dmgMin: 1, dmgMax: 3 },
               zombie: { count: 1, hp: 20, attack: 6, agility: 4, dmgMin: 2, dmgMax: 5 } },
      },
      {
        label: 'dual-3v5', seed: 4246,
        cfg: { human: { count: 3, hp: 12, attack: 4, agility: 4, dmgMin: 1, dmgMax: 3 },
               zombie: { count: 5, hp: 9, attack: 3, agility: 2, dmgMin: 1, dmgMax: 4 } },
      },
      {
        label: 'dual-5v5', seed: 4247,
        cfg: { human: { count: 5, hp: 12, attack: 4, agility: 4, dmgMin: 1, dmgMax: 3 },
               zombie: { count: 5, hp: 9, attack: 5, agility: 2, dmgMin: 1, dmgMax: 5 } },
      },
      {
        // 攻撃 7 / 敏捷 0 で全行動命中の長期戦（毎歩比較の負荷も兼ねる）
        label: 'dual-long', seed: 4248,
        cfg: { human: { count: 1, hp: 260, attack: 7, agility: 0, dmgMin: 1, dmgMax: 3 },
               zombie: { count: 1, hp: 260, attack: 7, agility: 0, dmgMin: 2, dmgMax: 6 } },
      },
    ];
    for (const c of dualCases) {
      const ref = GE.runBattle(deepCopy(c.cfg), GE.createRng(c.seed));
      const rngS = GE.createRng(c.seed);
      let s = GE.startBattle(deepCopy(c.cfg), rngS);
      checkEq(JSON.stringify(s), JSON.stringify(GE.startBattle(deepCopy(c.cfg), GE.createRng(c.seed))),
        c.label + ': startBattle 自身も同一シードで再現');
      let guard = 0;
      let steps = 0;
      let bad = '';
      while (!s.finished) {
        if (++guard > 500000) { bad = 'guard 超過'; break; }
        const p = s;
        const snap = JSON.stringify(p); // 入力 state の完全スナップ（代表構成なので全文で見る）
        const r = GE.stepBattle(p, rngS);
        s = r.state;
        const o = stepOk(p, s, r.event);
        if (!o.ok) { bad = o.diag; break; }
        if (JSON.stringify(p) !== snap) { bad = '入力 state が破壊された'; break; }
        steps++;
      }
      checkEq(bad, '', c.label + ': 毎歩の詳細照合 ' + bad);
      checkEq(JSON.stringify(s), JSON.stringify(ref), c.label + ': 整場 vs 逐次の終局完全一致');
      verifyStateAndLog(s, c.cfg, c.label + '/step');
      compareTakeTurnChain(c.cfg, c.seed, c.label);
      console.log('[progress] dual ' + c.label + ': steps=' + steps + ' failures=' + failures.length);
    }
  }
  console.log('[progress] step API done, failures=' + failures.length);

  // =============================================== 10) 初期配置（9×9 グリッド）
  // 10a. RngScript で抽選列を固定し、「作成順（玩家1..n → 丧尸1..n）に
  //      1 人ずつ randInt(0, k-1) で残り空きマス（行列表順）から抽選」
  //      というアルゴリズムそのものと、配置→先攻の消費順を検証する
  {
    const cfg = {
      human: { count: 2, hp: 12, attack: 4, agility: 4, dmgMin: 1, dmgMax: 3 },
      zombie: { count: 1, hp: 9, attack: 5, agility: 2, dmgMin: 1, dmgMax: 5 },
    };
    const rs = new RngScript();
    // 玩家1: 残り 81 中 40 番（5,5）→ 玩家2: 残り 80 中 0 番（1,1）→
    // 丧尸1: 残り 79 中 78 番（末尾 = (9,9)）
    rs.pushInt(40, 0, 80); rs.pushInt(0, 0, 79); rs.pushInt(78, 0, 78);
    // その後に先攻 d100（全員異点なので重投なし）
    rs.pushDie(90, 100); rs.pushDie(80, 100); rs.pushDie(70, 100);
    const s = GE.startBattle(cfg, rs.rng);
    checkEq(rs.used, 6, '10a: 初期配置は 1 人 1 抽選・その後に先攻 d100（計 6 回）');
    checkEq(s.members.find(m => m.name === '玩家1').pos, { row: 5, col: 5 },
      '10a: 玩家1 は 81 マス中 40 番（5,5）に落ちる');
    checkEq(s.members.find(m => m.name === '玩家2').pos, { row: 1, col: 1 },
      '10a: 玩家2 は残り空きマスの先頭（1,1）に落ちる');
    checkEq(s.members.find(m => m.name === '丧尸1').pos, { row: 9, col: 9 },
      '10a: 丧尸1 は残り空きマスの末尾（9,9）に落ちる');
    checkEq(s.log.filter(e => e.type === 'order')[0].text, '1. 玩家1（d100=90）（5,5）',
      '10a: order 行は行尾に初期座標「（5,5）」を付す');
  }
  // 10b. 同一シード再現 + 複数 seed で落位の重複なし・界内
  {
    const cfg = {
      human: { count: 5, hp: 10, attack: 3, agility: 2, dmgMin: 1, dmgMax: 3 },
      zombie: { count: 4, hp: 8, attack: 5, agility: 2, dmgMin: 1, dmgMax: 5 },
    };
    for (const seed of [11, 12, 13, 14]) {
      const a = GE.startBattle(deepCopy(cfg), GE.createRng(seed));
      const b = GE.startBattle(deepCopy(cfg), GE.createRng(seed));
      checkEq(JSON.stringify(b), JSON.stringify(a), '10b: 同一シードで配置含め完全再現 seed=' + seed);
      const cells = a.members.map(m => m.pos.row + ',' + m.pos.col);
      checkEq(new Set(cells).size, a.members.length, '10b: 落位は重複なし seed=' + seed);
      check(a.members.every(m => inBounds9(m.pos) && !!m.pos),
        '10b: 全員が界内に配置される seed=' + seed);
    }
  }
  // 10c. split 配置: 人类は列 1..4、丧尸は列 6..9、中列 5 は空置
  {
    const cfg = {
      placement: 'split',
      human: { count: 6, hp: 10, attack: 3, agility: 2, dmgMin: 1, dmgMax: 3 },
      zombie: { count: 6, hp: 8, attack: 5, agility: 2, dmgMin: 1, dmgMax: 5 },
    };
    for (const seed of [31, 32]) {
      const s = GE.startBattle(deepCopy(cfg), GE.createRng(seed));
      const cells = s.members.map(m => m.pos.row + ',' + m.pos.col);
      checkEq(new Set(cells).size, s.members.length, '10c: split でも落位は重複なし seed=' + seed);
      for (const m of s.members) {
        if (m.faction === 'human') {
          check(m.pos.col >= 1 && m.pos.col <= 4,
            '10c: 人类は列 1..4 に落ちる seed=' + seed + ' ' + m.name);
        } else {
          check(m.pos.col >= 6 && m.pos.col <= 9,
            '10c: 丧尸は列 6..9 に落ちる seed=' + seed + ' ' + m.name);
        }
        check(m.pos.col !== 5, '10c: 中列 5 は空置 seed=' + seed + ' ' + m.name);
        check(inBounds9(m.pos), '10c: 界内 seed=' + seed + ' ' + m.name);
      }
    }
    checkEq(GE.validateConfig(cfg), [], '10c: placement=split は正当な設定');
  }
  // 10d. pos の値语义: stepBattle は入力 state の pos を含めて一切破壊しない
  {
    const { state: s0 } = makeState({
      pos: [{ row: 1, col: 1 }, { row: 1, col: 9 }], // 隣接しない 1v1 → 先手は移動
      humanRolls: [90], zombieRolls: [40],
    });
    checkEq(s0.members[0].pos, { row: 1, col: 1 }, '10d: 準備 玩家1=(1,1)');
    checkEq(s0.members[1].pos, { row: 1, col: 9 }, '10d: 準備 丧尸1=(1,9)');
    const snap = JSON.stringify(s0);
    const rs = new RngScript();
    rs.pushInt(0, 0, 0); // 候補は (1,2) と (2,1) の 2 マス、距離最小 7 は (1,2) の一意
    const res = GE.stepBattle(s0, rs.rng);
    checkEq(rs.used, 1, '10d: 最小距離が一意でも抽選は 1 回行う');
    checkEq(JSON.stringify(s0), snap, '10d: stepBattle は入力 state の pos を含めて無傷');
    checkEq(res.event.kind, 'move', '10d: 離れた敵には移動する');
    checkEq(res.event.from, { row: 1, col: 1 }, '10d: ev.from は移動前 pos');
    checkEq(res.event.to, { row: 1, col: 2 }, '10d: ev.to は移動先');
    checkEq(res.state.members[0].pos, { row: 1, col: 2 }, '10d: state の pos は移動先に更新');
    checkEq(manhattan(res.event.from, res.event.to), 1, '10d: 移動は 1 マス');
    check(res.state.members[0].pos !== res.event.from && res.event.to !== res.event.from,
      '10d: pos と event は参照を共有しない（値语义）');
  }

  // =============================================== 11) 行動規則（隣接攻撃・移動選路）
  // 11a. 不相邻なら攻撃しない（移動する）／距離が 1 減る
  {
    const s = placedState(
      {
        human: { count: 1, hp: 12, attack: 4, agility: 4, dmgMin: 1, dmgMax: 3 },
        zombie: { count: 1, hp: 9, attack: 5, agility: 2, dmgMin: 1, dmgMax: 5 },
      },
      [{ row: 5, col: 5 }, { row: 1, col: 1 }], [90, 40]);
    checkEq(s.order[0], '玩家1', '11a: 先手は 玩家1');
    const rs = new RngScript();
    rs.pushInt(0, 0, 1); // 最小距離 7 の並列 2 マス（(4,5),(5,4)）の行列表順抽選
    const lenBefore = s.log.length;
    const s2 = GE.takeTurn(s, rs.rng);
    checkEq(rs.used, 1, '11a: 移動 1 歩は乱数 1 回');
    checkEq(s2.log.length, lenBefore + 1, '11a: 追記は移動行 1 行のみ');
    const mv = s2.log[lenBefore];
    checkEq(mv.type, 'action-move', '11a: ログは移動行（攻撃ログは出ない）');
    checkEq(s2.members.find(m => m.name === '玩家1').pos, { row: 4, col: 5 },
      '11a: 並列 2 マスの先頭（行列表順）へ 1 マス移動');
    checkEq(mv.text, '玩家1 移动：（5,5）→（4,5）', '11a: 移動行の逐字');
  }
  // 11b. 隣接時は必ず攻撃し、目標は「隣接敵の集合」から選ばれる
  //      （遠方の敵がいても抽選の分母に含まれない。raw=0.5 は
  //        隣接集合 k=1 → 0 番 / 全敵 k=2 → 1 番になるため判別できる）
  {
    const s = placedState(
      {
        human: { count: 2, hp: 12, attack: 7, agility: 0, dmgMin: 1, dmgMax: 1 },
        zombie: { count: 2, hp: 9, attack: 5, agility: 0, dmgMin: 1, dmgMax: 1 },
      },
      [{ row: 3, col: 4 }, { row: 8, col: 8 }, { row: 3, col: 3 }, { row: 1, col: 1 }],
      [10, 20, 90, 80]); // 丧尸1(90) → 丧尸2(80) → 玩家1(10) → 玩家2(20)? → 降順で先手は 丧尸1
    checkEq(s.order[0], '丧尸1', '11b: 先手は 丧尸1（隣接する 玩家1 と離れた 玩家2 がいる盤面）');
    const rs = new RngScript();
    rs.pushInt(0, 0, 0); // 隣接集合は 玩家1 のみ（k=1）。全敵なら k=2 で 玩家2 が当たる
    rs.pushDie(6, 7);    // 攻撃 d7=6 ＞ 攻击5 → 失敗
    const lenBefore = s.log.length;
    const s2 = GE.takeTurn(s, rs.rng);
    checkEq(rs.used, 2, '11b: 目標抽選 1 回＋攻撃 d7');
    const acts = actionEntriesBetween(s2, lenBefore);
    checkEq(acts.length, 1, '11b: 1 行動');
    checkEq(acts[0].type, 'action-fail', '11b: 攻撃失敗行');
    check(acts[0].text.startsWith('丧尸1 → 玩家1：'),
      '11b: 目標は隣接した 玩家1（遠方の 玩家2 は候補外）: ' + acts[0].text);
  }
  // 11c. 並列選路は同 seed で再現し、抽選値で選択先が変わる
  {
    const cfg = {
      human: { count: 1, hp: 12, attack: 4, agility: 4, dmgMin: 1, dmgMax: 3 },
      zombie: { count: 1, hp: 9, attack: 5, agility: 2, dmgMin: 1, dmgMax: 5 },
    };
    // 玩家1(5,5)、丧尸1(4,4)（斜め隣接は攻撃不可）→ 最小距離 1 の並列 2 マス
    for (const pick of [0, 1]) {
      const rs = new RngScript();
      rs.pushInt(pick, 0, 1); // 並列候補 (4,5)(5,4) の行列表順で pick 番
      const s = placedState(deepCopy(cfg), [{ row: 5, col: 5 }, { row: 4, col: 4 }], [90, 40]);
      const s2 = GE.takeTurn(s, rs.rng);
      const expectCell = pick === 0 ? { row: 4, col: 5 } : { row: 5, col: 4 };
      checkEq(s2.members.find(m => m.name === '玩家1').pos, expectCell,
        '11c: 並列候補の抽選値 ' + pick + ' は行列表順の ' + JSON.stringify(expectCell));
      // 同一スクリプトの再現性（同じ並列局面・同じ抽選値 → 同じ移動先）
      const again = placedState(deepCopy(cfg), [{ row: 5, col: 5 }, { row: 4, col: 4 }], [90, 40]);
      const rs2 = new RngScript();
      rs2.pushInt(pick, 0, 1);
      const again2 = GE.takeTurn(again, rs2.rng);
      checkEq(again2.members.find(m => m.name === '玩家1').pos, expectCell,
        '11c: 並列選路は同 seed で再現する pick=' + pick);
    }
  }
  // 11d. 受限格: 角に追い詰められた行動者は空きマスだけを候補にする
  {
    const s = placedState(
      {
        human: { count: 2, hp: 12, attack: 4, agility: 4, dmgMin: 1, dmgMax: 3 },
        zombie: { count: 1, hp: 9, attack: 5, agility: 2, dmgMin: 1, dmgMax: 5 },
      },
      [{ row: 1, col: 1 }, { row: 2, col: 1 }, { row: 1, col: 5 }],
      [90, 80, 40]); // 先手 玩家1=(1,1)。下は味方、右は空き、上と左は界外
    const rs = new RngScript();
    rs.pushInt(0, 0, 0); // 候補は (1,2) のみ（候補 1 マスでも抽選する）
    const s2 = GE.takeTurn(s, rs.rng);
    checkEq(rs.used, 1, '11d: 候補 1 マスでも 1 抽選');
    checkEq(s2.members.find(m => m.name === '玩家1').pos, { row: 1, col: 2 },
      '11d: 唯一の空き候補へ移動');
    checkEq(s2.log[s2.log.length - 1].text, '玩家1 移动：（1,1）→（1,2）',
      '11d: 移動行の逐字');
  }
  // 11e. 四面皆阻: 候補ゼロ → 移動不能行・乱数 0 回・pos 不変
  {
    const s = placedState(
      {
        human: { count: 3, hp: 12, attack: 4, agility: 4, dmgMin: 1, dmgMax: 3 },
        zombie: { count: 1, hp: 9, attack: 5, agility: 2, dmgMin: 1, dmgMax: 5 },
      },
      [{ row: 1, col: 1 }, { row: 1, col: 2 }, { row: 2, col: 1 }, { row: 9, col: 9 }],
      [90, 80, 70, 40]); // 玩家1=(1,1): 右と下は味方、上と左は界外、敵は遠方
    const rs = new RngScript(); // 1 回でも乱数を使ったら例外で落ちる
    const lenBefore = s.log.length;
    const s2 = GE.takeTurn(s, rs.rng);
    checkEq(rs.used, 0, '11e: 移動不能は乱数を消費しない');
    checkEq(s2.members.find(m => m.name === '玩家1').pos, { row: 1, col: 1 },
      '11e: pos は不変');
    checkEq(s2.log.length, lenBefore + 1, '11e: 移動不能行 1 行だけ追記');
    checkEq(s2.log[lenBefore].type, 'action-blocked', '11e: ログ type は action-blocked');
    checkEq(s2.log[lenBefore].text, '玩家1 无法移动（无路可走）', '11e: 移動不能行の逐字');
    checkEq(s2.turnIndex, (s.turnIndex + 1) % s.order.length, '11e: 順序は進む');
  }
  // 11f. 倒地マスは空き扱い（入れる）・倒地者は攻撃目標にならない
  {
    const s = placedState(
      {
        human: { count: 1, hp: 12, attack: 4, agility: 4, dmgMin: 1, dmgMax: 3 },
        zombie: { count: 2, hp: 9, attack: 5, agility: 2, dmgMin: 1, dmgMax: 5 },
      },
      [{ row: 1, col: 1 }, { row: 1, col: 2 }, { row: 1, col: 9 }],
      [90, 40, 30]);
    // 丧尸1（(1,2)）を倒地させる（state 保持の純データとして末位 pos を残す）
    s.members.find(m => m.name === '丧尸1').hp = 0;
    s.members.find(m => m.name === '丧尸1').downed = true;
    const rs = new RngScript();
    rs.pushInt(0, 0, 0); // (1,2) は倒地マスなので入れる。距離最小は一意に (1,2)
    const s2 = GE.takeTurn(s, rs.rng);
    checkEq(s2.members.find(m => m.name === '玩家1').pos, { row: 1, col: 2 },
      '11f: 倒地者のマスへ入れる');
  }
  {
    // 隣接敵に倒地者が混ざっても目標集合から除外される
    // （raw=0.5 は 生存のみ k=1 → 0 番=丧尸1 / 倒地込み k=2 → 1 番=丧尸2）
    const s = placedState(
      {
        human: { count: 1, hp: 12, attack: 7, agility: 0, dmgMin: 1, dmgMax: 1 },
        zombie: { count: 2, hp: 9, attack: 5, agility: 0, dmgMin: 1, dmgMax: 1 },
      },
      [{ row: 1, col: 4 }, { row: 2, col: 4 }, { row: 1, col: 5 }],
      [90, 40, 30]);
    s.members.find(m => m.name === '丧尸2').hp = 0;
    s.members.find(m => m.name === '丧尸2').downed = true;
    const rs = new RngScript();
    rs.pushInt(0, 0, 0); // 隣接生存者は 丧尸1 のみ（倒地込みなら 2 体で 丧尸2 に当たる）
    rs.pushDie(1, 7);    // 攻撃 d7=1 ≤ 攻击7 → 命中
    rs.pushDie(1, 7);    // 丧尸1 敏捷 0 → 未回避
    rs.pushInt(1, 1, 1); // 伤害 1
    const lenBefore = s.log.length;
    const s2 = GE.takeTurn(s, rs.rng);
    checkEq(rs.used, 4, '11f: 命中経路の乱数 4 回');
    const acts = actionEntriesBetween(s2, lenBefore);
    checkEq(acts.length, 1, '11f: 1 行動');
    check(acts[0].text.startsWith('玩家1 → 丧尸1：'),
      '11f: 倒地した 丧尸2 は目標に選ばれない: ' + acts[0].text);
  }
  // 11g. rng 消費の総括（順序表記を含む順序表の行尾座標は 10a で検証済み）
  {
    // 開戦直後の乱数消費 = 初期配置（人数分）＋ 先攻 d100（人数分）
    const cfg = deepCopy(GE.DEFAULT_CONFIG);
    cfg.human.count = 3; cfg.zombie.count = 3;
    const rs = new RngScript();
    for (let i = 0; i < 6; i++) rs.pushInt(i, 0, 80 - i); // 配置 6 抽選（値は任意）
    for (let i = 0; i < 6; i++) rs.pushDie(100 - i * 7, 100); // d100 6 回
    const s = GE.startBattle(cfg, rs.rng);
    checkEq(rs.used, 12, '11g: startBattle の消費は配置 6＋先攻 6（1 人につき配置 1 回）');
    checkEq(new Set(s.members.map(m => m.pos.row + ',' + m.pos.col)).size, 6,
      '11g: 6 人の落位は重複なし');
  }

  // 11h. 行動順表の行尾座標（重投序列并存の逐字サンプル）
  {
    const cfg = {
      human: { count: 2, hp: 12, attack: 4, agility: 4, dmgMin: 1, dmgMax: 3 },
      zombie: { count: 1, hp: 9, attack: 5, agility: 2, dmgMin: 1, dmgMax: 5 },
    };
    const draws = placementDraws(defaultPos(2, 1)); // (1,2)(2,3)(2,2)
    const rs = new RngScript();
    for (const d of draws) rs.pushInt(d.v, 0, d.k - 1);
    rs.pushDie(80, 100); rs.pushDie(80, 100); rs.pushDie(85, 100); // 玩家2 人が同点
    rs.pushDie(10, 100); rs.pushDie(10, 100);                      // 重投 1（まだ同点）
    rs.pushDie(5, 100); rs.pushDie(95, 100);                       // 重投 2（決着）
    const s = GE.startBattle(cfg, rs.rng);
    const ord = s.log.filter(e => e.type === 'order').map(e => e.text);
    checkEq(ord, [
      '1. 丧尸1（d100=85）（2,2）',
      '2. 玩家2（d100=80→10→95）（2,3）',
      '3. 玩家1（d100=80→10→5）（1,2）',
    ], '11h: 順序表は重投序列の後に行尾座標を付す（逐字）');
  }

  console.log('[progress] grid rules done, failures=' + failures.length);

  // =============================================== 9) UI 層（GameUI + 同期スケジューラ）
  // DOM スタブ上で window.GameUI を駆動する。待ち時間は
  // GameUI.createSyncScheduler()（ポンプ式）に差し替え、さらに遅延 ms を
  // 記録するスパイで包んで速度切替の効果を観測する。
  if (!GUI || !DOC) {
    pushFailure('GameUI/document スタブが取得できず、UI 流程テストを実行できない');
  } else {
    // --- 9a. 公開面と初期状態 ---
    for (const k of ['SPEEDS', 'createRealtimeScheduler', 'createSyncScheduler', 'useScheduler',
      'getScheduler', 'getScreen', 'getMode', 'getSpeed', 'setSpeed', 'startBattle',
      'skipToResult', 'resetToConfig', 'clearLog', 'getBattleState', 'getLogEntries']) {
      check(typeof GUI[k] !== 'undefined', 'GameUI.' + k + ' が公開されている');
    }
    checkEq(GUI.SPEEDS,
      { slow: { label: '慢', delay: 1600 }, middle: { label: '中', delay: 800 }, fast: { label: '快', delay: 300 } },
      'SPEEDS は 慢/中/快 の 3 段階');
    let threw = false;
    try { GUI.useScheduler(null); } catch (e) { threw = true; }
    check(threw, 'useScheduler(null) は例外を投げる');
    // スパイ付き同期スケジューラ: setTimeout の遅延 ms を記録する
    const spy = (function () {
      const base = GUI.createSyncScheduler();
      const delays = [];
      return {
        delays: delays,
        setTimeout: function (fn, ms) { delays.push(ms); return base.setTimeout(fn, ms); },
        clearTimeout: function (id) { return base.clearTimeout(id); },
        clear: function () { return base.clear(); },
        pump: function (limit) { return base.pump(limit); },
        size: function () { return base.size(); },
      };
    })();
    GUI.useScheduler(spy);
    checkEq(GUI.getScheduler(), spy, 'useScheduler でスパイ scheduler へ差し替わる');
    checkEq(GUI.getScreen(), 'config', '初期画面は config');
    checkEq(GUI.getMode(), 'idle', '初期 mode は idle');
    checkEq(GUI.getSpeed(), 'middle', '初期速度は middle');
    checkEq(GUI.getBattleState(), null, '未開戦の getBattleState は null');
    checkEq(GUI.getLogEntries(), [], '未開戦の getLogEntries は空');
    checkEq(DOC.getElementById('config-screen').hidden, false, '初期は配置画面が見える');
    checkEq(DOC.getElementById('battle-screen').hidden, true, '初期は戦場画面が隠れる');
    checkEq(DOC.getElementById('faction-configs').children.length, 2, '設定パネルは両陣営分');
    checkEq(DOC.getElementById('human-count').value, '1', '人類人数の初期値');
    checkEq(DOC.getElementById('human-hp').value, '12', '人類 HP の初期値');
    checkEq(DOC.getElementById('zombie-hp').value, '9', '喪屍 HP の初期値');
    checkEq(DOC.getElementById('zombie-attack').value, '5', '喪屍攻撃の初期値');
    // 初期站位の全局セレクト（UI 側は選択値を config.placement として渡す）
    checkEq(DOC.getElementById('config-placement').disabled, false,
      '初期站位セレクトは未開戦では編集可');

    // カード / チップ / 飄字の参照ヘルパ（buildCards の子順に依存:
    // [0]emoji [1]血条(>fill) [2]飄字レイヤー。名前は title 属性）
    const cardOf = (name) => DOC.getElementById('card-' + name);
    const chipOf = (name) => DOC.getElementById('chip-' + name);
    const floatSpans = (name) => cardOf(name).children[2].children;
    const hpFillWidth = (name) => cardOf(name).children[1].children[0].style.width;
    const titleOf = (name) => cardOf(name).title;
    const transformOf = (name) => cardOf(name).style.transform;

    // --- 9b. 開戦: 2v2。逐次演出をエンジンのステップ連鎖と毎歩突き合わせる ---
    GUI.setSpeed('middle');
    const uiCfg = {
      human: { count: 2, hp: 12, attack: 4, agility: 4, dmgMin: 1, dmgMax: 3 },
      zombie: { count: 2, hp: 9, attack: 5, agility: 2, dmgMin: 1, dmgMax: 5 },
    };
    // 混合ランダム配置になった 2v2 は种子ごとに進行が変わるため、
    // hit・倒地・スキップ・移動の 4 種 event がすべて出る种子を固定して使う
    // （探索は決定論的。どの种子でも互換があるわけではないための下拵え）
    let uiSeed = 777;
    let refStates = null;
    let refEvents = null;
    for (;;) {
      const rr = GE.createRng(uiSeed);
      const candStates = [GE.startBattle(deepCopy(uiCfg), rr)];
      const candEvents = [];
      while (!candStates[candStates.length - 1].finished) {
        const r = GE.stepBattle(candStates[candStates.length - 1], rr);
        candStates.push(r.state);
        candEvents.push(r.event);
      }
      const kinds = new Set(candEvents.map(e => e.kind));
      const hasDowned = candEvents.some(e => e.kind === 'hit' && e.downed === true);
      if (kinds.has('hit') && kinds.has('move') && kinds.has('skip') && hasDowned) {
        refStates = candStates;
        refEvents = candEvents;
        break;
      }
      uiSeed++;
      if (uiSeed > 777 + 1000) {
        pushFailure('9b: hit/倒地/skip/move が全部出る种子が見つからない');
        uiSeed = 777;
        refStates = candStates;
        refEvents = candEvents;
        break;
      }
    }
    const refFinal = refStates[refStates.length - 1];
    spy.delays.length = 0;
    GUI.startBattle(deepCopy(uiCfg), GE.createRng(uiSeed));
    checkEq(GUI.getScreen(), 'battle', '開戦で戦場画面へ');
    checkEq(GUI.getMode(), 'live', '開戦で mode は live');
    checkEq(spy.delays, [GUI.SPEEDS.middle.delay], '最初のステップは現在速度の遅延で予約');
    checkEq(spy.size(), 1, '予約は 1 件');
    checkEq(DOC.getElementById('config-screen').hidden, true, '戦場では配置画面を隠す');
    checkEq(DOC.getElementById('battle-screen').hidden, false, '戦場画面を表示');
    check(DOC.getElementById('human-count').disabled === true
      && DOC.getElementById('human-hp').disabled === true
      && DOC.getElementById('zombie-attack').disabled === true
      && DOC.getElementById('config-placement').disabled === true
      && DOC.getElementById('btn-start').disabled === true,
      '開戦で設定入力・初期站位・開戦ボタンをロック');
    check(DOC.getElementById('btn-skip').disabled === false, '跳到結果ボタンは有効');
    checkEq(GUI.getBattleState(), refStates[0], '開戦直後の state がエンジン startBattle と一致');
    checkEq(DOC.getElementById('order-strip').children.length, 4, '順序帯は全員分のチップ');
    // 9×9 戦場グリッド: 81 マス＋全カードが #battle-grid に載る。
    // （旧「双陣営カード网格」の代わりに、マス数・カード構造・位置を断言する）
    checkEq(DOC.getElementById('battle-grid').children.length, 81 + 4,
      '戦場グリッドは 81 マス＋全員分のカード');
    checkEq(DOC.getElementById('battle-grid').children[0].className, 'grid-cell alt',
      '先頭マスは grid-cell（(1,1) は市松模様の alt）');
    checkEq(DOC.getElementById('battle-grid').children[1].className, 'grid-cell',
      '隣接マス (1,2) は通常セル');
    checkEq(titleOf('玩家1'), '玩家1', 'カードの title 属性に名前');
    checkEq(titleOf('丧尸1'), '丧尸1', 'カードの title 属性に名前（喪屍）');
    checkEq(cardOf('玩家1').children[0].textContent, '🧑', '人類は 🧑');
    checkEq(cardOf('丧尸1').children[0].textContent, '🧟', '喪屍は 🧟');
    checkEq(hpFillWidth('玩家1'), '100%', '血条幅の初期表示');
    // カードの transform は state の pos と同期する（マス座標 × 44px）
    for (const m of refStates[0].members) {
      checkEq(transformOf(m.name), transformFor(m.pos),
        '開戦直後のカード位置が pos と一致: ' + m.name);
    }
    checkEq(chipOf(refStates[0].order[0]).classList.contains('active'), true, '先頭行動者のチップを強調');
    checkEq(DOC.getElementById('battle-log').children.length, refStates[0].log.length, '開戦直後のログ描画');
    checkEq(DOC.getElementById('battle-log').children[0].className, 'log-order-header',
      'ログ行には種別クラスが付く');

    // --- 9c. 1 pump == 1 ステップ: 毎歩 state がエンジン逐次と一致、飄字/血条/チップ/ログも同期 ---
    const firstHitIdx = refEvents.findIndex(e => e.kind === 'hit');
    const firstDownedIdx = refEvents.findIndex(e => e.kind === 'hit' && e.downed === true);
    const firstSkipIdx = refEvents.findIndex(e => e.kind === 'skip');
    const firstMoveIdx = refEvents.findIndex(e => e.kind === 'move');
    check(firstHitIdx >= 0, 'この戦には hit ステップがある');
    check(firstDownedIdx >= 0, 'この戦には倒地ステップがある');
    check(firstSkipIdx >= 0, 'この戦には倒地者スキップがある');
    check(firstMoveIdx >= 0, 'この戦には移動ステップがある');
    let uiSteps = 0;
    while (GUI.getMode() === 'live' && uiSteps < refStates.length) {
      spy.pump(1);
      uiSteps++;
      const st = GUI.getBattleState();
      checkEq(st, refStates[uiSteps], 'UI ' + uiSteps + ' 歩目の state がエンジン逐次と一致');
      checkEq(DOC.getElementById('battle-log').children.length, refStates[uiSteps].log.length,
        'UI ' + uiSteps + ' 歩目でログ描画が同期');
      if (uiSteps === firstHitIdx + 1) {
        const ev = refEvents[firstHitIdx];
        const hitT = refStates[uiSteps].members.find(m => m.name === ev.target);
        const pct = Math.max(0, Math.min(100, (hitT.hp / hitT.maxHp) * 100));
        checkEq(floatSpans(ev.actor).length, 1, '命中者の頭上に飄字 1 枚');
        checkEq(floatSpans(ev.actor)[0].textContent, 'd7=' + ev.atkRoll + ' 命中', '命中飄字の文言');
        checkEq(floatSpans(ev.target).length, 1, '被弾者の頭上に飄字 1 枚');
        checkEq(floatSpans(ev.target)[0].textContent, '-' + ev.damage, '被弾飄字は伤害量');
        checkEq(cardOf(ev.target).classList.contains('hit-flash'), true, '被弾カードに閃紅クラス');
        checkEq(cardOf(ev.actor).classList.contains('current'), true, '行動者カードに current 表示');
        checkEq(hpFillWidth(ev.target), pct + '%', '血条幅が即時更新');
        checkEq(chipOf(ev.actor).classList.contains('active'), true, '行動中チップの強調');
      }
      if (uiSteps === firstDownedIdx + 1) {
        const ev = refEvents[firstDownedIdx];
        checkEq(cardOf(ev.target).children[0].textContent, '💀', '倒地カードは 💀');
        checkEq(cardOf(ev.target).classList.contains('downed'), true,
          '倒地カードはグリッドから除去（downed クラスで非表示）');
        checkEq(chipOf(ev.target).children[0].textContent, '💀', '順序帯チップも 💀');
        checkEq(chipOf(ev.target).classList.contains('downed'), true, '順序帯チップも灰化');
      }
      if (uiSteps === firstSkipIdx + 1) {
        const ev = refEvents[firstSkipIdx];
        checkEq(cardOf(ev.actor).children[0].textContent, '💀', 'スキップされたのは倒地者');
        checkEq(GUI.getLogEntries().length, refStates[uiSteps].log.length, 'スキップ歩でもログは同期');
      }
      if (uiSteps === firstMoveIdx + 1) {
        // 移動演出: カードの transform が移動先マスに滑り、state の pos と同期する
        const ev = refEvents[firstMoveIdx];
        checkEq(transformOf(ev.actor), transformFor(ev.to), '移動後のカード位置が ev.to と一致');
        const mv = refStates[uiSteps].members.find(m => m.name === ev.actor);
        checkEq(transformOf(ev.actor), transformFor(mv.pos), '移動後のカード位置が state pos と一致');
        checkEq(DOC.getElementById('battle-log')
          .children[refStates[uiSteps].log.length - 1].className, 'log-action-move',
          '移動歩のログ行は log-action-move');
      }
    }
    checkEq(GUI.getMode(), 'done', '全ステップ演出で終局表示へ');
    checkEq(uiSteps, refStates.length - 1, 'UI のステップ数がエンジン連鎖と一致');
    checkEq(GUI.getBattleState(), refFinal, 'UI 終局 state がエンジン整場結果と完全一致');
    checkEq(DOC.getElementById('battle-log').children.length, refFinal.log.length, '終局時もログ同期');
    checkEq(DOC.getElementById('battle-banner').hidden, false, '終局で横幅を出す');
    checkEq(DOC.getElementById('btn-skip').disabled, true, '終局でスキップは無効');
    checkEq(DOC.getElementById('banner-title').textContent,
      '🏆 战斗结束 —— ' + GE.FACTION_LABEL[refFinal.winner] + '获胜！', '横幅タイトルは勝者陣営');
    checkEq(DOC.getElementById('banner-body').textContent,
      refFinal.survivors.map(m => m.name + '：剩余 HP ' + m.hp + '/' + m.maxHp).join('\n'),
      '横幅は勝利側の各生存者残り HP');
    check(refFinal.order.every(nm => !chipOf(nm).classList.contains('active')), '終局でチップ強調を外す');
    checkEq(GUI.getLogEntries(), refFinal.log, 'getLogEntries は全ログのコピー');

    // --- 9d. 速度 3 段階の切替（演出中の再予約も含む） ---
    GUI.resetToConfig();
    GUI.setSpeed('slow');
    spy.delays.length = 0;
    GUI.startBattle(deepCopy(GE.DEFAULT_CONFIG), GE.createRng(778));
    checkEq(spy.delays, [1600], 'slow の遅延で最初のステップを予約');
    GUI.setSpeed('middle');
    checkEq(spy.delays, [1600, 800], '演出中の速度切替で次ステップを再予約');
    checkEq(spy.size(), 1, '再予約後も予約は 1 件');
    checkEq(GUI.getSpeed(), 'middle', 'getSpeed が middle');
    GUI.setSpeed('fast');
    checkEq(spy.delays, [1600, 800, 300], 'fast への再予約');
    checkEq(GUI.getSpeed(), 'fast', 'getSpeed が fast');
    checkEq(DOC.getElementById('speed-fast').className, 'speed-btn active', 'fast ボタンが active');
    checkEq(DOC.getElementById('speed-slow').className, 'speed-btn', 'slow ボタンの強調は解除');
    checkEq(DOC.getElementById('speed-middle').className, 'speed-btn', 'middle ボタンの強調は解除');
    spy.pump(1);
    checkEq(spy.delays, [1600, 800, 300, 300], '実行後の次ステップも切替後の速度');
    checkEq(GUI.getMode(), 'live', '速度切替は演出を壊さない');
    GUI.resetToConfig();

    // --- 9e. 跳到結果: 演出中途から一気に終局へ（整場一括と完全一致） ---
    GUI.setSpeed('middle');
    const skipCfg = {
      human: { count: 3, hp: 15, attack: 4, agility: 3, dmgMin: 1, dmgMax: 3 },
      zombie: { count: 3, hp: 11, attack: 5, agility: 2, dmgMin: 1, dmgMax: 5 },
    };
    const skipRef = GE.runBattle(deepCopy(skipCfg), GE.createRng(779));
    GUI.startBattle(deepCopy(skipCfg), GE.createRng(779));
    spy.pump(1); spy.pump(1); spy.pump(1);
    checkEq(GUI.getMode(), 'live', '3 歩目でも演出中');
    const mid = GUI.getBattleState();
    checkEq(mid.finished, false, '演出中途で未終局');
    checkEq(mid.steps, 3, '3 ステップまで進んでいる');
    GUI.skipToResult();
    checkEq(GUI.getMode(), 'done', '跳到結果で終局表示へ');
    checkEq(GUI.getScreen(), 'battle', '画面は戦場のまま');
    checkEq(GUI.getBattleState(), skipRef, '跳到結果の終局 state が整場一括と完全一致');
    checkEq(spy.size(), 0, '残りの予約は全て破棄');
    checkEq(DOC.getElementById('battle-log').children.length, skipRef.log.length, 'ログも最後まで描画');
    checkEq(DOC.getElementById('banner-title').textContent,
      '🏆 战斗结束 —— ' + GE.FACTION_LABEL[skipRef.winner] + '获胜！', '横幅タイトル（skip 経路）');
    const doneSnap = JSON.stringify(GUI.getBattleState());
    GUI.skipToResult();
    checkEq(JSON.stringify(GUI.getBattleState()), doneSnap, '終局後の skipToResult は無操作');

    // --- 9f. 一键清空: 表示だけ消え、以後の追記は続く ---
    GUI.resetToConfig();
    GUI.startBattle(deepCopy(GE.DEFAULT_CONFIG), GE.createRng(780));
    spy.pump(1); spy.pump(1);
    const logLenAtClear = GUI.getBattleState().log.length;
    checkEq(DOC.getElementById('battle-log').children.length, logLenAtClear, '清空前の描画行数');
    GUI.clearLog();
    checkEq(DOC.getElementById('battle-log').children.length, 0, '一键清空で表示だけ消える');
    checkEq(GUI.getLogEntries().length, logLenAtClear, 'ログデータ自体は残る');
    spy.pump(1);
    const logLenAfter = GUI.getBattleState().log.length;
    checkEq(DOC.getElementById('battle-log').children.length, logLenAfter - logLenAtClear,
      '清空後は新しい行だけ追記される');
    check(logLenAfter >= logLenAtClear, '以後の行動ログは続く');
    GUI.resetToConfig();

    // --- 9g. 重置: 演出中断 → 配置画面・入力解放・戦場破棄 ---
    GUI.startBattle(deepCopy(GE.DEFAULT_CONFIG), GE.createRng(781));
    spy.pump(1); spy.pump(1);
    checkEq(GUI.getMode(), 'live', '中断テスト用に演出中まで進めた');
    checkEq(GUI.getBattleState().finished, false, '中断時点で未終局');
    GUI.resetToConfig();
    checkEq(GUI.getScreen(), 'config', '重置で配置画面へ');
    checkEq(GUI.getMode(), 'idle', '重置で mode は idle');
    checkEq(GUI.getBattleState(), null, '重置で state を破棄');
    checkEq(GUI.getLogEntries(), [], '重置でログを破棄');
    checkEq(DOC.getElementById('config-screen').hidden, false, '配置画面を再表示');
    checkEq(DOC.getElementById('battle-screen').hidden, true, '戦場画面を隠す');
    check(DOC.getElementById('human-count').disabled === false
      && DOC.getElementById('human-hp').disabled === false
      && DOC.getElementById('zombie-hp').disabled === false
      && DOC.getElementById('config-placement').disabled === false
      && DOC.getElementById('btn-start').disabled === false,
      '重置で設定入力・初期站位・開戦ボタンが再び編集可');
    checkEq(DOC.getElementById('battle-grid').children.length, 0, '戦場グリッド（マス＋カード）を破棄');
    checkEq(DOC.getElementById('order-strip').children.length, 0, '順序帯を破棄');
    checkEq(DOC.getElementById('battle-log').children.length, 0, 'ログ表示を破棄');
    checkEq(DOC.getElementById('battle-banner').hidden, true, '横幅を隠す');
    checkEq(spy.size(), 0, '未実行コールバックを破棄');
    spy.pump();
    checkEq(GUI.getMode(), 'idle', '破棄済みコールバックは発火しない');
    // 入力が生きている証拠: 重置後にそのまま再開戦できる
    GUI.startBattle(deepCopy(GE.DEFAULT_CONFIG), GE.createRng(782));
    checkEq(GUI.getMode(), 'live', '重置後の再開戦が成功する');
    checkEq(GUI.getScreen(), 'battle', '再開戦で戦場画面へ');
    GUI.resetToConfig();

    // --- 9h. 異常系: 演出中の再開戦・不正設定 ---
    GUI.startBattle(deepCopy(GE.DEFAULT_CONFIG), GE.createRng(783));
    spy.pump(1);
    threw = false;
    try { GUI.startBattle(deepCopy(GE.DEFAULT_CONFIG), GE.createRng(784)); } catch (e) { threw = true; }
    check(threw, '演出中の startBattle は例外を投げる');
    GUI.resetToConfig();
    threw = false;
    const badUICfg = deepCopy(GE.DEFAULT_CONFIG);
    badUICfg.human.count = 0;
    try { GUI.startBattle(badUICfg); } catch (e) { threw = true; }
    check(threw, '不正設定の startBattle は例外を投げる');
    checkEq(GUI.getMode(), 'idle', '失敗後も idle のまま');
    checkEq(GUI.getScreen(), 'config', '失敗後も配置画面のまま');

    // --- 9i. 上限到達の draw（UI 経路） ---
    const savedMax = GE.MAX_STEPS;
    try {
      GE.MAX_STEPS = 5;
      const drawCfg = {
        human: { count: 1, hp: 9, attack: 0, agility: 0, dmgMin: 1, dmgMax: 1 },
        zombie: { count: 1, hp: 9, attack: 0, agility: 0, dmgMin: 1, dmgMax: 1 },
      };
      GUI.startBattle(drawCfg, GE.createRng(785));
      spy.pump();
      checkEq(GUI.getMode(), 'done', '上限到達で終局表示へ');
      checkEq(DOC.getElementById('battle-banner').className, 'draw', '引き分け横幅のクラス');
      checkEq(DOC.getElementById('banner-title').textContent, '🏆 战斗结束：平局', '引き分けタイトル');
      checkEq(DOC.getElementById('banner-body').textContent, '达到行动步数上限，未分出胜负。', '引き分け本文');
      checkEq(GUI.getBattleState().winner, 'draw', 'state の winner も draw');
    } finally {
      GE.MAX_STEPS = savedMax;
    }
    checkEq(GE.MAX_STEPS, savedMax, '9i: MAX_STEPS を復元');
    GUI.resetToConfig();
    checkEq(GUI.getMode(), 'idle', 'UI テストは idle で終わる');
    console.log('[progress] UI flow done, failures=' + failures.length);
  }
}

// ============================================================ 起動
try {
  main();
} catch (err) {
  pushFailure('FATAL: ' + String(err && err.stack ? err.stack : err).slice(0, 2000));
}
if (suppressedFailures > 0) {
  failures.push('（ほかに ' + suppressedFailures + ' 件の失敗表示を省略）');
}
console.log('RESULT ' + JSON.stringify({ assertions: assertions, failures: failures }));
process.exitCode = failures.length === 0 ? 0 : 1;
