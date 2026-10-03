/* =====================================================================
 * UI 層：GameEngine の呼び出しと DOM 描画だけを担う（エンジン側は
 * DOM に触れない）。演出の待ち時間はすべて注入されたスケジューラを
 * 経由する（既定は実時間、テストは GameUI.createSyncScheduler() で
 * ポンプ式同期スケジューラに差し替える）。
 * テスト用の公開面（GameUI）は src/engine.js 冒頭のコメント塊を参照。
 * ===================================================================== */
(function () {
  'use strict';
  var E = window.GameEngine;

  function $(id) { return document.getElementById(id); }

  // ---- 定数 ----------------------------------------------------------

  // 設定フィールド定義（入力欄の生成と入力値の読み取りに使う）。
  // 人数上限は 9×9=81 マスに収まる 36（エンジンの validateConfig と一致）
  var FIELDS = [
    { key: 'count',   label: '人数',     min: 1,    max: 36 },
    { key: 'hp',      label: 'HP',      min: 1,    max: 9999 },
    { key: 'attack',  label: '攻击',    min: 0,    max: 99 },
    { key: 'agility', label: '敏捷',    min: 0,    max: 99 },
    { key: 'dmgMin',  label: '伤害下限', min: 0,    max: 9999 },
    { key: 'dmgMax',  label: '伤害上限', min: 0,    max: 9999 }
  ];
  var FACTIONS = ['human', 'zombie'];

  // Emoji 美術（人類 / 丧尸 / 倒地 / 勝者）
  var UNIT_EMOJI = { human: '🧑', zombie: '🧟' };
  var DOWNED_EMOJI = '💀';
  var WIN_EMOJI = '🏆';

  // 速度 3 段階（1 ステップあたりの演出待ち時間 ms）
  var SPEEDS = {
    slow:   { label: '慢', delay: 1600 },
    middle: { label: '中', delay: 800 },
    fast:   { label: '快', delay: 300 }
  };
  var SPEED_ORDER = ['slow', 'middle', 'fast'];

  // ---- スケジューラ --------------------------------------------------
  // 既定: 実時間。テストは createSyncScheduler()（ポンプ式）へ差し替える。
  function createRealtimeScheduler() {
    return {
      setTimeout: function (fn, ms) { return window.setTimeout(fn, ms); },
      clearTimeout: function (id) { window.clearTimeout(id); }
    };
  }
  // 同期スケジューラ: setTimeout は溜めるだけで実行しない。pump(limit) で
  // 溜まった分を先頭から実行する（再帰でなくループなので長い戦闘でも安全）。
  // setTimeout は取り消し可能なトークンを返し、clearTimeout(id) でキューから
  // 抜ける（速度切替時の張り直しが同期型でも正しく機能するように）。
  function createSyncScheduler() {
    var queue = [];
    return {
      setTimeout: function (fn) {
        var token = { fn: fn };
        queue.push(token);
        return token;
      },
      clearTimeout: function (id) {
        var idx = queue.indexOf(id);
        if (idx >= 0) queue.splice(idx, 1);
      },
      pump: function (limit) {
        var n = 0;
        limit = (typeof limit === 'number') ? limit : Infinity;
        while (queue.length > 0 && n < limit) {
          var token = queue.shift();
          n++;
          token.fn();
        }
        return n;
      },
      clear: function () { var n = queue.length; queue.length = 0; return n; },
      size: function () { return queue.length; }
    };
  }
  var scheduler = createRealtimeScheduler();

  // ---- UI 状態 -------------------------------------------------------
  var screen = 'config';    // 'config' | 'battle'
  var mode = 'idle';        // idle: 未開戦 / live: 演出中 / done: 終局表示中
  var speedKey = 'middle';
  var state = null;         // 現在のエンジン state（未開戦は null）
  var rng = null;           // null なら Math.random（エンジン既定）
  var battleGen = 0;        // 戦闘ごとの代号（開戦/リセットで++、过期回调の無効化）
  var pendingTimer = null;  // 予約済みの次ステップ
  var renderedLogCount = 0; // 画面に描画済みの log 先頭数（追記描画用）
  var cardRefs = {};        // 名前 → { card, emoji, fill, float }
  var chipRefs = {};        // 名前 → { chip, emoji }

  // ---- 戦場グリッド定数 ----------------------------------------------
  // CSS 側（.grid-cell / .unit-card の 64px）と必ず一致させること
  var GRID_SIZE = 9;        // 一辺のマス数（エンジンの 9×9 と一致）
  var CELL_PX = 64;         // 1 マスの辺長 px（#16 規格: 64px 固定）

  // ---- 小道具 --------------------------------------------------------

  function setConfigEnabled(enabled) {
    FACTIONS.forEach(function (f) {
      FIELDS.forEach(function (fd) {
        $(f + '-' + fd.key).disabled = !enabled;
      });
    });
    $('config-placement').disabled = !enabled; // 初期站位も全局設定として一緒にロック
    $('btn-start').disabled = !enabled;
  }

  function showScreen(name) {
    screen = name;
    $('config-screen').hidden = name !== 'config';
    $('battle-screen').hidden = name !== 'battle';
  }

  // 名前から現在 state のメンバーを探す
  function memberByName(name) {
    if (!state) return null;
    for (var i = 0; i < state.members.length; i++) {
      if (state.members[i].name === name) return state.members[i];
    }
    return null;
  }

  // ---- 設定パネル ----------------------------------------------------

  // 両陣営の設定入力欄を組み立てる
  function buildConfigPanel() {
    var wrap = $('faction-configs');
    FACTIONS.forEach(function (f) {
      var fs = document.createElement('fieldset');
      fs.className = 'faction ' + f;
      var legend = document.createElement('legend');
      legend.textContent = E.FACTION_LABEL[f];
      fs.appendChild(legend);
      FIELDS.forEach(function (fd) {
        var label = document.createElement('label');
        label.className = 'field';
        var name = document.createElement('span');
        name.textContent = fd.label;
        var input = document.createElement('input');
        input.type = 'number';
        input.id = f + '-' + fd.key;
        input.min = String(fd.min);
        input.max = String(fd.max);
        input.step = '1';
        input.value = String(E.DEFAULT_CONFIG[f][fd.key]);
        label.appendChild(name);
        label.appendChild(input);
        fs.appendChild(label);
      });
      wrap.appendChild(fs);
    });
  }

  // 入力欄から設定値を集める（placement は全局セレクトから）
  function readConfig() {
    var cfg = {};
    cfg.placement = $('config-placement').value;
    FACTIONS.forEach(function (f) {
      var c = {};
      FIELDS.forEach(function (fd) {
        c[fd.key] = Number($(f + '-' + fd.key).value);
      });
      cfg[f] = c;
    });
    return cfg;
  }

  // ---- 戦場（9×9 グリッド）の描画 ------------------------------------

  // マス座標 → カードの transform（translate で滑り移動を表現）。
  // CELL_PX は CSS の .grid-cell / .unit-card と必ず一致させる
  function transformFor(pos) {
    return 'translate(' + (pos.col - 1) * CELL_PX + 'px, ' + (pos.row - 1) * CELL_PX + 'px)';
  }

  // 戦場を一度だけ組み立てる: 81 マス＋全カード（以後は updateCards で更新）。
  // カードはマスの中に絶対配置し、transform の遷移で滑り移動する。
  // 子序は凍結面: [0]emoji [1]血条 [2]飄字層。名前は末尾 [3] に追加する
  // （#16 規格: 名前常顯。4 字超は CSS 側で省略記号に丸める）
  function buildCards() {
    cardRefs = {};
    var grid = $('battle-grid');
    grid.innerHTML = '';
    for (var r = 1; r <= GRID_SIZE; r++) {
      for (var c = 1; c <= GRID_SIZE; c++) {
        var cell = document.createElement('div');
        cell.className = 'grid-cell' + ((r + c) % 2 === 0 ? ' alt' : '');
        grid.appendChild(cell);
      }
    }
    for (var i = 0; i < state.members.length; i++) {
      var m = state.members[i];
      var card = document.createElement('div');
      card.className = 'unit-card ' + m.faction;
      card.id = 'card-' + m.name;
      var emoji = document.createElement('div');
      emoji.className = 'unit-emoji';
      var bar = document.createElement('div');
      bar.className = 'hp-bar';
      var fill = document.createElement('div');
      fill.className = 'hp-fill';
      bar.appendChild(fill);
      var floatLayer = document.createElement('div');
      floatLayer.className = 'float-layer';
      var name = document.createElement('div');
      name.className = 'unit-name';
      name.textContent = m.name;
      card.appendChild(emoji);
      card.appendChild(bar);
      card.appendChild(floatLayer);
      card.appendChild(name);
      // DOM 挿入前に初期位置を確定させる（原点からの遷移演出を避ける）
      card.style.transform = transformFor(m.pos);
      card.title = m.name;
      grid.appendChild(card);
      cardRefs[m.name] = { card: card, emoji: emoji, fill: fill, float: floatLayer };
    }
    updateCards();
  }

  // 現在 state に合わせてカード（Emoji・血条・位置・倒地状態）を更新する。
  // 倒地カードはグリッドから即時除去（表示のみ消し、順序帯は灰化 💀 を保つ）
  function updateCards() {
    if (!state) return;
    for (var i = 0; i < state.members.length; i++) {
      var m = state.members[i];
      var r = cardRefs[m.name];
      if (!r) continue;
      r.emoji.textContent = m.downed ? DOWNED_EMOJI : UNIT_EMOJI[m.faction];
      var pct = Math.max(0, Math.min(100, (m.hp / m.maxHp) * 100));
      r.fill.style.width = pct + '%';
      if (m.pos) r.card.style.transform = transformFor(m.pos);
      if (m.downed) r.card.classList.add('downed');
      else r.card.classList.remove('downed');
    }
  }

  // 順序帯のチップを一度だけ組み立てる
  function buildStrip() {
    chipRefs = {};
    var strip = $('order-strip');
    strip.innerHTML = '';
    for (var i = 0; i < state.order.length; i++) {
      var name = state.order[i];
      var chip = document.createElement('div');
      chip.className = 'chip';
      chip.id = 'chip-' + name;
      var emoji = document.createElement('div');
      emoji.className = 'chip-emoji';
      var nm = document.createElement('div');
      nm.className = 'chip-name';
      nm.textContent = name;
      chip.appendChild(emoji);
      chip.appendChild(nm);
      strip.appendChild(chip);
      chipRefs[name] = { chip: chip, emoji: emoji };
    }
  }

  // 順序帯を更新する（activeName: 現在の行動者。null なら強調なし）
  function updateStrip(activeName) {
    if (!state) return;
    for (var i = 0; i < state.order.length; i++) {
      var name = state.order[i];
      var r = chipRefs[name];
      if (!r) continue;
      var m = memberByName(name);
      if (!m) continue;
      r.emoji.textContent = m.downed ? DOWNED_EMOJI : UNIT_EMOJI[m.faction];
      if (m.downed) r.chip.classList.add('downed');
      else r.chip.classList.remove('downed');
      if (name === activeName && !state.finished) r.chip.classList.add('active');
      else r.chip.classList.remove('active');
    }
  }

  // 現在の行動者を戦場カードの橙色枠でも示す（順序帯強調の同源マーカー）
  function setCurrentMarker(name) {
    for (var key in cardRefs) {
      if (Object.prototype.hasOwnProperty.call(cardRefs, key)) {
        var r = cardRefs[key];
        if (key === name) r.card.classList.add('current');
        else r.card.classList.remove('current');
      }
    }
  }

  // すべての飘字レイヤーを空にする（各ステップの描画前に呼ぶ。
  // 計時器で個別削除せず、次のステップで置き換える方式）
  function clearFloats() {
    for (var key in cardRefs) {
      if (Object.prototype.hasOwnProperty.call(cardRefs, key)) {
        cardRefs[key].float.innerHTML = '';
      }
    }
  }

  // 名前のカード頭上に飘字を追加する
  function floatOn(name, text, cls) {
    var r = cardRefs[name];
    if (!r) return;
    var span = document.createElement('span');
    span.className = 'float-text ' + cls;
    span.textContent = text;
    r.float.appendChild(span);
  }

  // 被弾カードに赤フラッシュ + 揺れのアニメをかける（再始動のため強制リフロー）
  function flashCard(name) {
    var r = cardRefs[name];
    if (!r) return;
    r.card.classList.remove('hit-flash');
    void r.card.offsetWidth;
    r.card.classList.add('hit-flash');
  }

  // ---- 戦闘ログ ------------------------------------------------------

  // まだ描画していないログ行だけを追記し、最下部へ自動スクロールする
  function appendLog() {
    if (!state || renderedLogCount >= state.log.length) return;
    var box = $('battle-log');
    var frag = document.createDocumentFragment();
    for (var i = renderedLogCount; i < state.log.length; i++) {
      var e = state.log[i];
      var div = document.createElement('div');
      div.className = 'log-' + e.type;
      div.textContent = e.text;
      frag.appendChild(div);
    }
    renderedLogCount = state.log.length;
    box.appendChild(frag);
    box.scrollTop = box.scrollHeight;
  }

  // 一键清空：表示だけ消す。演出中なら以後の行動ログをそのまま追記し続ける
  function clearLog() {
    $('battle-log').innerHTML = '';
    renderedLogCount = state ? state.log.length : 0;
  }

  // ---- 終局バナー ----------------------------------------------------

  function renderBanner() {
    var snap = E.getResult(state);
    var title = $('banner-title');
    var body = $('banner-body');
    var banner = $('battle-banner');
    if (snap.winner === 'draw') {
      banner.className = 'draw';
      title.textContent = WIN_EMOJI + ' 战斗结束：平局';
      body.textContent = '达到行动步数上限，未分出胜负。';
    } else {
      banner.className = '';
      title.textContent = WIN_EMOJI + ' 战斗结束 —— ' + E.FACTION_LABEL[snap.winner] + '获胜！';
      var lines = snap.survivors.map(function (m) {
        return m.name + '：剩余 HP ' + m.hp + '/' + m.maxHp;
      });
      body.textContent = lines.length > 0 ? lines.join('\n') : '（无存活角色）';
    }
    banner.hidden = false;
  }

  // ---- スケジューリング ----------------------------------------------

  // 次ステップを予約する（gen で过期回调を無効化）
  function scheduleNext(delay) {
    var gen = battleGen;
    pendingTimer = scheduler.setTimeout(function () {
      pendingTimer = null;
      if (gen === battleGen && mode === 'live') doStep();
    }, delay);
  }

  // 予約済みの次ステップを取り消す（実時間: clearTimeout / 同期: clear）
  function cancelPending() {
    if (pendingTimer !== null) {
      if (typeof scheduler.clearTimeout === 'function') scheduler.clearTimeout(pendingTimer);
      pendingTimer = null;
    }
    if (typeof scheduler.clear === 'function') scheduler.clear();
  }

  // ---- 演出ループ ----------------------------------------------------

  // 1 ステップ = エンジンの 1 行動をその場で結算し、その結果を演出する
  function doStep() {
    if (mode !== 'live' || !state) return;
    var res = E.stepBattle(state, rng);
    state = res.state;
    if (!res.event) {
      // 終局済み state を踏んだ場合の保険（通常到達しない）
      finishBattle();
      return;
    }
    applyEvent(res.event);
    if (state.finished) {
      finishBattle();
    } else {
      scheduleNext(SPEEDS[speedKey].delay);
    }
  }

  // 1 ステップ分の結算結果を画面へ反映する（飄字・アニメ・血条・順序帯・ログ）。
  // move は updateCards の transform 更新だけで滑り移動が表現され、
  // blocked はカードの動きなしでログだけが残る（いずれも通常の速度遅延で進む）
  function applyEvent(ev) {
    clearFloats();
    updateCards();
    var activeName = ev.actor || null;
    updateStrip(activeName);
    setCurrentMarker(activeName);
    if (ev.kind === 'fail') {
      floatOn(ev.actor, 'd7=' + ev.atkRoll + ' 攻击失手', 'float-info');
    } else if (ev.kind === 'dodge') {
      floatOn(ev.target, 'd7=' + ev.dodgeRoll + ' 闪避成功', 'float-info');
    } else if (ev.kind === 'hit') {
      floatOn(ev.actor, 'd7=' + ev.atkRoll + ' 命中', 'float-info');
      floatOn(ev.target, '-' + ev.damage + (ev.downed ? ' 倒地' : ''), 'float-damage');
      flashCard(ev.target);
    } else if (ev.kind === 'move') {
      floatOn(ev.actor, '移动', 'float-info');
    } else if (ev.kind === 'blocked') {
      floatOn(ev.actor, '无法移动', 'float-info');
    }
    appendLog();
  }

  // 終局表示へ移る（順序帯の強調を外し、横幅を出す）
  function finishBattle() {
    mode = 'done';
    pendingTimer = null;
    updateCards();
    updateStrip(null);
    setCurrentMarker(null);
    clearFloats();
    $('btn-skip').disabled = true;
    appendLog();
    renderBanner();
  }

  // ---- 公開操作 ------------------------------------------------------

  // 開戦：検査 → エンジンで開始 state 生成 → 戦場画面へ → 最初のステップを予約
  function startBattle(config, rngOpt) {
    if (mode === 'live') throw new Error('演出进行中，请先重置再开战');
    var errors = E.validateConfig(config);
    if (errors.length > 0) throw new Error(errors.join('；'));
    cancelPending();
    battleGen++;
    rng = (typeof rngOpt === 'function') ? rngOpt : null;
    state = E.startBattle(config, rng);   // rng null → エンジン既定の Math.random
    setConfigEnabled(false);              // 開戦後は配置をロック（画面遷移と二重の保険）
    renderedLogCount = 0;
    $('battle-log').innerHTML = '';
    $('battle-banner').hidden = true;
    $('btn-skip').disabled = false;
    buildCards();
    buildStrip();
    showScreen('battle');
    mode = 'live';
    appendLog();
    // 開戦直後は 1 拍置いてから最初の行動へ（阵容と順序帯を一望させる）
    var firstName = state.order[state.turnIndex];
    updateStrip(firstName);
    setCurrentMarker(firstName);
    scheduleNext(SPEEDS[speedKey].delay);
  }

  // 跳到结果：残り全ステップを同時通算して終局へ（同一乱数列なので
  // そのまま見続けた場合と完全に同じ終局になる）
  function skipToResult() {
    if (mode !== 'live' || !state) return;
    cancelPending();
    battleGen++;
    while (!state.finished) {
      var res = E.stepBattle(state, rng);
      state = res.state;
    }
    finishBattle();
  }

  // リセット：演出中断 → 配置画面へ（上一戦の战场・日志・横幅を破棄）
  function resetToConfig() {
    cancelPending();
    battleGen++;
    mode = 'idle';
    state = null;
    rng = null;
    renderedLogCount = 0;
    cardRefs = {};
    chipRefs = {};
    $('battle-grid').innerHTML = '';
    $('order-strip').innerHTML = '';
    $('battle-log').innerHTML = '';
    $('battle-banner').hidden = true;
    $('banner-title').textContent = '';
    $('banner-body').textContent = '';
    $('config-error').textContent = '';
    setConfigEnabled(true);
    showScreen('config');
  }

  // 速度切替（戦闘中でも可）。予約済みの次ステップは新 delay で張り直す
  function setSpeed(key) {
    if (!SPEEDS[key]) return;
    speedKey = key;
    for (var i = 0; i < SPEED_ORDER.length; i++) {
      var k = SPEED_ORDER[i];
      $('speed-' + k).className = 'speed-btn' + (k === key ? ' active' : '');
    }
    if (mode === 'live' && pendingTimer !== null) {
      if (typeof scheduler.clearTimeout === 'function') scheduler.clearTimeout(pendingTimer);
      pendingTimer = null;
      scheduleNext(SPEEDS[speedKey].delay);
    }
  }

  // ---- ボタン --------------------------------------------------------

  function onStart() {
    var cfg = readConfig();
    var errors = E.validateConfig(cfg);
    if (errors.length > 0) {
      $('config-error').textContent = '配置有误：' + errors.join('；');
      return;
    }
    $('config-error').textContent = '';
    try {
      startBattle(cfg);                 // ロックは startBattle 内で行う
    } catch (e) {
      setConfigEnabled(true);
      $('config-error').textContent = '配置有误：' + (e && e.message ? e.message : String(e));
    }
  }

  // ---- 公開 API（window.GameUI） -------------------------------------

  window.GameUI = {
    SPEEDS: SPEEDS,
    createRealtimeScheduler: createRealtimeScheduler,
    createSyncScheduler: createSyncScheduler,
    useScheduler: function (sched) {
      if (!sched || typeof sched.setTimeout !== 'function') {
        throw new Error('调度器必须提供 setTimeout(fn, ms)');
      }
      scheduler = sched;
    },
    getScheduler: function () { return scheduler; },
    getScreen: function () { return screen; },
    getMode: function () { return mode; },
    getSpeed: function () { return speedKey; },
    setSpeed: setSpeed,
    startBattle: startBattle,
    skipToResult: skipToResult,
    resetToConfig: resetToConfig,
    clearLog: clearLog,
    getBattleState: function () {
      return state ? JSON.parse(JSON.stringify(state)) : null;
    },
    getLogEntries: function () {
      return state ? state.log.slice() : [];
    }
  };

  // ---- 起動 ----------------------------------------------------------

  buildConfigPanel();
  showScreen('config');
  setSpeed('middle');
  // 速度 3 段ボタンの配線（実クリックでも GameUI.setSpeed と同じ経路を通る）
  $('speed-slow').addEventListener('click', function () { setSpeed('slow'); });
  $('speed-middle').addEventListener('click', function () { setSpeed('middle'); });
  $('speed-fast').addEventListener('click', function () { setSpeed('fast'); });
  $('btn-start').addEventListener('click', onStart);
  $('btn-skip').addEventListener('click', skipToResult);
  $('btn-reset').addEventListener('click', resetToConfig);
  $('btn-clear-log').addEventListener('click', clearLog);
})();
