/*
======================================================================
 丧尸 vs 人类 自动战斗器 —— GameEngine / GameUI API 文档（src/engine.js / src/ui.js）
======================================================================
■ 形態
  * 戦闘エンジンは src/engine.js にあり、window.GameEngine
    として公開する。DOM・UI・タイマーに一切依存しない純関数集合。
  * state は JSON 化可能なプレーンデータのみで構成する。公開関数は入力を
    破壊せず新しい state を返す（内部では作業コピーを書き替えるが、外部
    から見れば純関数である）。log の各エントリ {type,text} は push 以後に
    決して書き替えないため、連続する state 間で log 配列は浅いコピーとして
    共有される（エントリ自体を外部から書き替えることは想定しない）。
  * UI 層は src/ui.js にあり、window.GameUI として公開
    する。エンジンの呼び出しと DOM 描画だけを担う。

■ 乱数の注入（GameEngine）
  * d100 / d7 / ダメージ・目標選択のすべてのロールは最終引数 rng
    （() => [0,1) の乱数）を経由する。省略した場合は Math.random を使う。
  * GameEngine.createRng(seed) で mulberry32 ベースの再現可能な乱数源を
    作れる（テスト・デバッグ用）。
  * 戦闘の乱数は「1 本の乱数列」を順に消費する。したがって同一の rng を
    与えた場合、次の 2 経路は最終 state（members / order / rolls / log すべて）
    の JSON 比較で完全一致する（ADR 0001 の一貫性保証）：
      (a) GameEngine.runBattle(config, rng)                       （整場一括結算）
      (b) GameEngine.startBattle(config, rng) の後、
          GameEngine.stepBattle(state, rng) を終局まで繰り返す     （逐次実行）
    stepBattle は takeTurn と同一経路（同一の乱数消費・state 遷移）であり、
    verify/engine.test.mjs の一致性断言で固定される。

■ Node から利用する（テスト用）
  * src/engine.js を文字列として読み込み、
    例えば vm.runInNewContext(src, { module: { exports: {} } }) のように
    評価すると、module.exports から GameEngine を取得できる。
    （window が無い環境では module.exports 側に公開するため。）
  * UI 層は同じ要領で src/ui.js を評価すれば window.GameUI が
    得られる。document は最小スタブでよく、GameUI の公開面は
    実 DOM 無しで駆動できる（描画の目視検証はブラウザ E2E で行う）。

■ GameEngine API 一覧
  --- 定数・乱数・設定検査 ---
  GameEngine.MAX_STEPS                  : 無限ループ防止のステップ上限。書き換え可（既定 100000）
  GameEngine.DEFAULT_CONFIG             : 既定設定 { human: {...}, zombie: {...} }
  GameEngine.FACTION_LABEL              : 陣営表示名 { human: '人类阵营', zombie: '丧尸阵营' }
  GameEngine.NAME_PREFIX                : メンバー名の接頭辞 { human: '玩家', zombie: '丧尸' }
  GameEngine.createRng(seed)            : () => [0,1) の種付き乱数源を返す
  GameEngine.rollD(sides, rng?)         : 1..sides の整数
  GameEngine.randInt(min, max, rng?)    : min..max の整数（両端を含む）
  GameEngine.validateConfig(config)     : 設定検査。不備の簡体中文メッセージ配列（空配列なら正当）
  --- state 生成と先攻決定 ---
  GameEngine.createBattleState(config)  : 初期 state（未ダイス）を返す
  GameEngine.rollInitiative(state, rng?): d100 で先攻順を決定する。同点者はその組だけで
                                          重投を繰り返し（重投点は組内のみで比較し、
                                          組内で順位が分かるまで）、過程をログに残す。
                                          新しい state を返す
  --- 整場一括結算（従来 API・そのまま維持） ---
  GameEngine.takeTurn(state, rng?)      : 現在の行動者の行動を 1 回実行。新しい state を返す
                                          （終局済み state を渡した場合は入力をそのまま返す）
  GameEngine.runBattle(config, rng?)    : 設定検査 → state 生成 → 先攻決定 → 行動ループで
                                          完走させ、最終 state を返す（不正設定は例外）
  --- ステップ実行（逐行動リアルタイム演出用・ADR 0001） ---
  GameEngine.startBattle(config, rng?)  : 設定検査 → state 生成 → 先攻決定までを行い、
                                          開始 state を返す（runBattle の前半と同一経路。
                                          不正設定は例外）
  GameEngine.stepBattle(state, rng?)    : 行動を 1 つ実行し { state, event } を返す。
                                          takeTurn と同一の乱数消費・state 遷移で、
                                          event は演出用の観測データ（下記参照）。
                                          終局済み state を渡した場合は
                                          { state: 入力そのもの, event: null }（副作用なし）
  GameEngine.getInitiativeOrder(state)  : 行動順（state.order）のコピー配列を返す
  GameEngine.isBattleOver(state)        : 終局判定（state.finished の真偽値）
  GameEngine.getResult(state)           : 終局スナップショット
                                          { finished, winner, survivors:[{name,hp,maxHp}] }
                                          （新しいプレーンオブジェクトを返す）

■ stepBattle の event の形（演出用の観測データ。state 遷移には影響しない）
  { kind: 'skip',   actor }                     : 倒地者の番。何も起きず順序だけ進む
  { kind: 'none' }                              : 保険経路（通常発生しない）
  { kind: 'fail',   actor, target, atkRoll, attack }
  { kind: 'dodge',  actor, target, atkRoll, attack, dodgeRoll, agility }
  { kind: 'hit',    actor, target, atkRoll, attack, dodgeRoll, agility,
                    damage, hpBefore, hpAfter, downed }
  { kind: 'forced-draw' }                       : MAX_STEPS 到達による強制終了
  そのステップで終局した場合はさらに finished: true と
  winner: 'human'|'zombie'|'draw' を付す。

■ UI 層（window.GameUI）とスケジューラ注入
  演出の待ち時間はすべて注入されたスケジューラを経由する。契約：
    scheduler.setTimeout(fn, ms) → id : 後で fn を一度だけ呼ぶ
    scheduler.clearTimeout(id)        : 未実行の fn をキャンセル（同期型は no-op でよい）
    scheduler.clear()                 : （任意）未実行をすべて破棄
    scheduler.pump(limit?)            : （任意・テスト用）溜まった fn を先頭から実行
  * GameUI.createRealtimeScheduler() : window.setTimeout / clearTimeout の
                                       実時間スケジューラ（既定）
  * GameUI.createSyncScheduler()     : テスト用のポンプ式同期スケジューラ。
                                       setTimeout は溜めるだけで実行せず、
                                       pump(limit) で溜まった分を先頭から
                                       順に実行する。clear() で未実行を全廃棄
  * GameUI.useScheduler(sched)       : スケジューラ差し替え（戦闘開始前に呼ぶこと）
  公開面（DOM 無しで駆動できる）：
    GameUI.getScreen()                : 'config' | 'battle'
    GameUI.getMode()                  : 'idle'（未開戦）| 'live'（演出中）| 'done'（終局表示）
    GameUI.getSpeed() / setSpeed(key) : 'slow' | 'middle' | 'fast'（戦闘中でも切替可）
    GameUI.startBattle(config, rng?)  : 設定検査 → 開戦 → 戦場画面へ。rng 省略時は
                                        Math.random。演出中に呼ぶと例外、
                                        不正設定は例外
    GameUI.skipToResult()             : 演出中のみ有効。残り全ステップを同時通算し
                                        その場で終局表示へ移る
    GameUI.resetToConfig()            : 演出中断 → 配置画面へ（戦場・ログ・横幅を破棄、
                                        設定入力のロック解除）
    GameUI.clearLog()                 : ログ表示だけ消す（以後の追記は継続）
    GameUI.getBattleState()           : 現 state の深いコピー（未開戦は null）
    GameUI.getLogEntries()            : 表示対象ログ [{type,text}] のコピー
    GameUI.SPEEDS                     : { slow:   { label: '慢', delay: 1600 },
                                        middle: { label: '中', delay: 800 },
                                        fast:   { label: '快', delay: 300 } }

■ config / state の形
  config = {
    human:  { count, hp, attack, agility, dmgMin, dmgMax },
    zombie: { count, hp, attack, agility, dmgMin, dmgMax }
  }
  state = {
    members:  [ { name, faction: 'human'|'zombie', maxHp, hp, attack,
                  agility, dmgMin, dmgMax, downed } ... ],
    order:    [ メンバー名 ... ]（行動順。戦闘中は不変）,
    rolls:    { メンバー名: d100 出目の履歴 [第1投, 重投1, ...] },
    turnIndex, round, steps,
    finished: boolean,
    winner:   'human' | 'zombie' | 'draw' | null,
    survivors:[ { name, hp, maxHp } ... ]（勝利側の生存者）,
    log:      [ { type, text } ... ]（type: order-header / order / reroll /
                                          round / action-fail / action-dodge /
                                          action-hit / victory）
  }
======================================================================
*/

