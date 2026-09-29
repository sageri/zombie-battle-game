// ======================================================================
// 丧尸 vs 人类 自動バトラー — 戦闘エンジン決定論テスト
//
// 実行方法:
//   node verify/engine.test.mjs
//
// * Node 組み込み機能のみ使用（サードパーティ依存ゼロ）。
// * index.html は読み込むだけで、一切書き換えない。
// * index.html から <script> を抽出し、最小 DOM スタブ（Proxy の偽要素:
//   addEventListener / querySelector / value / textContent / innerHTML 等
//   を飲み込む）上でサンドボックス評価し、window.GameEngine を取得する。
// * 検証は 2 本立て:
//   (a) スクリプト済み乱数列（RngScript）による境界テスト
//       （先攻同点の重投、攻撃/回避の d7 境界、伤害区間、倒地とスキップ、
//        終局と勝者表示、純関数性、同一シード再現性）
//   (b) GameEngine.createRng(seed) による 223 戦のストレス試験と
//       ログ全面再生（HP 収支・ダイス境界・重投整合・行動数の有界性）
//
// 出力: 最終行に必ず RESULT {"assertions":N,"failures":[...]} を出す。
//       全件パスなら exit 0、失敗があれば exit 1。
//
// 仕様参照: index.html 冒頭の GameEngine API コメント塊（2〜61 行目）と
//           実装本体 script#game-engine（154〜514 行目）。
// ======================================================================
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const INDEX_HTML_PATH = path.resolve(here, '..', 'index.html');

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
// 引擎の公表セマンティクス（index.html 200〜207 行目の実装）:
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
// UI 側 <script> の評価を通すためのもので、エンジン自身は DOM に触れない。
function makeFakeElement(tag, id) {
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
    appendChild(child) { store.children.push(child); return child; },
    insertBefore(child) { return child; },
    removeChild() { return null; },
    querySelector() { return makeFakeElement('div'); },
    querySelectorAll() { return []; },
    setAttribute() {},
    getAttribute() { return null; },
    removeAttribute() {},
    focus() {}, blur() {}, click() {},
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    contains() { return false; },
    getBoundingClientRect() { return { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }; },
  };
  return new Proxy(store, {
    get(_t, prop) {
      if (typeof prop === 'symbol') return undefined;
      if (prop in store) return store[prop];
      if (prop in generic) return generic[prop];
      return undefined;
    },
    set(_t, prop, value) {
      if (typeof prop !== 'symbol') store[prop] = value;
      return true;
    },
  });
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
    createElement(tag) { return makeFakeElement(tag); },
    createDocumentFragment() { return makeFakeElement('#document-fragment'); },
    addEventListener() {},
    body: makeFakeElement('body'),
    documentElement: makeFakeElement('html'),
  };
}

