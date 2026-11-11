/* Обезличиватель — фоновый поток. Вся тяжёлая работа здесь, чтобы страница не зависала.
 * Сообщения: analyze → analyzed, apply → applied, restore → restored, maskText → maskedText.
 */
(function () {
  'use strict';
  var job = null;   // { blob, name, kind, session, state, opts }

  // Файл в памяти с тем же интерфейсом, что у Blob: size, slice, arrayBuffer, stream.
  // Нужен из-за Safari: на странице, открытой из файла, воркер не может читать никакие Blob —
  // ни файл с диска, ни созданный в памяти. Поэтому воркер работает только с байтами.
  function MemBlob(u8) { this.u8 = u8; this.size = u8.byteLength; }
  MemBlob.prototype.slice = function (a, b) {
    a = Math.max(0, a || 0); b = b == null ? this.size : Math.min(this.size, b);
    return new MemBlob(this.u8.subarray(a, Math.max(a, b)));
  };
  MemBlob.prototype.arrayBuffer = function () { return Promise.resolve(this.u8.slice().buffer); };
  MemBlob.prototype.stream = function () {
    var u = this.u8, pos = 0, CHUNK = 1 << 20;
    return new ReadableStream({
      pull: function (c) {
        if (pos >= u.length) { c.close(); return; }
        var end = Math.min(u.length, pos + CHUNK);
        c.enqueue(u.slice(pos, end)); pos = end;
      }
    });
  };
  function source(msg) { return msg.buffer ? new MemBlob(new Uint8Array(msg.buffer)) : msg.file; }

  function post(type, data, transfer) { self.postMessage(Object.assign({ type: type }, data || {}), transfer || []); }
  var lastTick = 0;
  function progress(phase, done, total) {
    var now = Date.now();
    if (now - lastTick < 120 && done < total) return;
    lastTick = now;
    post('progress', { phase: phase, done: done, total: total });
  }

  function makeSession(opts) {
    return new Engine.Session({ types: opts.types, rules: opts.rules, allow: opts.allow, key: opts.key, idMode: opts.idMode, people: opts.people });
  }

  async function analyze(msg) {
    // Байты приходят из основного потока: Safari не даёт воркеру читать файл с диска на странице, открытой из файла.
    var t0 = Date.now(), blob = source(msg), name = msg.name;
    var kind = await Office.sniff(blob, name);
    var session = makeSession(msg.opts || {});
    var r;
    if (kind === 'xlsx') r = await Office.xlsxAnalyze(blob, name, session, progress);
    else if (kind === 'docx') r = await Office.docxAnalyze(blob, name, session, progress);
    else if (kind === 'pptx') r = await Office.pptxAnalyze(blob, name, session, progress);
    else r = await Office.textAnalyze(blob, name, kind, session, progress);
    var rep = r.report.toJSON();
    job = { blob: blob, name: name, kind: kind, session: session, state: r.state, opts: msg.opts || {}, values: rep.values };
    rep.elapsed = Date.now() - t0;
    post('analyzed', { report: rep });
  }

  async function apply(msg) {
    if (!job) throw new Error('Сначала выберите файл.');
    var t0 = Date.now(), d = msg.decisions || {}, s = job.session;
    s.used = Object.create(null);
    if (d.types) for (var k in d.types) s.types[k] = !!d.types[k];
    s.setSkip(d.skip || []);
    var res, checker = makeChecker(job.values, d);
    Zip.setInspector(checker ? checker.check : null);
    try {
      if (job.kind === 'xlsx') res = await Office.xlsxApply(job.blob, job.state, s, d, progress);
      else if (job.kind === 'docx') res = await Office.docxApply(job.blob, job.state, s, progress);
      else if (job.kind === 'pptx') res = await Office.pptxApply(job.blob, job.state, s, progress);
      else res = await Office.textApply(job.blob, job.state, s, d, job.kind, progress);
    } finally { Zip.setInspector(null); }
    // Имя файла тоже обезличиваем: «Иванова Анна отчёт.docx» → «[ФИО-1] отчёт.docx»
    var dot = job.name.lastIndexOf('.'), base = dot > 0 ? job.name.slice(0, dot) : job.name;
    var maskedName = s.maskText(base) + (dot > 0 ? job.name.slice(dot) : '');
    if (checker) checker.check('name', maskedName);
    var leaks = checker ? checker.result() : [];
    var key = s.exportKey({ file: job.name });
    var keyUsed = s.exportKey({ file: job.name }, true);
    post('applied', { maskedName: maskedName, blob: res.blob, text: res.text, counts: res.counts, key: key, keyUsed: keyUsed, kind: job.kind,
                      leaks: leaks, checked: checker ? checker.size : 0, elapsed: Date.now() - t0 });
  }

  // ───────── Проверка результата ─────────
  // Всё, что нашлось и должно скрыться, ищем в записанном файле: в тексте (куски Word склеены по абзацам),
  // в атрибутах авторов, в имени файла. Поиск по индексу первого слова — быстро даже на десятках мегабайт.
  var WORD = /[\p{L}\p{N}][\p{L}\p{N}_@.\-]*/gu;
  function firstWord(v) { WORD.lastIndex = 0; var m = WORD.exec(v); return m ? m[0].replace(/[._@\-]+$/, '') : null; }
  function unesc(s) {
    return s.indexOf('&') < 0 ? s : s.replace(/&(?:#(\d+)|#x([0-9a-fA-F]+)|(amp|lt|gt|quot|apos));/g, function (m, d, h, n) {
      return d ? String.fromCodePoint(+d) : h ? String.fromCodePoint(parseInt(h, 16)) : { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[n];
    });
  }
  function checkable(v) {
    if (v.length < 4) return false;
    if (/^[\d\s.,\-–+()]+$/.test(v)) return v.replace(/\D/g, '').length >= 6;    // короткие числа встречаются и сами по себе
    return /[\p{L}\p{N}]/u.test(v);
  }
  function makeChecker(values, d) {
    var skip = Object.create(null), types = d.types || {};
    (d.skip || []).forEach(function (k) { skip[k] = 1; });
    var byFirst = new Map(), size = 0, typeOf = Object.create(null);
    function add(v, type) {
      v = String(v).trim();
      if (!checkable(v) || typeOf[v]) return;
      var f = firstWord(v); if (!f) return;
      typeOf[v] = type; size++;
      if (!byFirst.has(f)) byFirst.set(f, []);
      byFirst.get(f).push(v);
    }
    (values || []).forEach(function (v) {
      if (skip[v.key] || types[v.type] === false || v.type === 'ID') return;     // ID заменены новыми ID того же вида
      add(v.value, v.type);
      // Фамилия из ФИО отдельно: «Петрова Анна Сергеевна» скрыта, а «Петрова» где-то осталась — тоже утечка.
      if (v.type === 'ФИО') String(v.value).split(/\s+/).forEach(function (w) {
        if (w.length >= 5 && /^[СS]/i.test(Engine.classify(w) || '') && /^[А-ЯЁ]/.test(w)) add(w, 'ФИО');
      });
    });
    if (!size) return null;
    byFirst.forEach(function (list) { list.sort(function (a, b) { return b.length - a.length; }); });
    var hits = Object.create(null);
    function scan(text) {
      WORD.lastIndex = 0; var m;
      while ((m = WORD.exec(text))) {
        var list = byFirst.get(m[0].replace(/[._@\-]+$/, ''));
        if (!list) continue;
        for (var i = 0; i < list.length; i++) {
          var v = list[i];
          if (text.startsWith(v, m.index) && !/[\p{L}\p{N}]/u.test(text.charAt(m.index + v.length))) { hits[v] = (hits[v] || 0) + 1; break; }
        }
      }
    }
    return {
      size: size,
      check: function (name, text) {
        if (/\.(?:xml|rels)$/i.test(name)) {
          var attrs = [];
          text.replace(/\s(?:w:author|w15:author|author|displayName|name|initials|userId)="([^"]*)"/g, function (m, v) { attrs.push(v); return m; });
          text = text.replace(/<\/(?:w:p|a:p|si|row|c|p:text|text)>|<(?:w:br|w:cr|a:br|w:tab)\b[^>]*\/>/g, '\n').replace(/<[^>]*>/g, '') + '\n' + attrs.join('\n');
          text = unesc(text);
        }
        scan(text);
      },
      result: function () {
        return Object.keys(hits).map(function (v) { return { value: v, type: typeOf[v], count: hits[v] }; })
          .sort(function (a, b) { return b.count - a.count; });
      }
    };
  }

  async function restore(msg) {
    if (msg.text != null) {
      var r = Engine.unmaskText(msg.text, msg.key);
      post('restored', { text: r.text, count: r.count });
      return;
    }
    var res = await Office.restoreFile(source(msg), msg.name, msg.key, progress);
    post('restored', { blob: res.blob, count: res.count, missing: res.missing, kind: res.kind });
  }

  function maskText(msg) {
    var s = makeSession(msg.opts || {});
    var found = s.detect(msg.text);
    found.forEach(function (f) { s.notePerson(f); });
    s.linkPeople();
    var text = s.maskText(msg.text);
    post('maskedText', { text: text, key: s.exportKey({ file: 'текст' }), found: found.length });
  }

  // Тексты для умной проверки.
  function segments() {
    post('segments', { texts: job && job.session.segs ? job.session.segs : [] });
  }
  // Тексты для глубокой проверки: найденное правилами уже заменено на [ТИП], повторы убраны.
  function maskedSegments() {
    var s = job.session, out = [], seen = Object.create(null);
    (s.segs || []).forEach(function (t) {
      var m = '', pos = 0;
      s.detect(t).forEach(function (f) { m += t.slice(pos, f.s) + '[' + f.type + ']'; pos = f.e; });
      m += t.slice(pos);
      var rest = m.replace(/\[[^\]]+\]/g, '').replace(/[\s\d.,:;()\-–—|\/"'«»]+/g, '');
      if (rest.length < 3 || seen[m]) return;
      seen[m] = 1; out.push(m);
    });
    post('maskedSegments', { texts: out });
  }

  // Из найденного нейросетью оставляем то, что правила ещё не нашли.
  function aiFilter(msg) {
    var known = job ? job.session : new Engine.Session(), values = Object.create(null);
    (msg.texts || []).forEach(function (text, i) {
      var spans = (msg.results || [])[i] || [];
      if (!spans.length) return;
      var rule = known.detect(text).filter(function (f) { return f.type === 'ФИО' && !f.ai; });
      spans.forEach(function (sp) {
        var covered = rule.some(function (f) { return f.s < sp.e && sp.s < f.e; });   // правила уже нашли этого человека
        if (covered || Engine.uiNameAt(text, sp.s, sp.text)) return;                 // «Справочник Сидорова» — часть системы
        values[sp.text] = true;
      });
    });
    post('aiFiltered', { values: Object.keys(values) });
  }

  self.onmessage = function (ev) {
    var msg = ev.data, fn = { analyze: analyze, apply: apply, restore: restore, maskText: maskText, segments: segments, aiFilter: aiFilter, maskedSegments: maskedSegments }[msg.cmd];
    if (!fn) return;
    Promise.resolve().then(function () { return fn(msg); }).catch(function (e) {
      post('error', { message: e && e.message ? e.message : String(e) });
    });
  };
})();
