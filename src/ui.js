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

  var FACTIONS = ['human', 'zombie'];

  // Emoji 美術（倒地 / 勝者。生存者は兵種表の typeId から引く）
  var DOWNED_EMOJI = '💀';
  var WIN_EMOJI = '🏆';

  // 速度 3 段階（1 ステップあたりの演出待ち時間 ms）
  var SPEEDS = {
    slow:   { label: '慢', delay: 1600 },
    middle: { label: '中', delay: 800 },
    fast:   { label: '快', delay: 300 }
  };
  var SPEED_ORDER = ['slow', 'middle', 'fast'];

  // 重要シーン演出の尺 ms（#16 仕様。styles.css の --dur-shake / --dur-spot と
  // 必ず一致させること。次ステップの遅延増分の算出にだけ使う）
  var FX_DUR = { shake: 400, spot: 900 };

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
  var firstContactSeen = false; // 初接戦（初の命中）をまだ演出していないか
  var firstHitRowLogged = false; // 初接戦行（初の命中行）をまだ描いていないか
  var cardRefs = {};        // 名前 → { card, emoji, fill, float }
  var chipRefs = {};        // 名前 → { chip, emoji }

  // ---- 戦場グリッド定数 ----------------------------------------------
  // CSS 側（.grid-cell / .unit-card の 64px）と必ず一致させること
  var GRID_SIZE = 9;        // 一辺のマス数（エンジンの 9×9 と一致）
  var CELL_PX = 64;         // 1 マスの辺長 px（#16 仕様: 64px 固定）

  // ---- 小道具 --------------------------------------------------------

  function setConfigEnabled(enabled) {
    FACTIONS.forEach(function (f) {
      E.UNIT_TYPES[f].forEach(function (t) {
        $(f + '-' + t.id).disabled = !enabled;
      });
    });
    $('config-placement').disabled = !enabled; // 初期站位も全局設定として一緒にロック
    $('btn-start').disabled = !enabled;
  }

  // 生存メンバーの Emoji（兵種表を typeId で引く。 typeId の無い旧形 state は
  // 陣営絵文字へフォールバックする）
  function unitEmoji(m) {
    if (m.typeId) {
      var table = E.UNIT_TYPES[m.faction] || [];
      for (var i = 0; i < table.length; i++) {
        if (table[i].id === m.typeId) return table[i].emoji;
      }
    }
    return m.faction === 'human' ? '🧑' : '🧟';
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

  // 陣営の予算バーを更新する（「已用 X / 32」。超支は over クラスで赤表示）
  function updateBudget(f) {
    var used = 0;
    E.UNIT_TYPES[f].forEach(function (t) {
      used += (Number($(f + '-' + t.id).value) || 0) * t.cost;
    });
    var budget = E.POINT_BUDGET;
    var bar = $('budget-bar-' + f);
    bar.children[0].style.width = Math.min(100, (used / budget) * 100) + '%';
    bar.classList.toggle('over', used > budget);
    $('budget-num-' + f).textContent = '已用 ' + used + ' / ' + budget;
  }

  // 両陣営の兵種行＋予算バーを組み立てる（#18 仕様: 編成制）。
  // 数量入力は id=<faction>-<typeId>、初期値は既定編成。input イベントで
  // 予算バーを即時更新する
  function buildConfigPanel() {
    var wrap = $('faction-configs');
    FACTIONS.forEach(function (f) {
      var fs = document.createElement('fieldset');
      fs.className = 'faction ' + f;
      var legend = document.createElement('legend');
      legend.textContent = E.FACTION_LABEL[f];
      fs.appendChild(legend);
      E.UNIT_TYPES[f].forEach(function (t) {
        var row = document.createElement('label');
        row.className = 'unit-row';
        var emoji = document.createElement('span');
        emoji.className = 'unit-emoji';
        emoji.textContent = t.emoji;
        var name = document.createElement('span');
        name.className = 'unit-name';
        name.textContent = t.name;
        var role = document.createElement('span');
        role.className = 'unit-role';
        role.textContent = t.role;
        var stats = document.createElement('span');
        stats.className = 'unit-stats';
        stats.textContent = 'HP ' + t.hp + ' · 攻 ' + t.attack + ' · 敏 ' + t.agility
          + ' · 伤 ' + t.dmgMin + '–' + t.dmgMax;
        var cost = document.createElement('span');
        cost.className = 'unit-cost';
        cost.textContent = t.cost + ' 点';
        var input = document.createElement('input');
        input.type = 'number';
        input.id = f + '-' + t.id;
        input.min = '0';
        input.max = '36';
        input.step = '1';
        input.value = String(E.DEFAULT_CONFIG[f].composition[t.id] || 0);
        input.addEventListener('input', function () { updateBudget(f); });
        row.appendChild(emoji);
        row.appendChild(name);
        row.appendChild(role);
        row.appendChild(stats);
        row.appendChild(cost);
        row.appendChild(input);
        fs.appendChild(row);
      });
      var bar = document.createElement('div');
      bar.className = 'budget-bar';
      bar.id = 'budget-bar-' + f;
      var fill = document.createElement('div');
      fill.className = 'budget-fill';
      bar.appendChild(fill);
      var num = document.createElement('div');
      num.className = 'budget-num';
      num.id = 'budget-num-' + f;
      fs.appendChild(bar);
      fs.appendChild(num);
      wrap.appendChild(fs);
      updateBudget(f);
    });
  }

  // 入力欄から設定値を集める（placement は全局セレクトから）
  function readConfig() {
    var cfg = {};
    cfg.placement = $('config-placement').value;
    FACTIONS.forEach(function (f) {
      var composition = {};
      E.UNIT_TYPES[f].forEach(function (t) {
        composition[t.id] = Number($(f + '-' + t.id).value);
      });
      cfg[f] = { composition: composition };
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
  // 子順は凍結面: [0]emoji [1]血条 [2]飄字層。名前は末尾 [3] に追加する
  // （#16 仕様: 名前は常時表示。4 字超は CSS 側で省略記号に丸める）
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
      r.emoji.textContent = m.downed ? DOWNED_EMOJI : unitEmoji(m);
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
      r.emoji.textContent = m.downed ? DOWNED_EMOJI : unitEmoji(m);
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

  // 態勢ゲージ（#16 仕様）: 両陣営の「存活 hp 合計 / maxHp 合計」を毎拍集計して
  // 左欄の双バーへ反映する。純表示の集計で、エンジンの決着処理には触れない
  function updatePowerPane() {
    if (!state) return;
    var sum = { human: 0, zombie: 0 };
    var max = { human: 0, zombie: 0 };
    for (var i = 0; i < state.members.length; i++) {
      var m = state.members[i];
      max[m.faction] += m.maxHp;
      if (!m.downed) sum[m.faction] += m.hp;
    }
    FACTIONS.forEach(function (f) {
      $('power-fill-' + f).style.width = (sum[f] / max[f]) * 100 + '%';
      $('power-num-' + f).textContent = sum[f] + ' / ' + max[f];
    });
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

  // ---- 意図提示（#16 仕様）--------------------------------------------
  // move 拍だけ描く: 移動前→移動後マスへの破線と目標マスのリング。座標は
  // マス中心の純計算（getBoundingClientRect に依らないので描画結果が環境で
  // 変わらない）。掃除は JS タイマーを使わず「次拍の頭で丸ごと消す」
  // （飄字と同じ方式。CSS 側の ~1200ms フェードが移動足跡の残像を兼ねる）
  function clearIntent() {
    $('intent-layer').innerHTML = '';
  }

  function drawIntent(from, to, faction) {
    var NS = 'http://www.w3.org/2000/svg';
    var size = GRID_SIZE * CELL_PX;
    var x1 = (from.col - 0.5) * CELL_PX;
    var y1 = (from.row - 0.5) * CELL_PX;
    var x2 = (to.col - 0.5) * CELL_PX;
    var y2 = (to.row - 0.5) * CELL_PX;
    var svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('class', 'intent-svg intent-' + faction);
    svg.setAttribute('width', String(size));
    svg.setAttribute('height', String(size));
    var line = document.createElementNS(NS, 'line');
    line.setAttribute('x1', String(x1));
    line.setAttribute('y1', String(y1));
    line.setAttribute('x2', String(x2));
    line.setAttribute('y2', String(y2));
    line.setAttribute('stroke-dasharray', '6 7');
    var ring = document.createElementNS(NS, 'circle');
    ring.setAttribute('cx', String(x2));
    ring.setAttribute('cy', String(y2));
    ring.setAttribute('r', String(CELL_PX * 0.42));
    ring.setAttribute('stroke-dasharray', '4 5');
    svg.appendChild(line);
    svg.appendChild(ring);
    $('intent-layer').appendChild(svg);
  }

  // ---- 重要シーン演出（#16 仕様）--------------------------------------
  // すべて「クラス付与 + CSS アニメの自己完結」で表現し、JS タイマーは
  // 一切使わない（1 pump == 1 step の不変量を守るため）。再始動は
  // 付け外し + 強制リフローで行う（飄字の flashCard と同じ方式）
  function retriggerFx(el, cls) {
    el.classList.remove(cls);
    void el.offsetWidth;
    el.classList.add(cls);
  }

  function clearStageFx() {
    $('battlefield').classList.remove('fx-shake', 'fx-freeze');
    $('fx-redge').classList.remove('on');
    $('fx-spot').classList.remove('on');
  }

  // ---- 戦闘ログ ------------------------------------------------------

  // 行動行の行動者名を行頭から取り出す（区切りは引擎の書式リテラルと同一。
  // 「→」だけの重投履歴や座標の「）→（」は空色区切り ' → ' に一致しない）
  function actorOfLogText(text) {
    var i = text.indexOf(' → ');
    if (i < 0) i = text.indexOf(' 移动：');
    if (i < 0) i = text.indexOf(' 无法移动');
    return i >= 0 ? text.slice(0, i) : null;
  }

  // まだ描画していないログ行だけを追記し、最下部へ自動スクロールする。
  // 三級分層（#16 仕様）: 重要行（倒地/初接戦/終局）に log-key、行動行に陣営色を
  // 追加する。本文と log-<type> の判定は凍結面なので触れない
  function appendLog() {
    if (!state || renderedLogCount >= state.log.length) return;
    var box = $('battle-log');
    var frag = document.createDocumentFragment();
    for (var i = renderedLogCount; i < state.log.length; i++) {
      var e = state.log[i];
      var div = document.createElement('div');
      var cls = 'log-' + e.type;
      var isHitRow = e.type === 'action-hit';
      if (e.type === 'victory'
        || (isHitRow && (!firstHitRowLogged || e.text.indexOf('，倒地！') >= 0))) {
        cls += ' log-key';
      }
      var actor = actorOfLogText(e.text);
      var actorMember = actor ? memberByName(actor) : null;
      if (actorMember) cls += ' log-' + actorMember.faction;
      div.className = cls;
      div.textContent = e.text;
      frag.appendChild(div);
      if (isHitRow) firstHitRowLogged = true;
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
    var fxMs = applyEvent(res.event);
    if (state.finished) {
      finishBattle();
    } else {
      // 重要シーンの拍は演出尺が基本遅延に追いつくまで次拍の待ちを延ばす
      // （尺 ≤ 基本遅延なら増分 0。予約は常に 1 件なので pump 不変量は守られる）
      var base = SPEEDS[speedKey].delay;
      scheduleNext(base + Math.max(0, fxMs - base));
    }
  }

  // 1 ステップ分の結果を画面へ反映する（飄字・アニメ・血条・順序帯・ログ）。
  // move は updateCards の transform 更新だけで滑り移動が表現され、
  // blocked はカードの動きなしでログだけが残る。戻り値はこの拍で始動した
  // 重要シーン演出の尺 ms（なければ 0。doStep が次拍の遅延に加算する）
  function applyEvent(ev) {
    clearFloats();
    clearIntent();
    clearStageFx();
    updateCards();
    updatePowerPane();
    var activeName = ev.actor || null;
    updateStrip(activeName);
    setCurrentMarker(activeName);
    var fxMs = 0;
    if (ev.kind === 'fail') {
      floatOn(ev.actor, 'd7=' + ev.atkRoll + ' 攻击失手', 'float-info');
    } else if (ev.kind === 'dodge') {
      floatOn(ev.target, 'd7=' + ev.dodgeRoll + ' 闪避成功', 'float-info');
    } else if (ev.kind === 'hit') {
      floatOn(ev.actor, 'd7=' + ev.atkRoll + ' 命中', 'float-info');
      floatOn(ev.target, '-' + ev.damage + (ev.downed ? ' 倒地' : ''), 'float-damage');
      flashCard(ev.target);
      if (!firstContactSeen) {
        // 初接戦（初めてダメージが入った拍）: 画面シェイク＋赤縁グロー。
        // 以後の命中では再演しない
        firstContactSeen = true;
        retriggerFx($('battlefield'), 'fx-shake');
        retriggerFx($('fx-redge'), 'on');
        fxMs = FX_DUR.shake;
      }
      if (ev.downed) {
        // 倒地: スポットライト暗転
        retriggerFx($('fx-spot'), 'on');
        if (FX_DUR.spot > fxMs) fxMs = FX_DUR.spot;
      }
    } else if (ev.kind === 'move') {
      floatOn(ev.actor, '移动', 'float-info');
      var mover = memberByName(ev.actor);
      if (mover) drawIntent(ev.from, ev.to, mover.faction);
    } else if (ev.kind === 'blocked') {
      floatOn(ev.actor, '无法移动', 'float-info');
    }
    appendLog();
    return fxMs;
  }

  // 終局表示へ移る（順序帯の強調を外し、横幅を出す。終局フリーズ演出を添える）
  function finishBattle() {
    mode = 'done';
    pendingTimer = null;
    updateCards();
    updatePowerPane();
    updateStrip(null);
    setCurrentMarker(null);
    clearFloats();
    clearIntent();
    retriggerFx($('battlefield'), 'fx-freeze');
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
    firstContactSeen = false;
    firstHitRowLogged = false;
    $('battle-log').innerHTML = '';
    $('battle-banner').hidden = true;
    $('btn-skip').disabled = false;
    clearIntent();
    clearStageFx();
    buildCards();
    buildStrip();
    showScreen('battle');
    mode = 'live';
    updatePowerPane();
    appendLog();
    // 開戦直後は 1 拍置いてから最初の行動へ（メンバーと順序帯を一望させる）
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
    firstContactSeen = false;
    firstHitRowLogged = false;
    cardRefs = {};
    chipRefs = {};
    $('battle-grid').innerHTML = '';
    $('intent-layer').innerHTML = '';
    clearStageFx();
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
