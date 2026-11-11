/* Обезличиватель — интерфейс страницы. Вся обработка — в воркере (worker.js). */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var TYPES = Engine.TYPES;
  var SHORT = { 'ФИО': 'ФИО', 'ТЕЛЕФОН': 'Телефон', 'ПОЧТА': 'Почта', 'СНИЛС': 'СНИЛС', 'ИНН': 'ИНН', 'ПАСПОРТ': 'Паспорт',
    'ПОЛИС': 'Полис', 'КАРТА': 'Карта', 'СЧЁТ': 'Счёт', 'ДАТА_РОЖДЕНИЯ': 'Дата рождения', 'АДРЕС': 'Адрес', 'ШКОЛА': 'Школа',
    'ГОСНОМЕР': 'Госномер', 'НИК': 'Логин', 'IP': 'IP, MAC', 'ID': 'ID', 'ТОКЕН': 'Пароль, токен', 'СВОЁ': 'Своё',
    'ДЕНЬГИ': 'Деньги', 'РЕКВИЗИТЫ': 'Реквизиты', 'ДОГОВОР': 'Номер документа', 'ОРГАНИЗАЦИЯ': 'Организация',
    'ХОСТ': 'Сервер, URL', 'МЕТОД': 'Метод API' };
  function short(t) { return SHORT[t] || t; }
  var CHIP = { 'ХОСТ': 'Сервер', 'ТОКЕН': 'Пароль', 'IP': 'IP', 'ДОГОВОР': 'Номер', 'МЕТОД': 'Метод', 'ДАТА_РОЖДЕНИЯ': 'Дата рождения' };
  function chipName(t) { return CHIP[t] || short(t); }

  // ───────── Настройки (только этот браузер) ─────────
  function load(k, d) { try { var v = localStorage.getItem('obz:' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } }
  function save(k, v) { try { localStorage.setItem('obz:' + k, JSON.stringify(v)); } catch (e) { /* приватный режим */ } }
  var settings = { types: load('types', {}), rules: load('rules', ''), allow: load('allow', ''), idMode: load('idMode', 'pseudo') };
  function lines(s) { return String(s || '').split('\n').map(function (x) { return x.trim(); }).filter(Boolean); }
  function defaultTypes() {
    var t = {}; Object.keys(TYPES).forEach(function (k) { t[k] = k in settings.types ? settings.types[k] : TYPES[k].on; }); return t;
  }
  function opts() {
    return { types: defaultTypes(), allow: lines(settings.allow),
             key: state.prevKey || undefined, idMode: settings.idMode, people: state.aiPeople, rules: lines(settings.rules).concat(state.added, state.aiRules) };
  }

  // ───────── Воркер ─────────
  var worker = new Worker(URL.createObjectURL(new Blob([$('worker-src').textContent], { type: 'text/javascript' })));
  var handlers = {};
  worker.onmessage = function (ev) { var h = handlers[ev.data.type]; if (h) h(ev.data); };
  function call(cmd, data, onProgress, transfer) {
    return new Promise(function (resolve, reject) {
      handlers.progress = onProgress || function () {};
      handlers.error = function (m) { reject(new Error(m.message)); };
      ['analyzed', 'applied', 'restored', 'maskedText', 'segments', 'aiFiltered', 'maskedSegments'].forEach(function (t) { handlers[t] = resolve; });
      worker.postMessage(Object.assign({ cmd: cmd }, data), transfer || []);
    });
  }

  // Файл читаем здесь, а в воркер отдаём байты: Safari не даёт воркеру читать файл
  // с диска, если страница открыта из файла.
  function readBytes(file) {
    return file.arrayBuffer().catch(function () {
      throw new Error('Не удалось прочитать файл. Закройте его в Word или Excel и выберите снова. Если файл в iCloud или OneDrive — сначала скачайте его на компьютер.');
    });
  }
  function human(e) {
    var m = e && e.message ? e.message : String(e);
    if (/I\/O read|NotReadable|could not be read/i.test(m)) return 'Не удалось прочитать файл. Закройте его в Word или Excel и выберите снова.';
    return m;
  }

  // ───────── Вкладки и шаги ─────────
  function tab(name) {
    document.querySelectorAll('.tabs button').forEach(function (x) { x.setAttribute('aria-selected', x.dataset.tab === name); });
    document.querySelectorAll('[data-panel]').forEach(function (p) { p.hidden = p.dataset.panel !== name; });
  }
  document.querySelectorAll('.tabs button').forEach(function (b) { b.addEventListener('click', function () { tab(b.dataset.tab); }); });

  var state = { file: null, report: null, skip: {}, columns: {}, types: null, added: [], shown: 150, prevKey: null,
                bridge: null, result: null, view: 'after', isText: false, aiPeople: [], aiDone: false,
                aiRules: [], aiSet: {}, llmDone: false };
  settings.mode = load('mode', null);          // как проверять: fast | deep; не выбрано — глубокая, если модель подключена
  function mode() { return settings.mode || (llmReady() || (ai.llm && ai.llm.installed) ? 'deep' : 'fast'); }
  var H = { 'X-Obezl': '1' };
  var rKey = null, rFile = null;                                  // свой заголовок: чужой сайт его не пошлёт
  var appMode = location.protocol === 'http:';
  // Редакция: «claude» — со всем для Claude Code; «local» — только обезличивание, без Claude (см. build.py).
  var EDITION = '/*EDITION*/'.charAt(0) === '/' ? 'claude' : '/*EDITION*/';
  var LOCAL = EDITION === 'local';

  // ───────── Проверка: быстрая (правила + Natasha) и глубокая (локальная модель) ─────────
  var ai = { checked: false, ner: false, llm: null };
  function refreshStatus() {
    if (!appMode) { ai.checked = true; renderModes(); return Promise.resolve(); }
    return fetch('/api/ai/status').then(function (r) { return r.json(); }).then(function (j) { ai.ner = !!j.ner; ai.llm = j.llm; ai.ocr = !!j.ocr; })
      .catch(function () {}).then(function () { ai.checked = true; renderModes(); });
  }
  var aiReady = refreshStatus().then(function () {
    if (appMode && mode() === 'deep' && ai.llm && ai.llm.installed && !ai.llm.running && !llmWorking())
      fetch('/api/ai/ollama/start', { method: 'POST', headers: H }).then(function () { setTimeout(refreshStatus, 4000); setTimeout(refreshStatus, 12000); });
  });
  function llmReady() { return !!(ai.llm && ai.llm.running && ai.llm.model); }
  function llmWorking() { return !!(ai.llm && ai.llm.setup && ai.llm.setup.state === 'working'); }
  function deepOn() { return mode() === 'deep' && llmReady(); }
  function setDot(id, st) { $(id).className = 'mode-dot ' + (st || ''); }
  var SPIN = '<span class="spin" aria-hidden="true"></span>';

  // Состояние режимов — в трёх местах: выбор на первом шаге, итог на проверке, настройки.
  function renderModes() {
    document.querySelectorAll('.mtile').forEach(function (b) { b.setAttribute('aria-checked', String(b.dataset.mode === mode())); });
    var st, setup = ai.llm && ai.llm.setup;
    if (!appMode) st = 'Только при запуске через ярлык';
    else if (!ai.checked) st = 'Проверяю модель…';
    else if (llmWorking()) st = SPIN + 'Подключаю: ' + escHtml(setup.message || '') + (setup.progress ? ' · ' + setup.progress + '%' : '');
    else if (llmReady()) st = 'Готова';
    else if (setup && setup.state === 'error') st = 'Не подключилась — нажмите, чтобы повторить';
    else if (ai.llm && ai.llm.installed) st = 'Не запущена — запустится сама при проверке';
    else st = LOCAL ? 'Ollama не найдена — нажмите, чтобы узнать, как подключить' : 'Не подключена — нажмите, чтобы подключить';
    $('deepState').innerHTML = st;
    $('deepState').className = 'mtile-st' + (llmReady() ? ' ok' : '');

    // Итог на шаге «Проверьте»
    setDot('fastDot', 'on');
    $('aiStatus').innerHTML = state.fastNote || 'готово';
    var btn = $('btnLlm');
    $('btnUndoReview').hidden = !state.reviewNote;
    if (state.llmDone) {
      setDot('llmDot', 'on'); $('llmStatus').innerHTML = state.llmNote + (state.reviewNote ? ' · ' + state.reviewNote : ''); btn.textContent = 'Проверить ещё раз'; btn.hidden = !llmReady();
    } else if (!appMode) {
      setDot('llmDot', ''); $('llmStatus').textContent = 'только через ярлык'; btn.hidden = true;
    } else if (llmReady()) {
      setDot('llmDot', 'ready'); $('llmStatus').textContent = 'не запускалась'; btn.textContent = 'Проверить глубже'; btn.hidden = !state.report;
    } else if (llmWorking()) {
      setDot('llmDot', 'busy'); $('llmStatus').innerHTML = SPIN + 'подключаю'; btn.hidden = true;
    } else {
      setDot('llmDot', ''); $('llmStatus').textContent = 'не подключена'; btn.textContent = 'Подключить'; btn.hidden = false;
    }

    // Настройки
    $('btnLlm2').hidden = !appMode || llmReady() || llmWorking();
    $('setLlmStatus').textContent = !appMode ? 'Откройте Обезличиватель через ярлык — тогда можно подключить локальную модель.'
      : llmReady() ? 'Подключена модель ' + ai.llm.model + '. Работает на этом компьютере, без интернета.'
      : llmWorking() ? 'Подключаю: ' + (setup.message || '') : 'Локальная модель не подключена.';
  }

  document.querySelectorAll('.mtile').forEach(function (b) {
    b.addEventListener('click', function () {
      settings.mode = b.dataset.mode; save('mode', settings.mode); renderModes();
      if (mode() === 'deep' && !llmReady() && !llmWorking()) ollamaModal();
    });
  });
  $('btnModeHelp').addEventListener('click', ollamaModal);

  // ───────── Экран работы: этапы и общий прогресс ─────────
  var work = null;
  function workStart(title, stages) {
    work = { back: $('stepReview').hidden ? 'drop' : 'review', stages: stages.map(function (s) { return Object.assign({ state: '', detail: '', frac: 0 }, s); }) };
    $('workTitle').textContent = title; $('workPhase').textContent = ''; $('btnWorkStop').hidden = true;
    renderWork(); show('stepWork');
  }
  function stageOf(id) { return work && work.stages.filter(function (s) { return s.id === id; })[0]; }
  function workStage(id, detail, frac) {
    var s = stageOf(id); if (!s) return;
    work.stages.forEach(function (x) { if (x !== s && x.state === 'on') x.state = 'done'; });
    s.state = 'on'; if (detail != null) s.detail = detail; if (frac != null) s.frac = Math.max(0, Math.min(1, frac));
    renderWork();
  }
  function workDone(id, detail, skipped) {
    var s = stageOf(id); if (!s) return;
    s.state = skipped ? 'skip' : 'done'; s.frac = 1; if (detail != null) s.detail = detail; renderWork();
  }
  function renderWork() {
    var total = 0, done = 0;
    work.stages.forEach(function (s) { total += s.w; done += s.w * (s.state === 'done' || s.state === 'skip' ? 1 : s.frac); });
    var pct = total ? Math.min(100, Math.round(done / total * 100)) : 0;
    $('workBar').style.width = pct + '%'; $('workPct').textContent = pct + '%';
    $('stages').hidden = work.stages.length < 2;
    if (work.stages.length < 2 && work.stages[0].detail) $('workPhase').innerHTML = work.stages[0].detail;
    $('stages').innerHTML = work.stages.map(function (s) {
      return '<li class="st-' + (s.state || 'wait') + '"><span class="st-ic" aria-hidden="true"></span><span class="st-name">' + escHtml(s.label) +
        '</span><span class="st-detail">' + (s.detail || (s.state ? '' : 'ждёт')) + '</span></li>';
    }).join('');
  }
  $('btnWorkStop').addEventListener('click', function () { state.llmStop = true; this.disabled = true; this.textContent = 'Останавливаю…'; });

  // Быстрая: нейросеть Natasha дополняет правила именами
  function runAI() {
    if (state.aiDone) return Promise.resolve();
    return aiReady.then(function () {
      if (!ai.ner) { state.aiDone = true; workDone('ner', 'не установлена', true); return; }
      workStage('ner', 'идёт', 0.1);
      return call('segments', {}).then(function (m) {
        var texts = m.texts, batches = [], cur = [], size = 0;
        texts.forEach(function (t) { cur.push(t); size += t.length; if (size > 400000) { batches.push(cur); cur = []; size = 0; } });
        if (cur.length) batches.push(cur);
        var results = [], k = 0;
        return batches.reduce(function (p, b) {
          return p.then(function () {
            return fetch('/api/ai/ner', { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, H), body: JSON.stringify({ texts: b }) })
              .then(function (r) { return r.json(); }).then(function (j) {
                if (j.error) throw new Error(j.error);
                results = results.concat(j.results); k++; workStage('ner', k + ' из ' + batches.length, 0.1 + 0.7 * k / batches.length);
              });
          });
        }, Promise.resolve()).then(function () { return call('aiFilter', { texts: texts, results: results }); });
      }).then(function (m) {
        state.aiDone = true;
        if (!m.values.length) { state.fastNote = 'готово'; workDone('ner', 'новых нет'); return; }
        state.aiPeople = m.values;
        m.values.forEach(function (v) { state.aiSet[v] = true; });
        state.fastNote = 'готово';
        workStage('ner', 'обновляю найденное', 0.9);
        return reanalyze(true).then(function () { workDone('ner', 'ещё ' + fmtNum(m.values.length) + ' ' + plural(m.values.length, 'имя', 'имени', 'имён')); });
      }).catch(function (e) { state.aiDone = true; state.fastNote = 'готово, без поиска имён по смыслу'; workDone('ner', 'недоступен', true); });
    });
  }
  function plural(n, one, few, many) {
    var a = n % 10, b = n % 100;
    return a === 1 && b !== 11 ? one : a >= 2 && a <= 4 && (b < 12 || b > 14) ? few : many;
  }

  // Глубокая: модель читает текст, где найденное уже заменено на [ТИП], и называет пропущенное.
  // Каждый кусок ждём не дольше CHUNK_WAIT: зависший кусок пропускается, проверка идёт дальше.
  var LLM_CHARS = 1500, LLM_MAX = 120000, CHUNK_WAIT = 150000;
  function fmtLeft(sec) { return sec > 90 ? 'ещё ~' + Math.round(sec / 60) + ' мин' : 'ещё ~' + Math.max(5, Math.round(sec / 5) * 5) + ' с'; }
  function askModel(text) {
    var ctl = window.AbortController ? new AbortController() : null;
    var timer = ctl && setTimeout(function () { ctl.abort(); }, CHUNK_WAIT);
    return fetch('/api/ai/llm', { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, H),
      body: JSON.stringify({ texts: [text] }), signal: ctl ? ctl.signal : undefined })
      .then(function (r) { return r.json(); })
      .then(function (j) { if (j.error) throw new Error(j.error); return { items: j.results[0] || [], skipped: !!j.skipped }; },
            function (e) { if (e && e.name === 'AbortError') return { items: [], skipped: true }; throw e; })
      .then(function (x) { clearTimeout(timer); return x; }, function (e) { clearTimeout(timer); throw e; });
  }
  function runLLM() {
    if (state.llmBusy || !state.report) return Promise.resolve();
    state.llmBusy = true; state.llmStop = false;
    workStage('llm', 'готовлю текст', 0);
    var stop = $('btnWorkStop'); stop.hidden = false; stop.disabled = false; stop.textContent = 'Остановить и показать найденное';
    return call('maskedSegments', {}).then(function (m) {
      var chunks = [], cur = '', total = 0;
      m.texts.forEach(function (t) {
        if (total >= LLM_MAX) return;
        t = t.slice(0, LLM_CHARS); total += t.length;
        if (cur && cur.length + t.length > LLM_CHARS) { chunks.push(cur); cur = ''; }
        cur += (cur ? '\n' : '') + t;
      });
      if (cur) chunks.push(cur);
      var found = [], i = 0, t0 = Date.now(), skipped = 0, failsInRow = 0;
      function next() {
        if (state.llmStop || i >= chunks.length) return Promise.resolve();
        var left = i ? (Date.now() - t0) / i * (chunks.length - i) / 1000 : 0;
        workStage('llm', 'часть ' + (i + 1) + ' из ' + chunks.length + (left ? ' · ' + fmtLeft(left) : ''), i / chunks.length);
        return askModel(chunks[i]).then(function (x) {
          found = found.concat(x.items); i++;
          if (x.skipped) { skipped++; failsInRow++; } else failsInRow = 0;
          if (failsInRow >= 3) throw new Error('модель не отвечает');
          return next();
        });
      }
      return next().then(function () {
        var people = {}, rules = {}, n = 0;
        found.forEach(function (it) {
          if (state.aiSet[it.text]) return;
          state.aiSet[it.text] = true; state.llmFound[it.text] = 1; n++;
          if (it.type === 'ФИО') people[it.text] = 1; else rules[it.type + ': ' + it.text] = 1;
        });
        state.aiPeople = state.aiPeople.concat(Object.keys(people));
        state.aiRules = state.aiRules.concat(Object.keys(rules));
        var notes = [];
        if (total >= LLM_MAX) notes.push('проверены первые ' + fmtNum(LLM_MAX / 1000) + ' тыс. знаков');
        if (state.llmStop) notes.push('остановлено на ' + i + ' из ' + chunks.length);
        if (skipped) notes.push('пропущено кусков: ' + skipped);
        var note = notes.length ? ' (' + notes.join(', ') + ')' : '';
        state.llmNote = (n ? 'нашла пропущенное: <b>' + fmtNum(n) + '</b>' : 'пропусков нет') + note;
        state.llmDone = true;
        if (!n) { workDone('llm', 'пропусков нет' + note); return; }
        workStage('llm', 'обновляю найденное', 0.98);
        return reanalyze(true).then(function () { workDone('llm', 'ещё ' + fmtNum(n) + note); });
      });
    }).catch(function (e) {
      state.llmDone = true; state.llmNote = 'не закончила: ' + escHtml(human(e)) + '. Найденное быстрой проверкой — ниже';
      workDone('llm', 'не закончила: ' + escHtml(human(e)), true);
    }).then(function () { state.llmBusy = false; $('btnWorkStop').hidden = true; });
  }
  // Модель перепроверяет найденное правилами и снимает то, что скрыто зря («модуль «Корзина»», «диаграмма Ганта»).
  // Только типы, где правила ошибаются; телефоны, документы, деньги и ID не трогает (это решает и сервер).
  var REVIEWABLE = { 'ФИО': 1, 'ОРГАНИЗАЦИЯ': 1, 'АДРЕС': 1, 'ДАТА_РОЖДЕНИЯ': 1, 'НИК': 1 };
  var REVIEW_MAX = 400, REVIEW_BATCH = 25;
  function runReview() {
    if (!state.report || state.llmStop) { workDone('review', 'пропущено', true); return Promise.resolve(); }
    var cand = state.report.values.filter(function (v) {
      return REVIEWABLE[v.type] && !state.skip[v.key] && !state.llmFound[v.value] && v.snippet;
    }).slice(0, REVIEW_MAX);                                           // значения уже по убыванию частоты
    if (!cand.length) { workDone('review', 'нечего перепроверять'); return Promise.resolve(); }
    var batches = [];
    for (var k = 0; k < cand.length; k += REVIEW_BATCH) batches.push(cand.slice(k, k + REVIEW_BATCH));
    var i = 0, removed = 0, t0 = Date.now();
    var stop = $('btnWorkStop'); stop.hidden = false; stop.disabled = false; stop.textContent = 'Остановить и показать найденное';
    function next() {
      if (state.llmStop || i >= batches.length) return Promise.resolve();
      var left = i ? (Date.now() - t0) / i * (batches.length - i) / 1000 : 0;
      workStage('review', 'часть ' + (i + 1) + ' из ' + batches.length + (left ? ' · ' + fmtLeft(left) : ''), i / batches.length);
      var items = batches[i].map(function (v) { return { id: v.key, type: v.type, value: v.value, snippet: v.snippet }; });
      return fetch('/api/ai/review', { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, H), body: JSON.stringify({ items: items }) })
        .then(function (r) { return r.json(); }).then(function (j) {
          if (j.error) throw new Error(j.error);
          (j.remove || []).forEach(function (key) { if (!state.skip[key]) { state.skip[key] = true; state.modelOff[key] = true; removed++; } });
          i++; return next();
        });
    }
    return next().then(function () {
      state.reviewNote = removed ? 'сняла лишнее: <b>' + fmtNum(removed) + '</b>' : '';
      workDone('review', removed ? 'снято лишнего: ' + fmtNum(removed) : 'лишнего нет');
    }).catch(function (e) { workDone('review', 'не закончила: ' + escHtml(human(e)), true); })
      .then(function () { $('btnWorkStop').hidden = true; });
  }
  function undoReview() {
    Object.keys(state.modelOff).forEach(function (k) { delete state.skip[k]; });
    state.modelOff = {}; state.reviewNote = ''; renderModes(); refresh();
  }
  $('btnUndoReview').addEventListener('click', undoReview);

  // Глубже — уже с экрана проверки
  function deepFromReview() {
    workStart('Глубокая проверка', [{ id: 'llm', label: 'Модель ищет пропущенное', w: 3 }, { id: 'review', label: 'Модель снимает лишнее', w: 1 }]);
    state.llmDone = false; state.llmStop = false;
    var run = state.run = (state.run || 0) + 1;
    runLLM().then(function () { if (run === state.run) return runReview(); })
      .then(function () { if (run !== state.run) return; renderReview(); show('stepReview'); renderModes(); });
  }

  // ───────── Окно ─────────
  function openModal(title, html, actions) {
    $('modalTitle').textContent = title; $('modalBody').innerHTML = html; $('modalActions').innerHTML = '';
    (actions || []).forEach(function (a) {
      var b = document.createElement('button'); b.type = 'button'; b.className = a.primary ? 'primary' : 'ghost'; b.textContent = a.label;
      b.addEventListener('click', function () { if (a.onClick) a.onClick(b); else closeModal(); });
      $('modalActions').appendChild(b);
    });
    $('modal').hidden = false;
  }
  function closeModal() { $('modal').hidden = true; }
  $('modalX').addEventListener('click', closeModal);
  $('modal').addEventListener('click', function (e) { if (e.target === $('modal')) closeModal(); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !$('modal').hidden) closeModal(); });

  var isWin = /Win/.test(navigator.platform || navigator.userAgent);
  function ollamaModal() {
    var hasModel = llmReady(), where = isWin ? 'этом компьютере' : 'этом Mac';
    if (LOCAL && appMode && !hasModel) return localOllamaModal();
    var body = '<div class="cmp"><div><h4>Глубокая · ~10 с на страницу</h4><ul><li>Модель читает текст целиком, как человек</li>' +
      '<li>Находит пропущенное: «Колян», «двенадцать миллионов», подрядчика без «ООО»</li>' +
      '<li>Снимает лишнее: модуль «Корзина», диаграмму Ганта, роли и отделы</li><li>30 страниц — около 5 минут</li></ul></div>' +
      '<div><h4>Быстрая · секунды</h4><ul><li>Ищет по шаблонам: ФИО, телефоны, СНИЛС, ИНН, паспорт, адреса, суммы, ID, логины</li>' +
      '<li>Может скрыть лишнее или пропустить необычное — проверьте результат</li><li>Для огромных файлов и компьютеров без модели</li></ul></div></div>';
    if (!appMode) {
      openModal('Быстрая и глубокая', body + '<p class="muted small">Глубокая работает, когда Обезличиватель открыт через ярлык.</p>', [{ label: 'Понятно', primary: true }]);
      return;
    }
    body += '<p class="muted small">Модель работает на ' + where + ', текст никуда не уходит. ' +
      (hasModel ? 'Подключена: ' + escHtml(ai.llm.model) + '.' :
        isWin ? 'Для подключения скачается программа Ollama и модель — около 3,5 ГБ с ollama.com, без прав администратора. Нужно от 8 ГБ памяти.'
              : 'Для подключения поставится программа Ollama и модель — около 3,5 ГБ с ollama.com (на Mac с комплектом Славатора — без скачивания).') + '</p>';
    openModal('Быстрая и глубокая', body,
      hasModel ? [{ label: 'Понятно', primary: true }]
               : [{ label: 'Подключить', primary: true, onClick: function () { closeModal(); connectOllama(); } },
                  { label: 'Не сейчас', onClick: function () { if (!llmReady()) { settings.mode = 'fast'; save('mode', 'fast'); renderModes(); } closeModal(); } }]);
  }
  // Локальная редакция ничего не скачивает и не ставит: ищет Ollama на компьютере и запускает её.
  function localOllamaModal() {
    var st = ai.llm || {}, body;
    if (st.installed && !st.running) body = '<p>Ollama на этом компьютере есть, но не запущена. Обезличиватель может запустить её сам.</p>';
    else if (st.installed && st.running) body = '<p>Ollama запущена, но в ней нет подходящей модели. Скачайте модель в терминале (около 5 ГБ):</p>' +
      '<p><code>ollama pull qwen3:8b</code></p><p class="muted small">Подойдёт и другая уже скачанная модель — Обезличиватель возьмёт её сам. Затем нажмите «Проверить снова».</p>';
    else body = '<p>Глубокой проверке нужна программа <b>Ollama</b> с языковой моделью. Она работает на этом компьютере, текст никуда не уходит.</p>' +
      '<p>Ollama на этом компьютере не найдена. Чтобы подключить:</p><ol class="how"><li>Установите Ollama с сайта ollama.com (на рабочем компьютере — по согласованию с ИБ).</li>' +
      '<li>В терминале скачайте модель: <code>ollama pull qwen3:8b</code> (около 5 ГБ; на слабом компьютере — <code>qwen3:4b</code>).</li><li>Нажмите «Проверить снова».</li></ol>' +
      '<p class="muted small">Без модели работает быстрая проверка — шаблоны и словарь.</p>';
    var actions = st.installed && !st.running
      ? [{ label: 'Запустить', primary: true, onClick: function () { closeModal(); connectOllama(); } }, { label: 'Не сейчас' }]
      : [{ label: 'Проверить снова', primary: true, onClick: function (b) { b.disabled = true; b.textContent = 'Ищу…'; refreshStatus().then(function () { closeModal(); if (!llmReady()) localOllamaModal(); }); } },
         { label: 'Не сейчас', onClick: function () { if (!llmReady()) { settings.mode = 'fast'; save('mode', 'fast'); renderModes(); } closeModal(); } }];
    openModal('Глубокая проверка', body, actions);
  }
  function connectOllama() {
    fetch(LOCAL ? '/api/ai/ollama/start' : '/api/ai/ollama/setup', { method: 'POST', headers: H }).then(function (r) { return r.json(); }).then(function (j) {
      ai.llm = j; renderModes();
      var poll = setInterval(function () {
        refreshStatus().then(function () {
          if (llmWorking()) return;
          clearInterval(poll);
          if (llmReady() && state.file && !state.report && mode() === 'deep') analyze();
        });
      }, 1500);
    }).catch(function (e) { ai.llm = { setup: { state: 'error', message: human(e) } }; renderModes(); });
  }
  $('btnLlm').addEventListener('click', function () { if (llmReady()) deepFromReview(); else ollamaModal(); });
  $('btnLlm2').addEventListener('click', ollamaModal);

  function show(step) {
    ['stepDrop', 'stepWork', 'stepReview', 'stepDone'].forEach(function (s) { $(s).hidden = s !== step; });
    var n = { stepDrop: 1, stepWork: 1, stepReview: 2, stepDone: 3 }[step];
    document.querySelectorAll('#steps li').forEach(function (li) {
      var k = +li.dataset.step; li.className = k < n ? 'is-done' : k === n ? 'is-on' : '';
    });
    window.scrollTo(0, 0);
  }
  function fmtSize(n) { return n > 1048576 ? (n / 1048576).toFixed(1).replace('.', ',') + ' МБ' : Math.max(1, Math.round(n / 1024)) + ' КБ'; }
  function fmtNum(n) { return Number(n).toLocaleString('ru-RU'); }
  function escHtml(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function progressTo(title) {
    workStart(title, [{ id: 'one', label: title, w: 1 }]);
    return function (m) { workStage('one', '', m.total ? m.done / m.total : 0); $('workPhase').textContent = m.phase || ''; };
  }
  function fail(e) {
    show(state.report ? 'stepReview' : 'stepDrop');
    var n = document.createElement('div'); n.className = 'note err'; n.textContent = human(e);
    $('errors').innerHTML = ''; $('errors').appendChild(n);
  }
  function clearErrors() { $('errors').innerHTML = ''; }

  // ───────── Шаг 1: файл или текст ─────────
  var drop = $('drop');
  $('btnPick').addEventListener('click', function (e) { e.stopPropagation(); $('fileInput').click(); });
  drop.addEventListener('click', function () { $('fileInput').click(); });
  ['dragenter', 'dragover'].forEach(function (ev) { drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.add('over'); }); });
  ['dragleave', 'drop'].forEach(function (ev) { drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.remove('over'); }); });
  function startMany(list) {
    var files = Array.prototype.slice.call(list || []);
    if (!files.length) return;
    state.queue = files.slice(1); state.batch = files.length > 1 ? { total: files.length, n: 1 } : null;
    start(files[0], false);
  }
  drop.addEventListener('drop', function (e) { startMany(e.dataTransfer.files); });
  $('fileInput').addEventListener('change', function () { startMany(this.files); this.value = ''; });
  // Следующий файл из очереди — с тем же ключом: один и тот же человек во всех файлах получает одну метку.
  $('btnNext').addEventListener('click', function () {
    if (!state.queue || !state.queue.length) return;
    if (state.result && state.result.key) state.prevKey = state.result.key;
    state.batch.n++;
    start(state.queue.shift(), false);
  });
  $('txtIn').addEventListener('input', function () { $('btnText').disabled = !this.value.trim(); });
  $('btnText').addEventListener('click', function () {
    var text = $('txtIn').value; if (!text.trim()) return;
    state.queue = []; state.batch = null;
    start(new File([text], 'текст.txt', { type: 'text/plain' }), true);
  });

  var CANCEL = 'отменено';
  function alive(run) { return function (x) { if (run !== state.run) throw new Error(CANCEL); return x; }; }
  $('btnWorkBack').addEventListener('click', function () {
    state.run = (state.run || 0) + 1; state.llmStop = true; state.llmBusy = false;
    show(work && work.back === 'review' && state.report ? 'stepReview' : 'stepDrop');
  });
  $('btnDoneBack').addEventListener('click', function () { clearErrors(); show('stepReview'); });

  // ───────── PDF: текст по страницам ─────────
  // pdf.js (Mozilla) встроен в страницу и запускается из blob: — без сети. Результат — текстовый файл
  // с отметками страниц: дальше работают с текстом, а не с вёрсткой. Сканы без текстового слоя прочитать нельзя.
  var pdfLib = null, pdfWorkerUrl = null;
  // Safari и WebKit пока не умеют «for await» по ReadableStream, а pdf.js на нём читает текст.
  var STREAM_ITER = 'if (typeof ReadableStream !== "undefined" && !ReadableStream.prototype[Symbol.asyncIterator]) {' +
    'ReadableStream.prototype[Symbol.asyncIterator] = async function* () { const r = this.getReader();' +
    'try { for (;;) { const x = await r.read(); if (x.done) return; yield x.value; } } finally { r.releaseLock(); } }; }\n';
  function loadPdfJs() {
    if (pdfLib) return pdfLib;
    var blobUrl = function (id, pre) { return URL.createObjectURL(new Blob([(pre || '') + $(id).textContent], { type: 'text/javascript' })); };
    pdfWorkerUrl = blobUrl('pdfjs-worker-src', STREAM_ITER);   // обычный (не модульный) воркер — см. build.py
    if (typeof ReadableStream !== 'undefined' && !ReadableStream.prototype[Symbol.asyncIterator]) {
      ReadableStream.prototype[Symbol.asyncIterator] = function () {
        var r = this.getReader();
        return { next: function () { return r.read(); }, return: function () { r.releaseLock(); return Promise.resolve({ done: true }); },
                 [Symbol.asyncIterator]: function () { return this; } };
      };
    }
    pdfLib = import(blobUrl('pdfjs-src'))
      .catch(function (e) { pdfLib = null; throw new Error('Не удалось запустить чтение PDF в этом браузере: ' + human(e)); });
    return pdfLib;
  }
  // ── Текст страницы по координатам ──
  // 1) Куски текста → визуальные строки (одна базовая линия) → ячейки (большой промежуток по горизонтали).
  // 2) Таблица: 1–3 соседние строки с заголовками «ФИО», «СНИЛС», «Дата рождения»… задают столбцы.
  //    Строки таблицы — по «якорям» первого столбца (номер или ФИО): каждый кусок идёт в ближайшую по высоте
  //    строку и в свой столбец по x. Так перенос внутри ячейки («7479 / 263201») собирается обратно,
  //    а тип столбца доходит до каждого значения: «ячейка<Tab>ячейка».
  // 3) Обычный текст: строка, дошедшая до правого края без точки, — перенос внутри абзаца, склеиваем.
  function pdfLines(items) {
    var pts = [];
    items.forEach(function (it) {
      if (!it.str) return;
      var t = it.transform || [1, 0, 0, 1, 0, 0];
      pts.push({ str: it.str, x: t[4], y: t[5], w: it.width || 0, size: Math.abs(t[3]) || Math.abs(t[0]) || 10, ocr: !!it.ocr });
    });
    var lines = [];
    pts.forEach(function (p) {                           // одна базовая линия: разница по высоте меньше четверти кегля
      var l = null;
      var tol = p.size * (p.ocr ? 0.4 : 0.25);
      for (var k = lines.length - 1; k >= 0 && k >= lines.length - 40; k--) if (Math.abs(lines[k].y - p.y) <= tol) { l = lines[k]; break; }
      if (!l) { l = { y: p.y, size: p.size, pts: [] }; lines.push(l); }
      l.pts.push(p);
    });
    lines.sort(function (a, b) { return b.y - a.y; });
    lines.forEach(function (l) {
      l.pts.sort(function (a, b) { return a.x - b.x; });
      var cells = [], c = null;
      l.pts.forEach(function (p) {
        var gap = c ? p.x - c.right : 0;
        // Распознанный текст: Vision сам делит строку на куски по столбцам — каждый кусок отдельной ячейкой.
        if (!c || p.ocr || gap > p.size * 0.45) { c = { text: '', left: p.x, right: p.x, y: l.y }; cells.push(c); }
        else if (gap > p.size * 0.15 && !/\s$/.test(c.text) && !/^\s/.test(p.str)) c.text += ' ';
        c.text += p.str; c.right = Math.max(c.right, p.x + p.w);
      });
      l.cells = cells.map(function (c) { c.text = c.text.replace(/\s+/g, ' ').trim(); return c; }).filter(function (c) { return c.text; });
      if (l.cells.length) { l.left = l.cells[0].left; l.right = l.cells[l.cells.length - 1].right; }
    });
    return lines.filter(function (l) { return l.cells.length; });
  }
  // Заголовок таблицы с началом в строке i: куски 1–3 строк, сложенные по x в столбцы с узнаваемыми названиями.
  function pdfHeaderAt(lines, i) {
    var best = null;
    for (var n = 1; n <= 3 && i + n <= lines.length; n++) {
      if (n > 1 && lines[i + n - 2].y - lines[i + n - 1].y > lines[i].size * 1.6) break;
      var frags = [];
      for (var k = i; k < i + n; k++) lines[k].cells.forEach(function (c) { frags.push({ text: c.text, left: c.left, right: c.right, row: k }); });
      frags.sort(function (a, b) { return a.left - b.left; });
      var cols = [];
      frags.forEach(function (f) {
        var col = cols.filter(function (c) { return f.left < c.right - 1 && f.right > c.left + 1; })[0];
        if (col) { col.parts.push(f); col.left = Math.min(col.left, f.left); col.right = Math.max(col.right, f.right); }
        else cols.push({ left: f.left, right: f.right, parts: [f] });
      });
      if (cols.length < 2) continue;
      var typed = 0, labels = true;
      cols.forEach(function (c) {
        c.text = c.parts.sort(function (a, b) { return a.row - b.row || a.left - b.left; }).map(function (x) { return x.text; }).join(' ');
        c.type = Engine.classifyHeader(c.text);
        if (c.type) typed++;
        // Заголовок — короткие подписи без цифр; фраза, разрезанная на куски, заголовком не считается.
        if (c.text !== '№' && (c.text.length > 40 || /\d/.test(c.text) || c.text.split(/\s+/).length > 5)) labels = false;
      });
      if (!labels) continue;
      if (typed >= 2 && (!best || typed > best.typed)) best = { cols: cols, typed: typed, start: i, end: i + n };
    }
    return best;
  }
  function pdfHeader(lines, i) {                        // заголовок в i, i+1 или i+2 — берём, где узнаётся больше столбцов
    var best = null;
    for (var k = i; k <= i + 2 && k < lines.length; k++) {
      var h = pdfHeaderAt(lines, k);
      if (h && (!best || h.typed > best.typed)) best = h;
      if (k === i && !h) return null;
    }
    return best;
  }
  function pdfColOf(cols, c, size) {
    if (c.left < cols[0].left - size * 2) return -1;
    for (var k = cols.length - 1; k >= 0; k--) if (c.left >= cols[k].left - size * 0.6) return k;
    return 0;
  }
  function pdfTable(lines, hdr) {
    var cols = hdr.cols, frags = [], i = hdr.end, tableW = cols[cols.length - 1].right - cols[0].left;
    while (i < lines.length) {
      var L = lines[i], size = L.size;
      if (lines[i - 1].y - L.y > size * 3) break;                                   // большой отступ — таблица кончилась
      if (L.cells.length === 1 && cols.length > 2 && L.right - L.left > tableW * 0.6) break;   // абзац во всю ширину
      var mapped = L.cells.map(function (c) { return { c: c, k: pdfColOf(cols, c, size) }; });
      if (mapped.some(function (m) { return m.k < 0; })) break;
      mapped.forEach(function (m) { frags.push({ text: m.c.text, k: m.k, y: L.y, x: m.c.left }); });
      i++;
    }
    // Якоря строк — куски первого столбца; если его нет, каждая визуальная строка — своя.
    var anchors = frags.filter(function (f) { return f.k === 0; }).map(function (f) { return f.y; });
    var rows = [];
    if (anchors.length) {
      anchors = anchors.filter(function (y, j) { return j === 0 || anchors[j - 1] - y > hdr.cols.length * 0 + 0.5; });
      rows = anchors.map(function (y) { return { y: y, parts: [] }; });
      frags.forEach(function (f) {
        var r = rows.reduce(function (b, r) { return Math.abs(r.y - f.y) < Math.abs(b.y - f.y) ? r : b; }, rows[0]);
        r.parts.push(f);
      });
    } else {
      frags.forEach(function (f) { var r = rows[rows.length - 1]; if (!r || r.y !== f.y) rows.push(r = { y: f.y, parts: [] }); r.parts.push(f); });
    }
    var out = rows.map(function (r) {
      var cells = cols.map(function () { return []; });
      r.parts.sort(function (a, b) { return b.y - a.y || a.x - b.x; }).forEach(function (f) { cells[f.k].push(f.text); });
      return cells.map(function (c) { return c.join(' '); }).join('\t');
    });
    return { rows: out, end: i };
  }
  function pageText(items) {
    var lines = pdfLines(items), blocks = [], i = 0;
    while (i < lines.length) {
      var hdr = pdfHeader(lines, i);
      if (!hdr) { blocks.push({ line: lines[i] }); i++; continue; }
      for (; i < hdr.start; i++) blocks.push({ line: lines[i] });
      var t = pdfTable(lines, hdr);
      blocks.push({ text: hdr.cols.map(function (c) { return c.text; }).join('\t'), table: true });
      t.rows.forEach(function (r) { blocks.push({ text: r, table: true }); });
      i = t.end;
    }
    var maxRight = lines.reduce(function (m, l) { return Math.max(m, l.right); }, 0), out = '';
    blocks.forEach(function (b, k) {
      var txt = b.table ? b.text : b.line.cells.map(function (c) { return c.text; }).join('\t'), nx = blocks[k + 1];
      out += txt;
      if (!nx) return;
      if (b.table || nx.table) { out += '\n'; return; }
      var l = b.line, n = nx.line, near = l.y - n.y < l.size * 2;
      var wrap = near && l.cells.length === 1 && n.cells.length === 1 && l.right >= maxRight * 0.85 && !/[.!?:;]$/.test(txt);
      if (wrap) out += /[0-9A-Za-zА-Яа-яЁё]-$/.test(txt) && /^[0-9a-zа-яё]/.test(n.cells[0].text) ? '' : ' ';
      else out += near ? '\n' : '\n\n';
    });
    return out.trim();
  }
  // Текст страницы через поток — без «for await», который есть не во всех браузерах.
  function readText(page) {
    var reader = page.streamTextContent({}).getReader(), items = [];
    function pump() { return reader.read().then(function (r) { if (r.done) return items; items.push.apply(items, r.value.items); return pump(); }); }
    return pump();
  }
  // ── Распознавание текста на картинках (сканы в PDF, скриншоты, фото) ──
  // Apple Vision на этом Mac через локальный сервер — картинка не уходит дальше компьютера.
  // Ответ — строки с координатами; превращаем их в «куски текста» как у PDF, чтобы так же собрать абзацы и таблицы.
  var IMAGE_RE = /\.(?:png|jpe?g|heic|heif|tiff?|webp)$/i;
  function ocrBytes(bytes, type) {
    return fetch('/api/ai/ocr', { method: 'POST', headers: Object.assign({ 'Content-Type': type || 'application/octet-stream' }, H), body: bytes })
      .then(function (r) { return r.json(); }).then(function (j) {
        if (j.error) throw new Error(j.error);
        var W = j.width, Hh = j.height, items = [];
        (j.lines || []).forEach(function (l) {
          // Высота строки — по середине рамки: у соседних рамок нижние края гуляют.
          var size = Math.max(4, l.h * Hh * 0.8), x = l.x * W, y = (l.y + l.h / 2) * Hh, w = l.w * W;
          // Рамки таблиц OCR читает как «|» — это границы ячеек.
          var parts = l.text.split(/\s*\|\s*/), pos = 0, len = Math.max(1, l.text.length);
          parts.forEach(function (t) {
            var at = l.text.indexOf(t, pos); if (at < 0) at = pos; pos = at + t.length;
            if (t.trim()) items.push({ str: t.trim(), transform: [1, 0, 0, size, x + w * at / len, y], width: w * t.length / len, ocr: true });
          });
        });
        return items;
      });
  }
  function canOcr() { return appMode && ai.ocr; }
  // Картинки скана — прямо из PDF, без отрисовки страницы: в Safari отрисовка pdf.js может не завершиться.
  // Если картинок нет (страница нарисована векторами) — рисуем страницу целиком (работает в Chrome, Edge, Firefox).
  function imageToPng(img) {
    var c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
    var ctx = c.getContext('2d');
    if (img.bitmap) ctx.drawImage(img.bitmap, 0, 0);
    else {
      var id = ctx.createImageData(img.width, img.height), out = id.data, src = img.data, n = img.width * img.height, i, j;
      if (img.kind === 3) out.set(src.subarray(0, n * 4));
      else if (img.kind === 2) for (i = 0, j = 0; i < n; i++) { out[j++] = src[i * 3]; out[j++] = src[i * 3 + 1]; out[j++] = src[i * 3 + 2]; out[j++] = 255; }
      else {                                              // 1 бит на точку, строки выровнены по байтам; 1 — белый
        var row = (img.width + 7) >> 3;
        for (var y = 0; y < img.height; y++) for (var x = 0; x < img.width; x++) {
          var v = (src[y * row + (x >> 3)] >> (7 - (x & 7))) & 1 ? 255 : 0, k = (y * img.width + x) * 4;
          out[k] = out[k + 1] = out[k + 2] = v; out[k + 3] = 255;
        }
      }
      ctx.putImageData(id, 0, 0);
    }
    return new Promise(function (res) { c.toBlob(function (b) { res(b); }, 'image/png'); });
  }
  function withTimeout(p, ms) { return Promise.race([p, new Promise(function (res) { setTimeout(function () { res(null); }, ms); })]); }
  function scanImages(page, lib) {
    return page.getOperatorList().then(function (opl) {
      var ids = [];
      opl.fnArray.forEach(function (fn, k) { if (fn === lib.OPS.paintImageXObject && ids.indexOf(opl.argsArray[k][0]) < 0) ids.push(opl.argsArray[k][0]); });
      return ids.reduce(function (p, id) {
        return p.then(function (list) {
          var store = /^g_/.test(id) ? page.commonObjs : page.objs;
          return withTimeout(new Promise(function (res) { store.get(id, res); }), 10000).then(function (img) {
            if (!img || img.width < 300 || img.height < 100) return list;   // значки и линии не распознаём
            return imageToPng(img).then(function (png) { list.push(png); return list; });
          });
        });
      }, Promise.resolve([]));
    });
  }
  function renderPage(page) {
    var base = page.getViewport({ scale: 1 }), scale = Math.min(4, Math.max(1.5, 2200 / base.width));
    var vp = page.getViewport({ scale: scale }), canvas = document.createElement('canvas');
    canvas.width = Math.ceil(vp.width); canvas.height = Math.ceil(vp.height);
    var ctx = canvas.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
    return withTimeout(page.render({ canvasContext: ctx, viewport: vp }).promise.then(function () {
      return new Promise(function (res) { canvas.toBlob(function (b) { res(b); }, 'image/png'); });
    }), 30000);
  }
  function ocrPage(page, lib) {
    return scanImages(page, lib).then(function (pngs) {
      if (pngs.length) return pngs;
      return renderPage(page).then(function (png) { return png ? [png] : []; });
    }).then(function (pngs) {
      return pngs.reduce(function (p, png) {
        return p.then(function (texts) { return ocrBytes(png, 'image/png').then(function (items) { texts.push(pageText(items)); return texts; }); });
      }, Promise.resolve([])).then(function (texts) { return texts.filter(Boolean).join('\n\n'); });
    });
  }
  function pdfToText(file, onPage) {
    var task = null, port = null, lib = null;
    return Promise.all([loadPdfJs(), readBytes(file)]).then(function (r) {
      lib = r[0]; port = new Worker(pdfWorkerUrl);
      task = lib.getDocument({ data: new Uint8Array(r[1]), isEvalSupported: false, disableFontFace: true, verbosity: 0,
                               worker: new lib.PDFWorker({ port: port }) });
      return task.promise;
    }).catch(function (e) {
      if (e && e.name === 'PasswordException') throw new Error('PDF под паролем. Откройте его, снимите пароль и сохраните заново.');
      if (e && /InvalidPDF|FormatError/.test(e.name || '')) throw new Error('Файл повреждён или это не PDF.');
      throw e;
    }).then(function (doc) {
      var pages = [], ocred = 0, n = doc.numPages, i = 0;
      function next() {
        if (i >= n) return Promise.resolve();
        i++;
        return doc.getPage(i).then(function (page) {
          return readText(page).then(function (items) {
            var text = pageText(items);
            // Страница без текстового слоя (скан) — распознаём картинку, если это возможно.
            if (text.replace(/\s/g, '').length >= 20 || !canOcr()) return text;
            onPage(i, n, true);
            return ocrPage(page, lib).then(function (t) { if (t) ocred++; return t || text; });
          });
        }).then(function (t) { pages.push(t); onPage(i, n); return next(); });
      }
      return next().then(function () { task.destroy(); port.terminate(); return { pages: pages, ocred: ocred }; });
    });
  }
  function textFileFrom(name, pages, info) {
    var text = pages.length === 1 && info.image ? pages[0] + '\n'
      : pages.map(function (p, i) { return '── Страница ' + (i + 1) + ' ──\n' + (p || '(страница без текста)'); }).join('\n\n') + '\n';
    var tf = new File([text], name.replace(/\.[^.]+$/, '') + '.txt', { type: 'text/plain' });
    tf._pdf = info;
    return tf;
  }
  function showError(e) { show('stepDrop'); var n = document.createElement('div'); n.className = 'note err'; n.textContent = human(e); $('errors').innerHTML = ''; $('errors').appendChild(n); }
  function startPdf(file) {
    clearErrors();
    workStart('Читаю PDF «' + file.name + '»', [{ id: 'one', label: 'Текст из PDF', w: 1 }]);
    workStage('one', 'открываю', 0.02);
    aiReady.then(function () {
      return pdfToText(file, function (i, n, ocr) { workStage('one', (ocr ? 'распознаю скан: страница ' : 'страница ') + i + ' из ' + n, (i - (ocr ? 0.5 : 0)) / n); });
    }).then(function (r) {
      var pages = r.pages, empty = pages.filter(function (p) { return !p; }).length;
      if (empty === pages.length) throw new Error(canOcr()
        ? 'Текст не нашёлся даже после распознавания: похоже, в PDF только картинки без букв.'
        : appMode ? 'В PDF нет текста — похоже, это скан. Распознавание сканов есть только на Mac.'
                  : 'В PDF нет текста — похоже, это скан. Сканы распознаются, когда Обезличиватель открыт через ярлык (на Mac).');
      start(textFileFrom(file.name, pages, { name: file.name, size: file.size, pages: pages.length, empty: empty, ocr: r.ocred }), false);
    }).catch(showError);
  }
  function startImage(file) {
    clearErrors();
    aiReady.then(function () {
      if (!canOcr()) throw new Error(appMode ? 'Распознавание текста на картинках есть только на Mac.'
        : 'Картинки распознаются, когда Обезличиватель открыт через ярлык (на Mac). Или вставьте текст во вкладку «Текст».');
      workStart('Распознаю текст на «' + file.name + '»', [{ id: 'one', label: 'Распознавание', w: 1 }]);
      workStage('one', 'Apple Vision на этом Mac', 0.3);
      return readBytes(file).then(function (buf) { return ocrBytes(buf, file.type); });
    }).then(function (items) {
      var text = pageText(items);
      if (!text) throw new Error('На картинке не нашлось текста.');
      start(textFileFrom(file.name, [text], { name: file.name, size: file.size, pages: 1, empty: 0, ocr: 1, image: true }), false);
    }).catch(showError);
  }

  function start(file, isText) {
    // После «Назад» прежняя проверка доделывает текущий кусок — новая ждёт её, чтобы не смешать результаты.
    if (state.pending) { var prev = state.pending; state.pending = null; prev.then(function () { start(file, isText); }); return; }
    if (!isText && /\.pdf$/i.test(file.name)) return startPdf(file);
    if (!isText && IMAGE_RE.test(file.name)) return startImage(file);
    clearErrors();
    state.file = file; state.isText = isText; state.skip = {}; state.columns = {}; state.added = [];
    state.types = defaultTypes(); state.shown = 150; state.report = null; state.view = 'after';
    state.aiPeople = []; state.aiDone = false; state.aiRules = []; state.aiSet = {}; state.llmDone = false; state.llmBusy = false;
    state.llmFound = {}; state.modelOff = {}; state.reviewNote = '';
    state.fastNote = ''; state.llmNote = ''; state.pdfInfo = file._pdf || null; renderModes();
    aiReady.then(function () { return mode() === 'deep' ? ensureModel() : true; }).then(function (go) { if (go) analyze(); });
  }

  // Выбрана глубокая, а модель не готова: не подменяем молча быстрой — запускаем или спрашиваем.
  function ensureModel() {
    if (llmReady()) return Promise.resolve(true);
    var installed = ai.llm && ai.llm.installed && (ai.llm.running || !LOCAL || true);
    return new Promise(function (resolve) {
      if (appMode && installed) { startModel().then(function (ok) { if (ok) return resolve(true); askNoModel(resolve); }); return; }
      askNoModel(resolve);
    });
  }
  function startModel() {
    workStart('Запускаю модель для глубокой проверки', [{ id: 'one', label: 'Запуск', w: 1 }]);
    workStage('one', 'обычно 5–15 секунд', 0.2);
    return fetch('/api/ai/ollama/start', { method: 'POST', headers: H }).then(function () {
      var t0 = Date.now();
      return new Promise(function (res) {
        (function poll() {
          refreshStatus().then(function () {
            if (llmReady()) return res(true);
            if (!llmWorking() || Date.now() - t0 > 60000) return res(false);
            workStage('one', 'обычно 5–15 секунд', Math.min(0.9, 0.2 + (Date.now() - t0) / 30000)); setTimeout(poll, 1000);
          });
        })();
      });
    }).catch(function () { return false; });
  }
  function askNoModel(resolve) {
    show('stepDrop');
    var body = appMode
      ? '<p>Модель для глубокой проверки не подключена. Без неё файл проверится только быстрой проверкой — что-то может пропуститься.</p>'
      : '<p>Глубокая проверка работает, только когда Обезличиватель открыт через ярлык. Сейчас страница открыта из файла.</p>';
    var actions = [];
    if (appMode) actions.push({ label: 'Подключить модель', primary: true, onClick: function () { closeModal(); resolve(false); if (LOCAL) localOllamaModal(); else connectOllama(); } });
    actions.push({ label: 'Проверить быстро', primary: !appMode, onClick: function () { closeModal(); resolve(true); } });
    actions.push({ label: 'Отмена', onClick: function () { closeModal(); resolve(false); } });
    openModal('Глубокая проверка недоступна', body, actions);
  }
  function analyze() {
    var run = state.run = (state.run || 0) + 1, ok = alive(run);
    var deep = deepOn(), ner = appMode && ai.ner;
    state.modeUsed = deep ? 'глубокая (модель ' + ai.llm.model + ')' : ner ? 'быстрая (шаблоны, словарь, Natasha)' : 'быстрая (шаблоны и словарь)';
    var stages = [{ id: 'rules', label: 'Ищу по форматам', w: deep ? 1 : ner ? 6 : 1 }];
    if (ner) stages.push({ id: 'ner', label: 'Ищу имена', w: deep ? 1 : 4 });
    if (deep) stages.push({ id: 'llm', label: 'Модель ищет пропущенное', w: 6 }, { id: 'review', label: 'Модель снимает лишнее', w: 2 });
    workStart(state.isText ? 'Проверяю текст' : 'Проверяю «' + state.file.name + '»', stages);
    state.pending = readBytes(state.file).then(ok).then(function (buf) {
      workStage('rules', 'читаю', 0);
      return call('analyze', { buffer: buf, name: state.file.name, opts: opts() }, function (m) {
        workStage('rules', escHtml(m.phase || ''), m.total ? m.done / m.total : 0);
      }, [buf]);
    }).then(ok).then(function (m) {
      state.report = m.report;
      var n = 0; m.report.values.forEach(function (v) { n += v.count; });
      workDone('rules', 'найдено ' + fmtNum(n) + (m.report.overflow ? '+' : ''));
      return ner ? runAI() : null;
    }).then(ok).then(function () { return deep ? runLLM() : null; }).then(ok)
      .then(function () { return deep ? runReview() : null; }).then(ok)
      .then(function () { renderReview(); show('stepReview'); renderModes(); })
      .catch(function (e) { if (e && e.message === CANCEL) return; fail(e); })
      .then(function () { if (run === state.run) state.pending = null; });
  }
  $('btnBack').addEventListener('click', function () { clearErrors(); show('stepDrop'); });
  $('btnAgain').addEventListener('click', function () { state.queue = []; state.batch = null; $('txtIn').value = ''; $('btnText').disabled = true; clearErrors(); show('stepDrop'); });

  // ───────── Шаг 2: проверка ─────────
  function colKey(c) { return c.sheet + ':' + c.col; }
  function colType(c) { var k = colKey(c); var t = k in state.columns ? state.columns[k] : c.suggested; return t && state.types[t] ? t : ''; }
  function typeOn(t) { return !!state.types[t]; }
  function hidden(span) { return typeOn(span.type) && !state.skip[span.key]; }

  function renderReview() {
    var r = state.report;
    $('revName').textContent = state.isText ? 'Текст' : state.pdfInfo ? state.pdfInfo.name : r.name;
    var st = [];
    if (state.pdfInfo) st.push(fmtSize(state.pdfInfo.size), state.pdfInfo.image ? 'картинка, текст распознан' : 'PDF, ' + fmtNum(state.pdfInfo.pages) + ' стр.' + (state.pdfInfo.ocr ? ', распознано ' + state.pdfInfo.ocr : ''));
    else if (!state.isText) st.push(fmtSize(r.size));
    if (r.stats.slides != null) st.push(fmtNum(r.stats.slides) + ' ' + plural(r.stats.slides, 'слайд', 'слайда', 'слайдов'));
    else if (r.stats.rows != null) st.push(fmtNum(r.stats.rows) + ' строк');
    else if (r.stats.paragraphs != null) st.push(fmtNum(r.stats.paragraphs) + ' абзацев');
    else if (r.stats.lines != null && !state.isText) st.push(fmtNum(r.stats.lines) + ' строк');
    $('revStats').textContent = st.join(' · ');
    var warns = r.warnings.slice(), pdf = state.pdfInfo;
    if (pdf) {
      if (pdf.empty) warns.unshift('В PDF страниц без текста: ' + pdf.empty + ' из ' + pdf.pages + ' (сканы или картинки). Их содержимое не проверяется и в результат не попадёт.' +
        (canOcr() ? '' : ' Сканы распознаются, когда Обезличиватель открыт через ярлык на Mac.'));
      if (pdf.ocr) warns.unshift((pdf.image ? 'Текст распознан с картинки' : 'Текст распознан со сканов: ' + pdf.ocr + ' ' + plural(pdf.ocr, 'страница', 'страницы', 'страниц')) +
        '. Распознавание бывает неточным — номера и фамилии с опечатками правила могут не узнать. Проверьте особенно внимательно и выделите пропущенное.');
      if (!pdf.image) warns.unshift('PDF превращён в текст: ' + pdf.pages + ' ' + plural(pdf.pages, 'страница', 'страницы', 'страниц') + '. Результат — текстовый файл с отметками страниц, без вёрстки и картинок.');
      else warns.unshift('Картинка превращена в текст. Результат — текстовый файл; сама картинка в Claude не уходит.');
    }
    $('warnings').innerHTML = warns.map(function (w) { return '<div class="note warn">' + escHtml(w) + '</div>'; }).join('');

    // Переключатели типов: только те, что нашлись
    var counts = {};
    Object.keys(r.byType).forEach(function (t) { if (r.byType[t]) counts[t] = r.byType[t]; });
    r.columns.forEach(function (c) { if (c.suggested && !counts[c.suggested]) counts[c.suggested] = c.nonEmpty; });
    var types = Object.keys(counts).sort(function (a, b) { return counts[b] - counts[a]; });
    $('typeToggles').innerHTML = types.length ? types.map(function (t) {
      return '<label class="tgl"><input type="checkbox" data-type="' + t + '"' + (typeOn(t) ? ' checked' : '') + '><span class="tgl-name">' +
        escHtml(short(t)) + '</span><span class="tgl-n">' + fmtNum(counts[t]) + '</span></label>';
    }).join('') : '<p class="muted small">Ничего не нашлось. Добавьте сами справа или ниже.</p>';
    $('typeToggles').querySelectorAll('input').forEach(function (i) {
      i.addEventListener('change', function () { state.types[i.dataset.type] = i.checked; refresh(); });
    });

    // Столбцы
    $('colsCard').hidden = !r.columns.length;
    var typeOpts = Object.keys(TYPES).filter(function (t) { return t !== 'СВОЁ'; });
    $('cols').innerHTML = r.columns.map(function (c) {
      var val = colType(c);
      return '<div class="col-row' + (val ? ' pii' : '') + '"><div class="col-name"><b>' + escHtml(c.header || 'Столбец ' + c.letter) + '</b>' +
        '<span class="muted small">' + escHtml(c.samples.slice(0, 2).join(' · ')) + '</span></div>' +
        '<select data-col="' + colKey(c) + '" aria-label="Столбец ' + escHtml(c.header || c.letter) + '"><option value="">Оставить</option>' +
        typeOpts.map(function (t) { return '<option value="' + t + '"' + (t === val ? ' selected' : '') + '>Скрыть: ' + escHtml(short(t)) + '</option>'; }).join('') +
        '</select></div>';
    }).join('');
    $('cols').querySelectorAll('select').forEach(function (s) {
      s.addEventListener('change', function () {
        state.columns[s.dataset.col] = s.value;
        if (s.value) state.types[s.value] = true;
        s.closest('.col-row').classList.toggle('pii', !!s.value);
        refresh();
      });
    });

    var present = {}; r.values.forEach(function (v) { present[v.type] = 1; });
    $('fType').innerHTML = '<option value="">Все типы</option>' + Object.keys(present).map(function (t) { return '<option value="' + t + '">' + escHtml(short(t)) + '</option>'; }).join('');
    $('foundCard').hidden = !r.values.length;
    $('foundCard').open = false;
    $('btnApply').textContent = 'Скрыть';
    /*CLAUDE{*/ if (state.bridge) $('btnApply').textContent = 'Скрыть и отдать Claude'; /*}CLAUDE*/
    renderAdded();
    refresh();
  }

  function refresh() { renderPreview(); renderValues(); summary(); }

  // Предпросмотр: таблица (Excel, CSV) или абзацы (Word, текст)
  document.querySelectorAll('.seg button').forEach(function (b) {
    b.addEventListener('click', function () {
      state.view = b.dataset.view;
      document.querySelectorAll('.seg button').forEach(function (x) { x.setAttribute('aria-pressed', x === b); });
      renderPreview();
    });
  });
  function chip(type, key, text) {
    return '<mark class="tok" data-key="' + escHtml(key) + '" title="' + escHtml(text) + '">' + escHtml(chipName(type)) + '</mark>';
  }
  function spansHtml(text, spans) {
    var out = '', pos = 0, after = state.view === 'after';
    spans.forEach(function (s) {
      out += escHtml(text.slice(pos, s.s));
      var part = text.slice(s.s, s.e);
      if (after && hidden(s)) out += chip(s.type, s.key, part);
      else out += '<mark class="hl' + (hidden(s) ? '' : ' off') + '" data-key="' + escHtml(s.key) + '">' + escHtml(part) + '</mark>';
      pos = s.e;
    });
    return out + escHtml(text.slice(pos));
  }
  function renderPreview() {
    var r = state.report, after = state.view === 'after', html = '';
    if (r.table && r.table.rows.length) {
      var hdr = r.table.header, byCol = {};
      r.columns.forEach(function (c) { if (c.sheet === r.table.sheet) byCol[c.col] = c; });
      html = '<div class="scroll"><table class="tbl"><thead><tr>' + hdr.map(function (h) {
        var c = byCol[h.col], t = c && colType(c);
        return '<th' + (t ? ' class="pii"' : '') + '>' + escHtml(h.header || h.letter) + '</th>';
      }).join('') + '</tr></thead><tbody>' + r.table.rows.map(function (row) {
        var cells = {}; row.forEach(function (c) { cells[c.col] = c; });
        return '<tr>' + hdr.map(function (h) {
          var cell = cells[h.col], c = byCol[h.col], t = c && colType(c);
          if (!cell || cell.text === '') return '<td></td>';
          if (/дата/i.test(h.header || '') && /^\d{5}(\.\d+)?$/.test(cell.text) && +cell.text > 20000 && +cell.text < 80000) {
            var d = new Date(Date.UTC(1899, 11, 30) + Math.round(+cell.text) * 86400000);
            cell = { text: d.toISOString().slice(0, 10).split('-').reverse().join('.'), spans: [] };
          }
          if (t) return '<td class="pii">' + (after ? chip(t, '', cell.text) : '<mark class="hl col">' + escHtml(cell.text) + '</mark>') + '</td>';
          return '<td title="' + escHtml(cell.text) + '">' + spansHtml(cell.text, cell.spans) + '</td>';
        }).join('') + '</tr>';
      }).join('') + '</tbody></table></div>';
      $('previewHint').textContent = 'Первые строки' + (r.table.sheetName ? ' листа «' + r.table.sheetName + '»' : '') + '. Столбцы настраиваются ниже.';
    } else if (r.preview.length) {
      html = r.preview.map(function (p) { return '<p>' + spansHtml(p.text, p.spans) + '</p>'; }).join('');
      $('previewHint').textContent = 'Нажмите на подсвеченное, чтобы не скрывать. Выделите пропущенное, чтобы скрыть.';
    } else {
      html = '<p class="muted">Нет текста для предпросмотра.</p>';
    }
    $('preview').innerHTML = html;
  }
  $('preview').addEventListener('click', function (e) {
    var m = e.target.closest('mark'); if (!m || !m.dataset.key) return;
    var k = m.dataset.key;
    if (state.skip[k]) delete state.skip[k]; else state.skip[k] = true;
    refresh();
  });

  // Список всего найденного
  function filtered() {
    var t = $('fType').value, q = $('fSearch').value.trim().toLowerCase();
    return state.report.values.filter(function (v) {
      return (!t || v.type === t) && (!q || v.value.toLowerCase().indexOf(q) >= 0 || v.snippet.toLowerCase().indexOf(q) >= 0);
    });
  }
  function renderValues() {
    var list = filtered(), part = list.slice(0, state.shown);
    $('valCount').textContent = '(' + fmtNum(state.report.values.length) + (state.report.overflow ? '+' : '') + ')';
    $('values').innerHTML = part.map(function (v) {
      var on = typeOn(v.type) && !state.skip[v.key];
      var snip = escHtml(v.snippet).replace('⟦', '<mark>').replace('⟧', '</mark>');
      return '<label class="val' + (on ? '' : ' off') + '"><input type="checkbox" data-key="' + escHtml(v.key) + '"' + (on ? ' checked' : '') +
        (typeOn(v.type) ? '' : ' disabled') + '><span class="v">' + escHtml(v.value) + (v.ai || state.aiSet[v.value] ? ' <span class="ai-tag" title="Нашла нейросеть">ИИ</span>' : '') +
        (state.modelOff && state.modelOff[v.key] && state.skip[v.key] ? ' <span class="ai-tag off-tag" title="Модель решила, что это не данные">снято моделью</span>' : '') + '</span><span class="t">' + escHtml(short(v.type)) +
        '</span><span class="n">×' + fmtNum(v.count) + '</span><span class="s">' + snip +
        (on ? ' <button type="button" class="never" data-value="' + escHtml(v.value) + '" data-key="' + escHtml(v.key) + '">Не скрывать никогда</button>' : '') +
        '</span></label>';
    }).join('');
    $('moreValues').hidden = list.length <= state.shown;
    $('values').querySelectorAll('input').forEach(function (c) {
      c.addEventListener('change', function () { if (c.checked) delete state.skip[c.dataset.key]; else state.skip[c.dataset.key] = true; refresh(); });
    });
    $('values').querySelectorAll('.never').forEach(function (b) {
      b.addEventListener('click', function (e) { e.preventDefault(); neverHide(b.dataset.value, b.dataset.key); });
    });
  }

  // Слово попадает в «Никогда не скрывать» для всех следующих файлов и снимается в этом.
  function neverHide(value, key) {
    var list = lines(settings.allow);
    if (list.indexOf(value) < 0) { list.push(value); settings.allow = list.join('\n'); save('allow', settings.allow); $('setAllow').value = settings.allow; }
    if (key) state.skip[key] = true;
    state.report.values.forEach(function (v) { if (v.value === value) state.skip[v.key] = true; });
    refresh();
    toast('«' + value + '» больше не будет скрываться. Список — в «Настройках».');
  }

  // Выделили текст в предпросмотре — предлагаем скрыть его во всём файле.
  var selBtn = document.createElement('button');
  selBtn.type = 'button'; selBtn.className = 'sel-hide'; selBtn.hidden = true; selBtn.textContent = 'Скрыть';
  document.body.appendChild(selBtn);
  var selText = '';
  document.addEventListener('mouseup', function (e) {
    if (e.target === selBtn) return;
    setTimeout(function () {
      var sel = window.getSelection(), text = sel ? String(sel).trim() : '';
      var inPreview = sel && sel.rangeCount && $('preview').contains(sel.anchorNode);
      if (!inPreview || text.length < 2 || text.length > 120 || /\n/.test(text)) { selBtn.hidden = true; return; }
      var r = sel.getRangeAt(0).getBoundingClientRect();
      selText = text;
      selBtn.textContent = 'Скрыть «' + (text.length > 30 ? text.slice(0, 30) + '…' : text) + '»';
      selBtn.style.left = Math.max(8, r.left + window.scrollX) + 'px';
      selBtn.style.top = (r.bottom + window.scrollY + 6) + 'px';
      selBtn.hidden = false;
    }, 0);
  });
  selBtn.addEventListener('click', function () {
    selBtn.hidden = true;
    if (!selText || state.added.indexOf(selText) >= 0) return;
    state.added.push(selText); window.getSelection().removeAllRanges(); reanalyze();
  });

  function toast(text) {
    var t = document.createElement('div'); t.className = 'toast'; t.textContent = text;
    document.body.appendChild(t);
    setTimeout(function () { t.remove(); }, 3500);
  }
  $('fType').addEventListener('change', function () { state.shown = 150; renderValues(); });
  $('fSearch').addEventListener('input', function () { state.shown = 150; renderValues(); });
  $('moreValues').addEventListener('click', function () { state.shown += 500; renderValues(); });

  // Скрыть ещё: добавляем правило и ищем заново
  function renderAdded() {
    $('added').innerHTML = state.added.map(function (a, i) {
      return '<span class="chip">' + escHtml(a) + '<button type="button" data-i="' + i + '" aria-label="Убрать">×</button></span>';
    }).join('');
    $('added').querySelectorAll('button').forEach(function (b) {
      b.addEventListener('click', function () { state.added.splice(+b.dataset.i, 1); reanalyze(); });
    });
  }
  function reanalyze(quiet) {
    var keep = { skip: state.skip, columns: state.columns, types: state.types, added: state.added };
    var p = quiet ? function () {} : progressTo('Ищу заново');
    return readBytes(state.file).then(function (buf) {
      return call('analyze', { buffer: buf, name: state.file.name, opts: opts() }, p, [buf]);
    }).then(function (m) {
      state.report = m.report; state.skip = keep.skip; state.columns = keep.columns; state.types = keep.types;
      renderReview(); if (!quiet) show('stepReview');
    }).catch(fail);
  }
  function addRule() {
    var v = $('addInput').value.trim(); if (!v) return;
    state.added.push(v); $('addInput').value = ''; reanalyze();
  }
  $('btnAdd').addEventListener('click', addRule);
  $('addInput').addEventListener('keydown', function (e) { if (e.key === 'Enter') addRule(); });

  function summary() {
    var r = state.report; if (!r) return;
    var n = 0;
    r.values.forEach(function (v) { if (typeOn(v.type) && !state.skip[v.key]) n += v.count; });
    r.columns.forEach(function (c) { if (colType(c)) n += c.nonEmpty; });
    state.estimate = n;
    $('applySummary').innerHTML = n ? 'Будет скрыто: <b>' + fmtNum(n) + (r.overflow ? '+' : '') + '</b>' : 'Скрывать нечего';
  }

  // ───────── Шаг 3: результат ─────────
  $('btnApply').addEventListener('click', function () {
    var d = { skip: Object.keys(state.skip), columns: state.columns, types: state.types };
    var p = progressTo('Скрываю данные');
    call('apply', { decisions: d }, p).then(function (m) {
      state.result = m;
      if (state.bridge) return sendToBridge(m);
      return done(m);
    }).catch(fail);
  });

  function outName(name, suffix) {
    var dot = name.lastIndexOf('.'), base = dot > 0 ? name.slice(0, dot) : name, ext = dot > 0 ? name.slice(dot) : '';
    return base + suffix + ext;
  }
  function keyName(name) { var dot = name.lastIndexOf('.'); return (dot > 0 ? name.slice(0, dot) : name) + '.ключ.json'; }
  function setDownload(a, blob, name) { if (a._url) URL.revokeObjectURL(a._url); a._url = URL.createObjectURL(blob); a.href = a._url; a.download = name; }
  function total(c) { var n = 0; for (var k in c || {}) n += c[k]; return n; }

  function done(m) {
    // Показываем то же число, что было на шаге проверки: по ячейкам и упоминаниям, а не по уникальным значениям.
    var name = state.file.name, n = state.estimate || total(m.counts);
    setDownload($('dlKey'), new Blob([JSON.stringify(m.key, null, 1)], { type: 'application/json' }), keyName(m.maskedName || name));
    $('doneTitle').textContent = n ? 'Скрыто: ' + fmtNum(n) : 'Готово';
    /*CLAUDE{*/ $('btnToClaude').hidden = LOCAL || !appMode || state.isText; $('btnToClaude').textContent = 'Передать в Claude'; $('btnToClaude').disabled = false; /*}CLAUDE*/
    $('dlFile').className = appMode && !LOCAL && !state.isText ? 'ghost btn' : 'primary btn'; $('dlFile').textContent = 'Скачать файл';
    $('doneActions').hidden = false; $('keyNote').hidden = false; $('btnAgain').hidden = false;
    var p = Promise.resolve();
    if (state.isText) {
      p = (m.text != null ? Promise.resolve(m.text) : m.blob.text()).then(function (t) {
        $('txtOut').value = t.replace(/^﻿/, '');
        $('doneText').textContent = 'Скопируйте текст и отправьте в Claude.';
        $('doneTextOut').hidden = false; $('dlFile').hidden = true; $('btnCopyOut').hidden = false;
      });
    } else {
      setDownload($('dlFile'), m.blob, outName(m.maskedName || name, ' (скрыто)'));
      $('doneText').textContent = (appMode ? 'Передайте файл в Claude или скачайте его. ' : 'Отправьте этот файл в Claude. ') + fmtSize(m.blob.size) + '.';
      $('doneTextOut').hidden = true; $('dlFile').hidden = false; $('btnCopyOut').hidden = true;
    }
    renderCheck(m);
    var q = state.queue && state.queue.length;
    $('nextNote').hidden = !q;
    if (q) $('nextText').textContent = 'Файл ' + state.batch.n + ' из ' + state.batch.total + '. Дальше: «' + state.queue[0].name + '»' +
      (state.queue.length > 1 ? ' и ещё ' + (state.queue.length - 1) : '') + '. Метки будут общими.';
    return p.then(function () { show('stepDone'); });
  }

  // Проверка результата: в записанном файле ищем всё, что должно было скрыться.
  function renderCheck(m) {
    var box = $('checkNote'), leaks = m.leaks || [];
    if (!m.checked) { box.hidden = true; return; }
    box.hidden = false;
    if (!leaks.length) {
      box.className = 'check-note ok';
      box.innerHTML = '✓ Проверено: в результате нет ни одного из ' + fmtNum(m.checked) + ' найденных значений.';
      return;
    }
    var n = leaks.reduce(function (a, l) { return a + l.count; }, 0);
    box.className = 'check-note warn';
    box.innerHTML = '<b>В результате остались настоящие значения: ' + fmtNum(n) + '.</b> Их не узнали в другом месте файла: ' +
      leaks.slice(0, 6).map(function (l) { return '«' + escHtml(l.value) + '»' + (l.count > 1 ? ' ×' + l.count : ''); }).join(', ') +
      (leaks.length > 6 ? ' и ещё ' + (leaks.length - 6) : '') + '.' +
      '<div class="row-start"><button class="primary small-btn" id="btnFixLeaks" type="button">Скрыть и их</button></div>';
    $('btnFixLeaks').addEventListener('click', function () {
      leaks.forEach(function (l) { var r = (l.type || 'СВОЁ') + ': ' + l.value; if (state.added.indexOf(r) < 0) state.added.push(r); });
      reanalyze().then(function () { $('btnApply').click(); });
    });
  }

  // Отчёт для информационной безопасности: что и как скрыто — без самих значений.
  $('btnReport').addEventListener('click', function () {
    var m = state.result, r = state.report; if (!m || !r) return;
    var counts = m.counts || {}, lines = [], d = new Date(), pad = function (x) { return (x < 10 ? '0' : '') + x; };
    var name = state.isText ? 'текст из буфера' : (m.maskedName || r.name);
    lines.push('ОТЧЁТ ОБ ОБЕЗЛИЧИВАНИИ', '');
    lines.push('Дата и время: ' + pad(d.getDate()) + '.' + pad(d.getMonth() + 1) + '.' + d.getFullYear() + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()));
    lines.push('Файл: ' + name + (state.isText ? '' : ' (' + fmtSize(r.size) + ', имя тоже обезличено)'));
    if (state.pdfInfo) lines.push('Исходный формат: ' + (state.pdfInfo.image ? 'картинка, текст распознан (Apple Vision, на этом компьютере)' :
      'PDF, ' + state.pdfInfo.pages + ' стр.' + (state.pdfInfo.ocr ? ', распознано со сканов: ' + state.pdfInfo.ocr : '') +
      (state.pdfInfo.empty ? ', без текста: ' + state.pdfInfo.empty : '')) + '; результат — текст');
    lines.push('Где обработано: на этом компьютере, без передачи в интернет');
    lines.push('Проверка: ' + (state.modeUsed || 'быстрая'));
    lines.push('Метод: замена персональных данных метками [ТИП-n] и новыми идентификаторами того же вида; таблица соответствия (ключ) хранится отдельно у пользователя');
    lines.push('', 'Скрыто: ' + fmtNum(state.estimate || total(counts)));
    Object.keys(counts).sort(function (a, b) { return counts[b] - counts[a]; }).forEach(function (t) { lines.push('  ' + short(t) + ': ' + fmtNum(counts[t])); });
    var cols = r.columns.filter(function (c) { return colType(c); });
    if (cols.length) { lines.push('', 'Столбцы скрыты целиком:'); cols.forEach(function (c) { lines.push('  «' + (c.header || 'Столбец ' + c.letter) + '» → ' + short(colType(c))); }); }
    var off = Object.keys(state.types || {}).filter(function (t) { return state.types[t] === false && r.byType[t]; });
    if (off.length) lines.push('', 'Типы, которые пользователь решил не скрывать: ' + off.map(short).join(', '));
    var manual = Object.keys(state.skip).length - Object.keys(state.modelOff || {}).length;
    if (manual > 0) lines.push('Оставлено вручную после проверки: ' + manual);
    if (state.modelOff && Object.keys(state.modelOff).length) lines.push('Снято моделью как не персональные данные: ' + Object.keys(state.modelOff).length);
    if (state.added.length) lines.push('Добавлено вручную: ' + state.added.length);
    lines.push('', 'Проверка результата: ' + (!m.checked ? 'не требовалась' : (m.leaks || []).length ?
      'найдены оставшиеся значения — ' + m.leaks.reduce(function (a, l) { return a + l.count; }, 0) + ' (значения в отчёт не включаются)' :
      'в результате нет ни одного из ' + m.checked + ' найденных значений'));
    if (r.warnings.length) { lines.push('', 'Предупреждения:'); r.warnings.forEach(function (w) { lines.push('  ' + w); }); }
    lines.push('', 'Отчёт не содержит персональных данных. Ключ к отчёту не прикладывается.');
    var file = new Blob(['\ufeff' + lines.join('\r\n') + '\r\n'], { type: 'text/plain' });
    var a = document.createElement('a'); a.href = URL.createObjectURL(file);
    a.download = keyName(name).replace(/\.ключ\.json$/, '') + ' — отчёт.txt';
    document.body.appendChild(a); a.click(); setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  });
  $('btnCopyOut').addEventListener('click', function () { copy($('txtOut'), $('btnCopyOut')); });

  /*CLAUDE{*/
  $('btnToClaude').addEventListener('click', function () {
    var m = state.result, name = outName(m.maskedName || state.file.name, ' (обезличено)');
    openModal('Передать в Claude',
      '<ol class="how"><li><b>Обезличенная копия</b> сохранится на этом Mac в папке <code>Обезличиватель/Обезличенные</code> под именем «' + escHtml(name) + '».</li>' +
      '<li><b>Claude прочитает её, когда вы попросите.</b> Файл не привязан к одной сессии: его увидит любой чат Claude Code на этом компьютере — Обезличиватель подключён ко всем вашим проектам. Скопируйте запрос ниже и вставьте в нужный чат.</li>' +
      '<li><b>Ключ</b> сохранится в <code>Обезличиватель/.ключи</code>. Claude его прочитать не может; по нему потом вернутся настоящие данные.</li></ol>' +
      '<p class="muted small">В интернет страница ничего не отправляет. В Claude уходит только обезличенный текст — и только когда Claude его читает.</p>',
      [{ label: 'Передать', primary: true, onClick: function (b) {
          b.disabled = true; b.textContent = 'Передаю…';
          fetch('/api/app/save?name=' + encodeURIComponent(name), { method: 'POST', headers: H, body: m.blob })
            .then(function (r) { if (!r.ok) throw new Error('Не удалось сохранить файл: ' + r.status); return r.json(); })
            .then(function (saved) {
              return fetch('/api/app/key', { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, H), body: JSON.stringify({ key: m.keyUsed, name: saved.name }) })
                .then(function () { return saved; });
            }).then(function (saved) {
              var prompt = 'Я передал обезличенный файл «' + saved.name + '» через Обезличиватель. Найди его (obezl_masked) и прочитай (obezl_read), затем ';
              $('btnToClaude').textContent = 'Передано'; $('btnToClaude').disabled = true;
              openModal('Файл передан',
                '<p>Копия лежит здесь: <code>' + escHtml(saved.path) + '</code></p>' +
                '<p>Вставьте в чат Claude Code запрос и допишите задачу:</p><textarea id="promptOut" rows="4" readonly>' + escHtml(prompt) + '</textarea>',
                [{ label: 'Скопировать запрос', primary: true, onClick: function (btn) { copy($('promptOut'), btn); } }, { label: 'Закрыть' }]);
            }).catch(function (e) { b.disabled = false; b.textContent = 'Передать'; openModal('Не получилось', '<p>' + escHtml(human(e)) + '</p>', [{ label: 'Закрыть' }]); });
        } }, { label: 'Отмена' }]);
  });
  /*}CLAUDE*/

  $('btnKeyHelp').addEventListener('click', function () {
    var why = '<p><b>Зачем он нужен.</b> Если обезличенный текст потом обработали (например, нейросетью), в нём остаются метки: «[ФИО-3] просит перезвонить». ' +
      'Чтобы вернуть настоящие имена, откройте вкладку «Вернуть данные», выберите ключ и вставьте текст.</p>' +
      '<p><b>Важно.</b> В ключе настоящие данные. Храните его у себя и не пересылайте вместе с обезличенным файлом.</p>';
    /*CLAUDE{*/
    if (!LOCAL) why = '<p><b>Зачем он нужен.</b> Claude отвечает с метками: «[ФИО-3] просит перезвонить». Чтобы получить ответ с настоящими именами, откройте вкладку «Вернуть данные», выберите ключ и вставьте ответ Claude.</p>' +
      '<p><b>Важно.</b> В ключе настоящие данные. Не отправляйте его в Claude и не пересылайте.</p>' +
      (appMode ? '<p class="muted small">Если вы нажали «Передать в Claude», ключ уже сохранён в папке <code>Обезличиватель/.ключи</code> — скачивать не обязательно, «Вернуть данные» подхватит его сам.</p>' : '');
    /*}CLAUDE*/
    openModal('Что такое ключ',
      '<p>Ключ — это файл-шпаргалка: какая метка что заменила. Например, <code>[ФИО-3]</code> → Петрова Анна Сергеевна, <code>[ТЕЛЕФОН-1]</code> → +7 916 123-45-67.</p>' + why,
      [{ label: 'Понятно', primary: true }]);
  });

  /*CLAUDE{*/
  // Запуск через ярлык: общая нумерация меток со всеми прошлыми файлами (ключ этого Mac).
  if (appMode && !LOCAL && !new URLSearchParams(location.search).get('job')) {
    fetch('/api/app/key', { headers: H }).then(function (r) { return r.ok ? r.json() : null; }).then(function (k) {
      if (!k) return;
      if (!state.prevKey) state.prevKey = k;
      if (Object.keys(k.tokens || {}).length && !rKey) { rKey = k; $('rKeyInfo').textContent = 'Общий ключ этого Mac · значений: ' + fmtNum(Object.keys(k.tokens).length); }
    }).catch(function () {});
  }

  // ───────── Режим «для Claude»: страницу открыл MCP-сервер ─────────
  var sendToBridge = null;
  var qs = new URLSearchParams(location.search);
  if (!LOCAL && qs.get('job') && location.protocol === 'http:') {
    state.bridge = { job: qs.get('job'), t: qs.get('t') };
    var api = function (p) { return '/api/' + p + '?job=' + encodeURIComponent(state.bridge.job) + '&t=' + encodeURIComponent(state.bridge.t); };
    $('bridge').hidden = false;
    $('bridge').innerHTML = '<b>Файл от Claude.</b> Проверьте и нажмите «Скрыть и отдать Claude». Ключ останется у вас.';
    $('stepDrop').hidden = true;
    fetch(api('job')).then(function (r) { if (!r.ok) throw new Error('Задание не найдено или уже выполнено.'); return r.json(); }).then(function (j) {
      if (j.rules) settings.rules = [settings.rules].concat(j.rules).join('\n');
      if (j.allow) settings.allow = [settings.allow].concat(j.allow).join('\n');
      if (j.key) state.prevKey = j.key;
      return fetch(api('file')).then(function (r) { return r.blob(); }).then(function (b) {
        start(new File([b], j.name, { type: b.type }), false);
      });
    }).catch(function (e) { $('bridge').className = 'note err'; $('bridge').textContent = e.message; });

    sendToBridge = function (m) {
      var p = progressTo('Передаю файл Claude');
      p({ phase: '', done: 0, total: 1 });
      return fetch(api('result') + '&name=' + encodeURIComponent(outName(m.maskedName || state.file.name, ' (обезличено)')), { method: 'POST', body: m.blob })
        .then(function (r) { if (!r.ok) throw new Error('Не удалось передать файл: ' + r.status); })
        .then(function () { return fetch(api('key'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: m.keyUsed, counts: m.counts, report: brief() }) }); })
        .then(function (r) { if (!r.ok) throw new Error('Не удалось сохранить ключ: ' + r.status); })
        .then(function () {
          $('doneTitle').textContent = 'Файл у Claude';
          $('doneText').textContent = 'Скрыто: ' + fmtNum(state.estimate || total(m.counts)) + '. Копия лежит в папке «Обезличиватель/Обезличенные». Её можно скачать и сюда.';
          setDownload($('dlFile'), m.blob, outName(m.maskedName || state.file.name, ' (скрыто)'));
          setDownload($('dlKey'), new Blob([JSON.stringify(m.key, null, 1)], { type: 'application/json' }), keyName(m.maskedName || state.file.name));
          $('btnToClaude').hidden = true; $('dlFile').className = 'primary btn';
          $('dlFile').textContent = 'Скачать обезличенный файл';
          $('doneActions').hidden = false; $('dlFile').hidden = false; $('btnCopyOut').hidden = true;
          $('keyNote').hidden = false; $('btnAgain').hidden = true; $('doneTextOut').hidden = true;
          renderCheck(m); $('nextNote').hidden = true;
          show('stepDone');
        }).catch(fail);
    };
  }
  /*}CLAUDE*/
  function brief() {
    var r = state.report; if (!r) return {};
    return { kind: r.kind, stats: r.stats, byType: r.byType, columns: r.columns.map(function (c) {
      return { sheet: c.sheetName, letter: c.letter, header: c.header, hidden: colType(c) };
    }), warnings: (state.pdfInfo ? [(state.pdfInfo.image ? 'Исходный файл — картинка, текст распознан (возможны опечатки распознавания)'
      : 'Исходный файл — PDF (' + state.pdfInfo.pages + ' стр.), превращён в текст с отметками страниц' +
        (state.pdfInfo.ocr ? '; со сканов распознано страниц: ' + state.pdfInfo.ocr + ' (возможны опечатки распознавания)' : '') +
        (state.pdfInfo.empty ? '; страниц без текста, их содержимое не попало в файл: ' + state.pdfInfo.empty : '')) + '.'] : []).concat(r.warnings) };
  }

  function copy(el, btn) {
    el.select();
    var ok = function () { if (btn) { var t = btn.textContent; btn.textContent = 'Скопировано'; setTimeout(function () { btn.textContent = t; }, 1500); } };
    try { navigator.clipboard.writeText(el.value).then(ok, function () { document.execCommand('copy'); ok(); }); } catch (e) { document.execCommand('copy'); ok(); }
  }

  // ───────── Вернуть данные ─────────
  rFile = null;
  $('btnRKey').addEventListener('click', function () { $('rKey').click(); });
  $('btnRFile').addEventListener('click', function () { $('rFile').click(); });
  function readKey(f) {
    return f.text().then(function (t) {
      var k = JSON.parse(t); if (k.format !== 'obezlichivatel-key') throw new Error('Это не ключ Обезличивателя');
      return k;
    });
  }
  $('rKey').addEventListener('change', function () {
    var f = this.files[0]; if (!f) return;
    readKey(f).then(function (k) { rKey = k; $('rKeyInfo').textContent = f.name + ' · значений: ' + fmtNum(Object.keys(k.tokens || {}).length); })
      .catch(function (e) { rKey = null; $('rKeyInfo').textContent = e.message; });
  });
  $('rFile').addEventListener('change', function () { rFile = this.files[0] || null; $('rFileName').textContent = rFile ? rFile.name : 'Файл или текст ниже'; });
  $('btnRestore').addEventListener('click', function () {
    if (!rKey) { $('rKeyInfo').textContent = 'Сначала выберите ключ'; $('rKeyInfo').className = 'err-text small'; return; }
    var text = $('rText').value;
    if (!rFile && !text.trim()) { $('rFileName').textContent = 'Выберите файл или вставьте текст'; $('rFileName').className = 'err-text small'; return; }
    $('rBarWrap').hidden = false;
    var bar = function (m) { $('rBar').style.width = (m.total ? Math.round(m.done / m.total * 100) : 0) + '%'; };
    var job = rFile
      ? readBytes(rFile).then(function (buf) { return call('restore', { buffer: buf, name: rFile.name, key: rKey }, bar, [buf]); })
      : call('restore', { text: text, key: rKey }, bar);
    job.then(function (m) {
      $('rBarWrap').hidden = true; $('rOutCard').hidden = false;
      $('rCount').textContent = '· возвращено ' + fmtNum(m.count) + (m.missing ? ', нет в ключе ' + m.missing : '');
      if (m.blob) {
        $('rOut').hidden = true; $('btnCopyR').hidden = true; $('dlR').hidden = false;
        setDownload($('dlR'), m.blob, outName(rFile.name.replace(' (скрыто)', '').replace(' (обезличено)', ''), ' (с данными)'));
      } else {
        $('rOut').hidden = false; $('btnCopyR').hidden = false; $('dlR').hidden = true; $('rOut').value = m.text;
      }
    }).catch(function (e) { $('rBarWrap').hidden = true; $('rFileName').textContent = human(e); $('rFileName').className = 'err-text small'; });
  });
  $('btnCopyR').addEventListener('click', function () { copy($('rOut'), $('btnCopyR')); });

  // ───────── Настройки ─────────
  $('typeBoxes').innerHTML = Object.keys(TYPES).map(function (t) {
    var on = t in settings.types ? settings.types[t] : TYPES[t].on;
    return '<label><input type="checkbox" data-type="' + t + '"' + (on ? ' checked' : '') + '> ' + escHtml(short(t)) + '</label>';
  }).join('');
  $('typeBoxes').addEventListener('change', function (e) {
    var t = e.target.dataset.type; if (!t) return; settings.types[t] = e.target.checked; save('types', settings.types);
  });
  $('setRules').value = settings.rules; $('setAllow').value = settings.allow;
  $('setRules').addEventListener('input', function () { settings.rules = this.value; save('rules', settings.rules); });
  $('setAllow').addEventListener('input', function () { settings.allow = this.value; save('allow', settings.allow); });
  document.querySelectorAll('input[name=idMode]').forEach(function (r) {
    r.checked = r.value === settings.idMode;
    r.addEventListener('change', function () { if (r.checked) { settings.idMode = r.value; save('idMode', r.value); } });
  });
  $('btnPrevKey').addEventListener('click', function () { $('prevKey').click(); });
  $('prevKey').addEventListener('change', function () {
    var f = this.files[0]; if (!f) return;
    readKey(f).then(function (k) { state.prevKey = k; $('prevKeyInfo').textContent = f.name + ' загружен'; })
      .catch(function (e) { $('prevKeyInfo').textContent = e.message; });
  });
})();