/* =====================================================================
 * 戦闘エンジン（DOM 非依存の純関数集合）
 * API の詳細と Node からの取り出し方はファイル先頭のコメント塊を参照。
 * ===================================================================== */
(function () {
  'use strict';

  // 仕様書のデフォルト値
  var DEFAULT_CONFIG = {
    human:  { count: 1, hp: 12, attack: 4, agility: 4, dmgMin: 1, dmgMax: 3 },
    zombie: { count: 1, hp: 9, attack: 5, agility: 2, dmgMin: 1, dmgMax: 5 }
  };

  // 表示用ラベル（UI 文案は簡体中文）
  var NAME_PREFIX = { human: '玩家', zombie: '丧尸' };
  var FACTION_LABEL = { human: '人类阵营', zombie: '丧尸阵营' };

  var api = {
    // 無限ループ防止の安全上限（テストから差し替え可能）
    MAX_STEPS: 100000,
    DEFAULT_CONFIG: DEFAULT_CONFIG,
    FACTION_LABEL: FACTION_LABEL,
    NAME_PREFIX: NAME_PREFIX
  };

  // ---- 乱数 ----------------------------------------------------------

  // 種付き乱数源（mulberry32）。テストでの再現用。
  api.createRng = function (seed) {
    var a = seed >>> 0;
    return function () {
      a |= 0;
      a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  };

  // rng 未指定なら Math.random を使う
  function normRng(rng) {
    return typeof rng === 'function' ? rng : Math.random;
  }

  // 1..sides の整数ダイス
  api.rollD = function (sides, rng) {
    return Math.floor(normRng(rng)() * sides) + 1;
  };

  // min..max の整数（両端を含む）
  api.randInt = function (min, max, rng) {
    return min + Math.floor(normRng(rng)() * (max - min + 1));
  };

  // ---- 設定検査 ------------------------------------------------------

  // 数値 1 項分の整数・範囲検査
  function checkInt(errors, label, name, value, min, max) {
    if (typeof value !== 'number' || !isFinite(value) || Math.floor(value) !== value) {
      errors.push(label + '的' + name + '必须是整数');
      return;
    }
    if (value < min || value > max) {
      errors.push(label + '的' + name + '必须在 ' + min + '～' + max + ' 之间');
    }
  }

  // 設定を検査し、不備のメッセージ配列を返す（空配列なら正当）
  api.validateConfig = function (config) {
    var errors = [];
    var factions = ['human', 'zombie'];
    for (var i = 0; i < factions.length; i++) {
      var f = factions[i];
      var label = FACTION_LABEL[f];
      var c = config ? config[f] : null;
      if (!c || typeof c !== 'object') {
        errors.push(label + '的配置缺失');
        continue;
      }
      checkInt(errors, label, '人数', c.count, 1, 99);
      checkInt(errors, label, 'HP', c.hp, 1, 9999);
      checkInt(errors, label, '攻击', c.attack, 0, 99);
      checkInt(errors, label, '敏捷', c.agility, 0, 99);
      checkInt(errors, label, '伤害下限', c.dmgMin, 0, 9999);
      checkInt(errors, label, '伤害上限', c.dmgMax, 0, 9999);
      if (typeof c.dmgMin === 'number' && typeof c.dmgMax === 'number'
          && isFinite(c.dmgMin) && isFinite(c.dmgMax) && c.dmgMin > c.dmgMax) {
        errors.push(label + '的伤害下限不能大于伤害上限');
      }
    }
    return errors;
  };

  // ---- state 生成 ----------------------------------------------------

  // メンバー 1 人を生成する
  function makeMember(faction, index, stats) {
    return {
      name: NAME_PREFIX[faction] + index,
      faction: faction,
      maxHp: stats.hp,
      hp: stats.hp,
      attack: stats.attack,
      agility: stats.agility,
      dmgMin: stats.dmgMin,
      dmgMax: stats.dmgMax,
      downed: false
    };
  }

  // プレーンデータの複製（state は JSON 化可能なデータのみで構成する）
  function clone(obj) {
    if (typeof structuredClone === 'function') return structuredClone(obj);
    return JSON.parse(JSON.stringify(obj));
  }

  // state の複製。log の各エントリは push 以後に決して書き替えないため、
  // log 配列は浅いコピーで共有する（ステップ実行で毎歩 clone しても
  // ログ長に比例した増幅が起きないようにするため。メンバー等は深い複製）。
  function cloneState(s) {
    return {
      members: s.members.map(function (m) { return Object.assign({}, m); }),
      order: s.order.slice(),
      rolls: clone(s.rolls),
      turnIndex: s.turnIndex,
      round: s.round,
      steps: s.steps,
      finished: s.finished,
      winner: s.winner,
      survivors: s.survivors.map(function (m) { return Object.assign({}, m); }),
      log: s.log.slice()
    };
  }

  // 初期 state を生成する（config は書き換えない）
  api.createBattleState = function (config) {
    var members = [];
    var i;
    for (i = 1; i <= config.human.count; i++) members.push(makeMember('human', i, config.human));
    for (i = 1; i <= config.zombie.count; i++) members.push(makeMember('zombie', i, config.zombie));
    return {
      members: members,   // 全メンバー（両陣営）
      order: [],          // 行動順（メンバー名の配列、戦闘中不変）
      rolls: {},          // メンバー名 → 先攻 d100 出目
      turnIndex: 0,       // order 内の現在位置
      round: 0,           // 現在のラウンド（rollInitiative で 1 になる）
      steps: 0,           // 実行済みステップ数（安全上限カウンタ）
      finished: false,
      winner: null,       // 'human' | 'zombie' | 'draw' | null
      survivors: [],      // 勝利側の生存者 [{name, hp, maxHp}]
      log: []             // {type, text} の配列
    };
  };

  // ---- 先攻順 --------------------------------------------------------

  // 全員が d100 を 1 回ずつ振り、点数の大きい順に行動する。
  // 同点者は「その組だけ」取り出して各自重投し、重投点は組内だけで比較する
  //（組と外部との前后関係は元の点数で確定済み）。組内にまだ同点者がいれば、
  // その者だけをさらに重投し、組内で完全に順位が分かるまで繰り返す。
  // 最終順序は「各メンバーが得た点数列の辞書順降順」と一致する。
  function cmpRollsDesc(a, b) {
    var n = Math.min(a.length, b.length);
    for (var i = 0; i < n; i++) {
      if (a[i] !== b[i]) return b[i] - a[i];
    }
    return b.length - a.length; // 保険（通常はここへ到達しない）
  }

  api.rollInitiative = function (state, rng) {
    var s = cloneState(state);
    var r = normRng(rng);
    var i;
    // メンバー名 → ダイス履歴 [第1投, 重投1, ...]（末尾が現在の有効値）
    var history = {};
    var names = s.members.map(function (m) { return m.name; });
    for (i = 0; i < names.length; i++) {
      history[names[i]] = [api.rollD(100, r)];
    }
    var batches = 0;
    // 同点グループの解消（group: 同じ有効値を持つメンバー名の配列）
    function resolveGroup(group) {
      if (group.length < 2) return;
      batches++;
      if (batches > 10000) {
        // 公正な乱数では実質到達不能（悪意ある rng 注入などの保険）
        throw new Error('先攻重投超过安全次数上限');
      }
      var anchor = history[group[0]][history[group[0]].length - 1];
      group.forEach(function (n) { history[n].push(api.rollD(100, r)); });
      s.log.push({
        type: 'reroll',
        text: '【先攻重投】' + group.join('、') + '（同为 ' + anchor + ' 点）重投 d100：'
            + group.map(function (n) {
                var h = history[n];
                return n + '→' + h[h.length - 1];
              }).join('、')
      });
      // 重投後にまだ同点が残れば、その者だけで再重投
      var byValue = {};
      group.forEach(function (n) {
        var h = history[n];
        var v = h[h.length - 1];
        (byValue[v] = byValue[v] || []).push(n);
      });
      Object.keys(byValue)
        .sort(function (a, b) { return b - a; })
        .forEach(function (v) { resolveGroup(byValue[v]); });
    }
    // 第 1 投の点数でグループ化し、点数の大きい組から順に解消
    var byFirst = {};
    names.forEach(function (n) {
      var v = history[n][0];
      (byFirst[v] = byFirst[v] || []).push(n);
    });
    Object.keys(byFirst)
      .sort(function (a, b) { return b - a; })
      .forEach(function (v) { resolveGroup(byFirst[v]); });
    // 辞書順降順で最終行動順を確定
    names.sort(function (a, b) { return cmpRollsDesc(history[a], history[b]); });
    s.order = names;
    s.rolls = history;
    s.round = 1;
    s.turnIndex = 0;
    s.log.push({ type: 'order-header', text: '【行动顺序】（d100 点数，从大到小）' });
    for (i = 0; i < names.length; i++) {
      s.log.push({
        type: 'order',
        text: (i + 1) + '. ' + names[i] + '（d100=' + history[names[i]].join('→') + '）'
      });
    }
    s.log.push({ type: 'round', text: '── 第 1 轮 ──' });
    return s;
  };

  // ---- ターン処理 ----------------------------------------------------

  // 名前からメンバーを探す
  function findMember(s, name) {
    for (var i = 0; i < s.members.length; i++) {
      if (s.members[i].name === name) return s.members[i];
    }
    return null;
  }

  // ターン位置を 1 つ進める。末尾に達したら次ラウンドの先頭へ戻し、区切り行を残す。
  function advanceTurn(s) {
    s.turnIndex++;
    if (s.turnIndex >= s.order.length) {
      s.turnIndex = 0;
      s.round++;
      s.log.push({ type: 'round', text: '── 第 ' + s.round + ' 轮 ──' });
    }
  }

  // どちらか一方でも全滅していれば戦闘を終了させる
  function checkBattleEnd(s) {
    var alive = { human: false, zombie: false };
    for (var i = 0; i < s.members.length; i++) {
      var m = s.members[i];
      if (!m.downed) alive[m.faction] = true;
    }
    if (alive.human && alive.zombie) return false;
    s.finished = true;
    s.winner = alive.human ? 'human' : (alive.zombie ? 'zombie' : 'draw');
    if (s.winner === 'draw') {
      s.survivors = [];
      s.log.push({ type: 'victory', text: '战斗结束：平局。' });
    } else {
      s.survivors = s.members
        .filter(function (m) { return m.faction === s.winner && !m.downed; })
        .map(function (m) { return { name: m.name, hp: m.hp, maxHp: m.maxHp }; });
      var names = s.survivors.map(function (m) {
        return m.name + '（HP ' + m.hp + '/' + m.maxHp + '）';
      }).join('、');
      s.log.push({ type: 'victory', text: '战斗结束：' + FACTION_LABEL[s.winner] + '获胜！存活角色：' + names });
    }
    return true;
  }

  // 現在の行動者の 1 行動を実行する（s を直接書き換える内部用関数）。
  // ev を渡した場合は演出用の観測データ（event）をここに記録する。
  // ev は state 遷移・乱数消費に一切影響しない。
  function stepMutate(s, rng, ev) {
    s.steps++;
    if (s.steps > api.MAX_STEPS) {
      s.finished = true;
      s.winner = 'draw';
      s.survivors = [];
      s.log.push({ type: 'victory', text: '已达 ' + api.MAX_STEPS + ' 步行动上限，强制结束：平局。' });
      if (ev) ev.kind = 'forced-draw';
      return;
    }
    var actorName = s.order[s.turnIndex];
    var actor = findMember(s, actorName);
    // 倒地している場合は何もせずスキップ（ログには残さない）
    if (!actor || actor.downed) {
      if (ev) { ev.kind = 'skip'; ev.actor = actorName; }
      advanceTurn(s);
      return;
    }
    // 対立陣営の未倒地メンバーから無作為に 1 人選ぶ
    var enemyFaction = actor.faction === 'human' ? 'zombie' : 'human';
    var targets = s.members.filter(function (m) {
      return m.faction === enemyFaction && !m.downed;
    });
    if (targets.length === 0) {
      // 通常起こらない（直前の行動後に終了判定済み）。保険として終了判定だけ行う。
      if (ev) ev.kind = 'none';
      checkBattleEnd(s);
      return;
    }
    var target = targets[api.randInt(0, targets.length - 1, rng)];
    var head = actor.name + ' → ' + target.name + '：';

    // 1) 攻撃判定：d7 ＞ 自分の攻撃値 なら失敗
    var atkRoll = api.rollD(7, rng);
    if (atkRoll > actor.attack) {
      s.log.push({
        type: 'action-fail',
        text: head + '攻击检定 d7=' + atkRoll + ' ＞ 攻击' + actor.attack + '，攻击失败'
      });
      if (ev) {
        ev.kind = 'fail';
        ev.actor = actor.name; ev.target = target.name;
        ev.atkRoll = atkRoll; ev.attack = actor.attack;
      }
      advanceTurn(s);
      return;
    }

    // 2) 回避判定：d7 ≤ 目標の敏捷 なら回避成功
    var dodgeRoll = api.rollD(7, rng);
    if (dodgeRoll <= target.agility) {
      s.log.push({
        type: 'action-dodge',
        text: head + '攻击检定 d7=' + atkRoll + ' ≤ 攻击' + actor.attack
            + '，命中；闪避检定 d7=' + dodgeRoll + ' ≤ 敏捷' + target.agility + '，闪避成功'
      });
      if (ev) {
        ev.kind = 'dodge';
        ev.actor = actor.name; ev.target = target.name;
        ev.atkRoll = atkRoll; ev.attack = actor.attack;
        ev.dodgeRoll = dodgeRoll; ev.agility = target.agility;
      }
      advanceTurn(s);
      return;
    }

    // 3) ダメージ：自身の区間内の整数乱数
    var dmg = api.randInt(actor.dmgMin, actor.dmgMax, rng);
    var hpBefore = target.hp;
    target.hp = Math.max(0, target.hp - dmg);
    var text = head + '攻击检定 d7=' + atkRoll + ' ≤ 攻击' + actor.attack
             + '，命中；闪避检定 d7=' + dodgeRoll + ' ＞ 敏捷' + target.agility
             + '，未闪避；伤害 ' + dmg + '，' + target.name + ' 剩余 HP ' + target.hp;
    if (target.hp <= 0) {
      target.downed = true;
      text += '，倒地！';
    }
    s.log.push({ type: 'action-hit', text: text });
    if (ev) {
      ev.kind = 'hit';
      ev.actor = actor.name; ev.target = target.name;
      ev.atkRoll = atkRoll; ev.attack = actor.attack;
      ev.dodgeRoll = dodgeRoll; ev.agility = target.agility;
      ev.damage = dmg; ev.hpBefore = hpBefore; ev.hpAfter = target.hp;
      ev.downed = target.downed;
    }

    // 行動後に行終了判定（終わっていなければ次のターンへ）
    if (!checkBattleEnd(s)) {
      advanceTurn(s);
    }
  }

  // 公開版：入力 state を破壊せず、新しい state を返す
  api.takeTurn = function (state, rng) {
    if (state.finished) return state;
    var s = cloneState(state);
    stepMutate(s, normRng(rng), null);
    return s;
  };

  // 設定から戦闘を完走させる（不正設定は例外）
  api.runBattle = function (config, rng) {
    var errors = api.validateConfig(config);
    if (errors.length > 0) throw new Error(errors.join('；'));
    var r = normRng(rng);
    var s = api.rollInitiative(api.createBattleState(config), r);
    while (!s.finished) stepMutate(s, r);
    return s;
  };

  // ---- ステップ実行 API（逐行動リアルタイム演出用・ADR 0001） --------
  // runBattle / takeTurn と同一の内部経路を使うため、同一 rng なら
  // 逐次実行と整場一括結算の結果は完全一致する（先頭コメント塊参照）。

  // 設定検査 → 初期 state 生成 → 先攻決定 までを行い、開始 state を返す。
  // runBattle の前半と完全に同じ経路（不正設定は例外）。
  api.startBattle = function (config, rng) {
    var errors = api.validateConfig(config);
    if (errors.length > 0) throw new Error(errors.join('；'));
    return api.rollInitiative(api.createBattleState(config), normRng(rng));
  };

  // ステップ実行版 takeTurn：1 行動を実行し { state, event } を返す。
  // takeTurn と同一の乱数消費・state 遷移。event は観測専用。
  // 終局済み state を渡した場合は何もせず { state: 入力, event: null } を返す。
  api.stepBattle = function (state, rng) {
    if (state.finished) return { state: state, event: null };
    var s = cloneState(state);
    var ev = {};
    stepMutate(s, normRng(rng), ev);
    if (s.finished) {
      ev.finished = true;
      ev.winner = s.winner;
    }
    return { state: s, event: ev };
  };

  // 行動順のコピーを返す（外部に state.order の生参照を見せないための補助）
  api.getInitiativeOrder = function (state) {
    return state.order.slice();
  };

  // 終局判定（真偽値化しただけの補助）
  api.isBattleOver = function (state) {
    return !!state.finished;
  };

  // 終局スナップショット：新しいプレーンオブジェクトを返す
  api.getResult = function (state) {
    return {
      finished: !!state.finished,
      winner: state.winner || null,
      survivors: (state.survivors || []).map(function (m) {
        return { name: m.name, hp: m.hp, maxHp: m.maxHp };
      })
    };
  };

  // ---- エクスポート --------------------------------------------------
  if (typeof window !== 'undefined') {
    window.GameEngine = api;
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  return api;
})();