// -------------------------------- index.html から GameEngine を取出す
function extractScripts(html) {
  const engineScripts = [];
  const otherScripts = [];
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    if (/\bid\s*=\s*["']?game-engine/i.test(m[1] || '')) engineScripts.push(m[2]);
    else otherScripts.push(m[2]);
  }
  return { engineScripts, otherScripts };
}

function loadGameEngine(html) {
  const { engineScripts, otherScripts } = extractScripts(html);
  checkEq(engineScripts.length, 1, 'script#game-engine は 1 個ある');
  const doc = makeDocumentStub();
  const sandbox = {
    window: { document: doc },
    document: doc,
    module: { exports: {} },
    console: { log() {}, warn() {}, error() {} },
  };
  vm.createContext(sandbox);
  for (const src of engineScripts) {
    vm.runInContext(src, sandbox, { filename: 'index.html#game-engine' });
  }
  // UI 側 <script> もスタブ DOM 上で評価を通す（エンジン評価の後）
  otherScripts.forEach((src, i) => {
    vm.runInContext(src, sandbox, { filename: 'index.html#inline-' + i });
  });
  const GE = sandbox.window.GameEngine || sandbox.module.exports;
  check(!!GE, 'window.GameEngine（または module.exports）が公開されている');
  return GE;
}

// ------------------------------------------- ログ書式リテラルの裏取り
// 正規表現に埋め込る書式断片は、index.html の実装（449〜479 行目等）から
// 採取したリテラル。html 内に実在しない断片を使っていたら、実装でなく
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
};
function checkLogLiterals(html) {
  for (const k of Object.keys(LOG_LITERALS)) {
    check(html.includes(LOG_LITERALS[k]),
      'ログ書式リテラル「' + LOG_LITERALS[k] + '」が index.html に実在する（' + k + '）');
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
  '^(\\d+)\\. (.+?)' + esc('（d100=') + '([\\d→]+)' + esc('）') + '$');
const RE_REROLL = new RegExp(
  '^' + esc('【先攻重投】') + '(.+?)' + esc('（同为 ') + '(\\d+)'
  + esc(' 点）重投 d100：') + '(.+)$');
const RE_REROLL_PAIR = new RegExp('^(.+?)' + esc('→') + '(\\d+)$');
const RE_ROUND = new RegExp('^' + esc('── 第 ') + '(\\d+)' + esc(' 轮 ──') + '$');

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

let GE = null;

// ------------------------------------------------ state 生成ヘルパ
// 既定設定に上書きをマージし、先攻 d100 を制御した初期 state を作る。
// rolls を指定しなければ first 側が 90,89…、もう一方は 40,39…（同点なし）。
function makeState(opts) {
  const human = { ...GE.DEFAULT_CONFIG.human, ...(opts.human || {}) };
  const zombie = { ...GE.DEFAULT_CONFIG.zombie, ...(opts.zombie || {}) };
  const cfg = { human, zombie };
  let s = GE.createBattleState(cfg);
  const hRolls = opts.humanRolls
    || Array.from({ length: human.count }, (_, i) => (opts.first === 'human' ? 90 - i : 40 - i));
  const zRolls = opts.zombieRolls
    || Array.from({ length: zombie.count }, (_, i) => (opts.first === 'zombie' ? 90 - i : 40 - i));
  const rs = new RngScript();
  for (const v of hRolls) rs.pushDie(v, 100);
  for (const v of zRolls) rs.pushDie(v, 100);
  s = GE.rollInitiative(s, rs.rng);
  checkEq(rs.used, hRolls.length + zRolls.length, 'makeState: 先攻ダイスは人数分だけ消費');
  return { state: s, cfg };
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

  // 再生用: name → 陣営設定由来の初期値
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
    };
  }

  let lastRoundNo = 0;
  let actionCount = 0;
  let victoryCount = 0;
  let afterVictory = false;
  const orderParsed = []; // {name, history}
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
        check(!!m, label + ': order 行の書式: ' + e.text);
        if (m) {
          checkEq(Number(m[1]), orderParsed.length + 1, label + ': order 行番号は連番');
          const history = m[3].split('→').map(Number);
          check(history.length >= 1 && history.every(v => v >= 1 && v <= 100),
            label + ': d100 出目は 1..100: ' + m[2]);
          orderParsed.push({ name: m[2], history });
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
    rerollTexts.length + 1 + n + lastRoundNo + actionCount + victoryCount,
    label + ': ログ全行が分類し切れている（行数の帳尻）');

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
  const html = readFileSync(INDEX_HTML_PATH, 'utf8');
  checkLogLiterals(html);

  GE = loadGameEngine(html);
  if (!GE) throw new Error('GameEngine を取得できなかったため、以降の検証を継続できない');

  // --- API 表面（先頭コメント 25〜41 行目の公表 API） ---
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
    checkEq(s.order, [], '初期 state の order は空');
    checkEq(s.rolls, {}, '初期 state の rolls は空');
    checkEq(s.finished, false, '初期 state の finished');
    checkEq(s.winner, null, '初期 state の winner');
  }
  {
    // 人数 0 は不可（開戦時 各陣営 1 人以上）
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
  }
  console.log('[progress] defaults/validate done, failures=' + failures.length);

  // --- 純関数性と同一シード再現性 ---
  {
    const cfg = deepCopy(GE.DEFAULT_CONFIG);
    cfg.human.count = 2; cfg.zombie.count = 2;
    const cfgSnap = JSON.stringify(cfg);
    const st0 = GE.createBattleState(cfg);
    checkEq(JSON.stringify(cfg), cfgSnap, 'createBattleState は config を破壊しない');
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
    let s = GE.rollInitiative(GE.createBattleState(cfg), rng);
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
