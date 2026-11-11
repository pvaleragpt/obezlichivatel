/* Обезличиватель — Excel, Word и текстовые файлы.
 *
 * Два прохода, оба потоком:
 *   1. analyze — найти всё, что похоже на персональные данные, и собрать отчёт для проверки:
 *      столбцы таблиц с предложенным типом, уникальные находки с количеством, превью текста.
 *   2. apply — с учётом решений пользователя записать новый файл. Форматирование, формулы
 *      в остальных ячейках, стили и картинки сохраняются: меняется только текст с данными.
 *
 * Плюс restore — вернуть данные по ключу в обработанный файл.
 */
var Office = (function () {
  'use strict';

  // ───────────────────────── XML ─────────────────────────

  var ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
  function unesc(s) {
    if (s.indexOf('&') < 0) return s;
    return s.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);/g, function (m, e) {
      if (ENT[e]) return ENT[e];
      return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    });
  }
  function esc(s) { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  function escAttr(s) { return esc(s).replace(/"/g, '&quot;'); }

  // ───────────────────────── Отчёт ─────────────────────────

  var MAX_VALUES = 20000, MAX_PREVIEW = 300;

  function Report(kind, name, size) {
    this.kind = kind; this.name = name; this.size = size;
    this.byType = {}; this.values = new Map(); this.overflow = 0;
    this.columns = []; this.preview = []; this.table = null; this.warnings = []; this.stats = {};
  }
  Report.prototype.add = function (f, count, snippet) {
    count = count || 1;
    this.byType[f.type] = (this.byType[f.type] || 0) + count;
    var v = this.values.get(f.key);
    if (v) { v.count += count; return; }
    if (this.values.size >= MAX_VALUES) { this.overflow++; return; }
    this.values.set(f.key, { key: f.key, type: f.type, value: f.value, count: count, snippet: snippet || '', ai: !!f.ai });
  };
  Report.prototype.toJSON = function () {
    var vals = Array.from(this.values.values()).sort(function (a, b) { return b.count - a.count; });
    return { kind: this.kind, name: this.name, size: this.size, byType: this.byType, values: vals,
             overflow: this.overflow, columns: this.columns, preview: this.preview, table: this.table, warnings: this.warnings, stats: this.stats };
  };
  // Первые строки таблицы для превью «было / станет».
  var TABLE_ROWS = 8;
  function tableAdd(report, sheet, sheetName, header, cells, session) {
    if (!report.table) report.table = { sheet: sheet, sheetName: sheetName, header: header, rows: [] };
    if (report.table.sheet !== sheet || report.table.rows.length >= TABLE_ROWS) return;
    report.table.rows.push(cells.map(function (c) {
      var spans = c.typed ? [] : session.detect(c.text).map(function (f) { return { s: f.s, e: f.e, type: f.type, key: f.key }; });
      return { col: c.col, text: c.text.slice(0, 300), spans: spans.filter(function (s) { return s.e <= 300; }) };
    }));
  }

  function snippetOf(text, f) {
    var a = Math.max(0, f.s - 40), b = Math.min(text.length, f.e + 40);
    return (a > 0 ? '…' : '') + text.slice(a, f.s) + '⟦' + text.slice(f.s, f.e) + '⟧' + text.slice(f.e, b) + (b < text.length ? '…' : '');
  }

  // ───────────────────────── Замена в «прогонах» текста ─────────────────────────
  // Текст абзаца в Word разбит на куски (<w:t>), имя может оказаться разрезано
  // между ними. Склеиваем куски, ищем в склейке, раскладываем замены обратно.

  function joinNodes(nodes, gaps) {
    var text = '', ranges = [];
    for (var i = 0; i < nodes.length; i++) {
      var own = text.length;
      if (i > 0 && gaps && gaps[i]) text += gaps[i];
      var a = text.length; text += nodes[i]; ranges.push({ own: own, a: a, b: text.length });
    }
    return { text: text, ranges: ranges };
  }

  // spans: [{s, e, rep}] по склейке, по возрастанию s, без перекрытий.
  // Замена целиком уходит в тот кусок, где начинается находка; из следующих кусков
  // покрытый текст просто вырезается — разметка (жирный, курсив) остаётся на месте.
  function splitBack(joined, spans) {
    if (!spans.length) return null;
    var text = joined.text, R = joined.ranges, out = [];
    for (var i = 0; i < R.length; i++) {
      var r = R[i], nextOwn = i + 1 < R.length ? R[i + 1].own : Infinity, res = '', pos = r.a;
      for (var k = 0; k < spans.length; k++) {
        var sp = spans[k];
        if (sp.s >= nextOwn) break;
        if (sp.s < r.own) {                       // началась раньше: вырезаем покрытое
          if (sp.e > pos) pos = Math.min(sp.e, r.b);
          continue;
        }
        var at = Math.min(Math.max(sp.s, r.a), r.b);
        if (at > pos) res += text.slice(pos, at);
        res += sp.rep;
        pos = Math.max(pos, Math.min(Math.max(sp.e, at), r.b));
      }
      if (pos < r.b) res += text.slice(pos, r.b);
      out.push(res);
    }
    return out;
  }

  // Найти и заменить в наборе кусков. tool — Session (маскировка) или Restorer (возврат).
  function processNodes(tool, nodes, gaps, hint, onFind) {
    var j = joinNodes(nodes, gaps);
    if (!j.text.trim()) return null;
    var found = tool.detect(j.text, hint);
    if (!found.length) return null;
    if (onFind) onFind(j.text, found);
    if (tool.analyzeOnly) return null;
    var spans = found.map(function (f) { return { s: f.s, e: f.e, rep: tool.tokenFor(f) }; });
    return splitBack(j, spans);
  }

  // Возврат данных: «находки» — это метки из ключа.
  function Restorer(key) { this.key = key; this.count = 0; this.missing = 0; }
  Restorer.prototype.detect = function (text) {
    var self = this, out = [], pos = 0;
    Engine.findRestorable(text, this.key).forEach(function (f) {
      if (f.s < pos) return;
      if (f.value == null) { self.missing++; return; }
      out.push({ s: f.s, e: f.e, value: f.value }); pos = f.e;
    });
    return out;
  };
  Restorer.prototype.text = function (s) {
    var fs = this.detect(s); if (!fs.length) return s;
    var out = '', pos = 0, self = this;
    fs.forEach(function (f) { out += s.slice(pos, f.s) + self.tokenFor(f); pos = f.e; });
    return out + s.slice(pos);
  };
  Restorer.prototype.tokenFor = function (f) { this.count++; return f.value; };

  // ───────────────────────── Определение формата ─────────────────────────

  async function sniff(blob, name) {
    var ext = (name.split('.').pop() || '').toLowerCase();
    var head = new Uint8Array(await blob.slice(0, 8).arrayBuffer());
    var isZip = head[0] === 0x50 && head[1] === 0x4b;
    var isOle = head[0] === 0xD0 && head[1] === 0xCF && head[2] === 0x11 && head[3] === 0xE0;
    if (isOle) {
      if (ext === 'xlsx' || ext === 'docx' || ext === 'pptx') throw new Error('Файл зашифрован паролем. Откройте его, снимите пароль (Файл → Сведения → Защита) и сохраните заново.');
      throw new Error('Это старый формат (.' + ext + '). Откройте файл и сохраните как .' + (ext === 'xls' ? 'xlsx' : ext === 'ppt' ? 'pptx' : 'docx') + ' — тогда он обработается.');
    }
    if (isZip) {
      if (/^xls[xm]$/.test(ext)) return 'xlsx';
      if (/^doc[xm]$/.test(ext)) return 'docx';
      if (/^ppt[xm]$/.test(ext)) return 'pptx';
      var entries = await Zip.readEntries(blob);
      if (entries.some(function (e) { return e.name === 'xl/workbook.xml'; })) return 'xlsx';
      if (entries.some(function (e) { return e.name === 'word/document.xml'; })) return 'docx';
      if (entries.some(function (e) { return e.name === 'ppt/presentation.xml'; })) return 'pptx';
      throw new Error('Архив, но не Word, Excel или PowerPoint. Поддерживаются .docx, .xlsx, .pptx, .csv, .txt, .md, .json, .vtt, .srt.');
    }
    if (ext === 'pdf') throw new Error('PDF сначала превращается в текст на странице — откройте его через «Выбрать файл».');
    if (ext === 'csv' || ext === 'tsv') return 'csv';
    return 'text';
  }

  // ───────────────────────── Excel ─────────────────────────

  var CELL_RE = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
  var ROW_RE = /<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g;

  function colIndex(letters) { var n = 0; for (var i = 0; i < letters.length; i++) n = n * 26 + letters.charCodeAt(i) - 64; return n - 1; }
  function colName(i) { var s = ''; i++; while (i > 0) { var m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = (i - m - 1) / 26; } return s; }
  function attr(attrs, name) { var m = new RegExp('(?:^|\\s)' + name + '="([^"]*)"').exec(attrs); return m ? m[1] : null; }
  function tTexts(xml) {
    var out = [], re = /<t(?:\s[^>]*)?>([^<]*)<\/t>/g, m;
    xml = xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '');
    while ((m = re.exec(xml))) out.push(unesc(m[1]));
    return out.join('');
  }
  function numText(v) {
    if (!/[eE]/.test(v)) return v;
    var n = Number(v);
    return Number.isFinite(n) && Math.abs(n) < 1e21 ? n.toLocaleString('en-US', { useGrouping: false, maximumFractionDigits: 10 }) : v;
  }
  function serialToDate(v) {
    var n = Number(v); if (!(n > 1 && n < 80000)) return v;
    var d = new Date(Date.UTC(1899, 11, 30) + Math.round(n * 86400000));
    function p(x) { return (x < 10 ? '0' : '') + x; }
    return p(d.getUTCDate()) + '.' + p(d.getUTCMonth() + 1) + '.' + d.getUTCFullYear();
  }

  function resolvePath(base, target) {
    if (target[0] === '/') return target.slice(1);
    var parts = (base + target).split('/'), out = [];
    parts.forEach(function (p) { if (p === '..') out.pop(); else if (p !== '.') out.push(p); });
    return out.join('/');
  }

  async function xlsxStructure(blob) {
    var entries = await Zip.readEntries(blob), by = {};
    entries.forEach(function (e) { by[e.name] = e; });
    var wb = await Zip.entryText(blob, by['xl/workbook.xml']);
    var rels = by['xl/_rels/workbook.xml.rels'] ? await Zip.entryText(blob, by['xl/_rels/workbook.xml.rels']) : '';
    var relMap = {}, sstPath = null, m, re = /<Relationship\b([^>]*)\/?>/g;
    while ((m = re.exec(rels))) {
      var id = attr(m[1], 'Id'), target = attr(m[1], 'Target'), type = attr(m[1], 'Type') || '';
      if (!id || !target) continue;
      relMap[id] = resolvePath('xl/', target);
      if (/\/sharedStrings$/.test(type)) sstPath = relMap[id];
    }
    var sheets = [], sre = /<sheet\b([^>]*)\/?>/g;
    while ((m = sre.exec(wb))) {
      var rid = (/\b[\w]+:id="([^"]+)"/.exec(m[1]) || [])[1];
      var path = relMap[rid];
      if (path && by[path]) sheets.push({ name: unesc(attr(m[1], 'name') || ''), path: path, hidden: /state="(?:hidden|veryHidden)"/.test(m[1]) });
    }
    if (!sstPath && by['xl/sharedStrings.xml']) sstPath = 'xl/sharedStrings.xml';
    return { entries: entries, by: by, sheets: sheets, sstPath: sstPath };
  }

  async function loadSst(blob, entry, progress) {
    var sst = [];
    if (!entry) return sst;
    await Zip.eachChunk(blob, entry, '</si>', function (chunk) {
      var re = /<si>([\s\S]*?)<\/si>|<si\/>/g, m;
      while ((m = re.exec(chunk))) sst.push(m[1] ? tTexts(m[1]) : '');
    }, progress);
    return sst;
  }

  // Разбор строк листа: вызывает onRow(rowNum, cells) для каждой строки.
  // cells: [{col, t, v, inline, attrs, raw}]
  function parseRow(attrs, inner, rowCounter) {
    var rn = Number(attr(attrs, 'r')) || rowCounter, cells = [], m, ci = -1;
    if (!inner) return { row: rn, cells: cells };
    CELL_RE.lastIndex = 0;
    while ((m = CELL_RE.exec(inner))) {
      var a = m[1], body = m[2] || '', r = attr(a, 'r');
      ci = r ? colIndex(r.replace(/\d+/g, '')) : ci + 1;
      var t = attr(a, 't') || 'n', v = (/<v>([^<]*)<\/v>/.exec(body) || [])[1];
      var cell = { col: ci, t: t, attrs: a, raw: m[0] };
      if (t === 'inlineStr') cell.text = tTexts((/<is>([\s\S]*?)<\/is>/.exec(body) || [, ''])[1]);
      else if (t === 's') cell.idx = v != null ? Number(v) : -1;
      else if (t === 'str') cell.text = v != null ? unesc(v) : '';
      else if (t === 'n' && v != null) cell.num = v;
      else if (t === 'd' && v != null) cell.text = v;
      cells.push(cell);
    }
    return { row: rn, cells: cells };
  }

  function cellText(cell, sst) {
    if (cell.t === 's') return cell.idx >= 0 ? (sst[cell.idx] || '') : '';
    if (cell.text != null) return cell.text;
    if (cell.num != null) return numText(cell.num);
    return '';
  }

  // Выбор строки заголовков среди первых строк листа.
  function pickHeader(rows, sst) {
    var best = null, bestHits = 0;
    rows.forEach(function (r) {
      var hits = 0;
      r.cells.forEach(function (c) { if (c.t === 's' || c.t === 'inlineStr' || c.t === 'str') if (Engine.classifyHeader(cellText(c, sst))) hits++; });
      if (hits > bestHits) { bestHits = hits; best = r; }
    });
    if (best) return best;
    for (var i = 0; i < rows.length; i++) {
      var texts = rows[i].cells.filter(function (c) { return (c.t === 's' || c.t === 'inlineStr') && cellText(c, sst).trim(); });
      if (texts.length >= 2) return rows[i];
    }
    return null;
  }

  var HEAD_ROWS = 30, SAMPLE_ROWS = 300;

  async function xlsxAnalyze(blob, name, session, progress) {
    var st = await xlsxStructure(blob), report = new Report('xlsx', name, blob.size);
    var by = st.by;
    var total = st.sheets.reduce(function (a, s) { return a + by[s.path].usize; }, 0) + (st.sstPath ? by[st.sstPath].usize : 0);
    var doneBase = 0;
    function prog(phase) { return function (d) { progress(phase, doneBase + d, total); }; }

    var sst = await loadSst(blob, by[st.sstPath], prog('Читаю общие строки'));
    if (st.sstPath) doneBase += by[st.sstPath].usize;
    var usage = new Uint32Array(sst.length), sstType = new Array(sst.length);
    var sheetMeta = [], cellsTotal = 0, rowsTotal = 0;

    for (var si = 0; si < st.sheets.length; si++) {
      var sh = st.sheets[si], e = by[sh.path];
      var meta = { index: si, name: sh.name, headerRow: null, columns: {} };
      sheetMeta.push(meta);
      var head = [], buffer = [], decided = false, rowCounter = 0;

      var decide = function () {
        var hr = pickHeader(head, sst);
        meta.headerRow = hr ? hr.row : 0;
        if (hr) hr.cells.forEach(function (c) {
          var h = cellText(c, sst).trim();
          meta.columns[c.col] = { header: h, byHeader: Engine.classifyHeader(h), samples: [], nonEmpty: 0 };
        });
        head.forEach(function (r) { if (r.row > meta.headerRow) buffer.push(r); });
        buffer.forEach(function (r) { sample(r); });
        Object.keys(meta.columns).forEach(function (k) {
          var c = meta.columns[k];
          c.suggested = c.byHeader || session.classifyValues(c.samples);
          if (!c.suggested && c.samples.length) {
            // Столбец без заголовка-подсказки, но с датами в «возрастном» диапазоне — не трогаем:
            // это может быть что угодно. Решит пользователь.
          }
        });
        decided = true;
        buffer.forEach(function (r) { data(r); });
        buffer = [];
      };
      var sample = function (r) {
        r.cells.forEach(function (c) {
          var col = meta.columns[c.col] || (meta.columns[c.col] = { header: '', byHeader: null, samples: [], nonEmpty: 0 });
          var t = cellText(c, sst);
          if (t !== '' && col.samples.length < SAMPLE_ROWS) col.samples.push(t);
        });
      };
      var data = function (r) {
        rowsTotal++;
        if (!report.table || (report.table.sheet === si && report.table.rows.length < TABLE_ROWS)) {
          var hdr = Object.keys(meta.columns).sort(function (a, b) { return a - b; }).map(function (k) { return { col: +k, letter: colName(+k), header: meta.columns[k].header }; });
          tableAdd(report, si, sh.name, hdr, r.cells.map(function (c) {
            var col = meta.columns[c.col] || {};
            return { col: c.col, text: cellText(c, sst), typed: !!col.suggested };
          }), session);
        }
        r.cells.forEach(function (c) {
          var col = meta.columns[c.col] || (meta.columns[c.col] = { header: '', byHeader: null, samples: [], nonEmpty: 0, suggested: null });
          var t = cellText(c, sst);
          if (t === '') return;
          col.nonEmpty++; cellsTotal++;
          if (col.suggested) {
            if (c.t === 's') { if (!sstType[c.idx]) sstType[c.idx] = col.suggested; usage[c.idx]++; }
            report.byType[col.suggested] = (report.byType[col.suggested] || 0) + (c.t === 's' ? 0 : 1);
            if (col.suggested === 'ФИО' && c.t !== 's') session.detect(t, 'ФИО').forEach(function (f) { session.notePerson(f); });
            if (col.suggested === 'ID') session.reserveId(c.num != null ? numText(c.num) : t);
            return;
          }
          if (c.t === 's') { if (c.idx >= 0) usage[c.idx]++; return; }
          if (c.num == null) session.collect(t);
          var fs = session.detect(c.num != null ? numText(c.num) : t);
          fs.forEach(function (f) { session.notePerson(f); report.add(f, 1, (col.header ? col.header + ': ' : '') + snippetOf(t, f)); });
        });
      };

      await Zip.eachChunk(blob, e, '</row>', function (chunk) {
        ROW_RE.lastIndex = 0; var m;
        while ((m = ROW_RE.exec(chunk))) {
          rowCounter++;
          var r = parseRow(m[1], m[2], rowCounter); rowCounter = r.row;
          if (!decided) {
            head.push(r);
            if (head.length >= HEAD_ROWS + SAMPLE_ROWS) decide();
          } else data(r);
        }
      }, prog('Лист «' + sh.name + '»'));
      if (!decided) decide();
      doneBase += e.usize;

      Object.keys(meta.columns).sort(function (a, b) { return a - b; }).forEach(function (k) {
        var c = meta.columns[k];
        if (!c.nonEmpty && !c.header) return;
        report.columns.push({ sheet: si, sheetName: sh.name, col: Number(k), letter: colName(Number(k)), header: c.header,
          suggested: c.suggested || '', samples: c.samples.filter(function (x) { return String(x).trim(); }).slice(0, 4), nonEmpty: c.nonEmpty });
      });
    }

    // Общие строки: в столбцах с данными — счётчики, в остальных — поиск.
    progress('Ищу данные в тексте ячеек', 0, sst.length);
    for (var i = 0; i < sst.length; i++) {
      if (sstType[i]) {
        report.byType[sstType[i]] = (report.byType[sstType[i]] || 0) + usage[i];
        if (sstType[i] === 'ФИО') session.detect(sst[i], 'ФИО').forEach(function (f) { session.notePerson(f); });
        if (sstType[i] === 'ID') session.reserveId(sst[i]);
        continue;
      }
      var text = sst[i];
      if (!text || text.length < 2) continue;
      session.collect(text);
      var fs = session.detect(text);
      for (var q = 0; q < fs.length; q++) { session.notePerson(fs[q]); report.add(fs[q], usage[i] || 1, snippetOf(text, fs[q])); }
      if (i % 20000 === 0) progress('Ищу данные в тексте ячеек', i, sst.length);
    }
    session.linkPeople();

    st.entries.forEach(function (e) {
      if (/^xl\/media\//.test(e.name)) report._img = (report._img || 0) + 1;
      if (/vbaProject\.bin$/.test(e.name)) report.warnings.push('В файле есть макросы (VBA): их код не проверяется и останется в файле.');
      if (/^xl\/connections\.xml$/.test(e.name)) report.warnings.push('Файл подключён к внешним источникам данных: в настройках подключений могут быть адреса серверов и логины.');
      if (/^xl\/externalLinks\//.test(e.name)) report.warnings.push('Есть связи с другими книгами: их кэш тоже проверяется, но путь к файлам останется.');
    });
    if (report._img) report.warnings.push('Картинок в файле: ' + report._img + '. Их содержимое (сканы, скриншоты) не проверяется.');
    report.warnings = Array.from(new Set(report.warnings));
    st.sheets.forEach(function (s) { if (s.hidden) report.warnings.push('Скрытый лист «' + s.name + '» тоже обработан.'); });
    report.stats = { sheets: st.sheets.length, rows: rowsTotal, cells: cellsTotal, strings: sst.length };
    return { report: report, state: { st: st, sheetMeta: sheetMeta, sst: sst } };
  }

  // Прочие части книги и документа: комментарии, диаграммы, свойства.
  function maskMiscXml(xml, tool, name) {
    if (/docProps\/core\.xml$/.test(name)) {
      xml = xml.replace(/(<(dc:creator|cp:lastModifiedBy)\b[^>]*>)([^<]*)(<\/\2>)/g, '$1$4');
    }
    if (/docProps\/app\.xml$/.test(name)) {
      xml = xml.replace(/(<(Manager)\b[^>]*>)([^<]*)(<\/\2>)/g, '$1$4');
    }
    // Авторы комментариев и правок — как ФИО.
    xml = xml.replace(/(\s(?:w:author|w15:author|displayName|author)=")([^"]*)(")/g, function (m, a, v, b) {
      var t = unesc(v).trim(); if (!t) return m;
      var fs = tool.detect(t, tool instanceof Restorer ? undefined : 'ФИО');
      if (!fs.length || tool.analyzeOnly) return m;
      return a + escAttr(fs.length === 1 && fs[0].s === 0 && fs[0].e === t.length ? tool.tokenFor(fs[0]) : t) + b;
    });
    if (/ppt\/(?:commentAuthors|authors)\.xml$/.test(name)) {
      xml = xml.replace(/(\sname=")([^"]*)(")/g, function (m, a, v, b) {
        var t = unesc(v).trim(); if (!t) return m;
        var fs = tool.detect(t, tool instanceof Restorer ? undefined : 'ФИО');
        if (!fs.length || tool.analyzeOnly) return m;
        return a + escAttr(fs.length === 1 && fs[0].s === 0 && fs[0].e === t.length ? tool.tokenFor(fs[0]) : t) + b;
      });
    }
    xml = xml.replace(/(\s(?:userId|w:initials|initials)=")([^"]*)(")/g, function (m, a, v, b) { return tool instanceof Restorer ? m : a + b; });
    xml = xml.replace(/(<author>)([^<]*)(<\/author>)/g, function (m, a, v, b) {
      var fs = tool.detect(unesc(v), 'ФИО'); return fs.length && !tool.analyzeOnly ? a + esc(tool.tokenFor(fs[0])) + b : m;
    });
    // Текстовые узлы: <t>, <a:t>, <c:v>, <text>, <dc:title> и т. п.
    xml = xml.replace(/(<((?:\w+:)?(?:t|v|text|title|subject|description|keywords|Company|vt:lpwstr))\b[^>]*>)([^<]+)(<\/\2>)/g, function (m, a, tag, v, b) {
      var t = unesc(v), fs = tool.detect(t);
      if (!fs.length || tool.analyzeOnly) return m;
      var out = '', pos = 0;
      fs.forEach(function (f) { out += t.slice(pos, f.s) + tool.tokenFor(f); pos = f.e; });
      return a + esc(out + t.slice(pos)) + b;
    });
    // Значения в кэше сводных таблиц и ссылки mailto:
    xml = xml.replace(/(<s\s+v=")([^"]*)(")/g, function (m, a, v, b) {
      var t = unesc(v), fs = tool.detect(t);
      if (!fs.length || tool.analyzeOnly) return m;
      var out = '', pos = 0;
      fs.forEach(function (f) { out += t.slice(pos, f.s) + tool.tokenFor(f); pos = f.e; });
      return a + escAttr(out + t.slice(pos)) + b;
    });
    xml = xml.replace(/(Target="mailto:)([^"?]*)/g, function (m, a, v) {
      var fs = tool.detect(unesc(v)); return fs.length && !tool.analyzeOnly ? a + escAttr(tool.tokenFor(fs[0])) : m;
    });
    return xml;
  }

  var XLSX_MISC = /^(?:docProps\/(?:core|app|custom)\.xml|xl\/(?:comments\d*|threadedComments\/[^/]+|persons\/[^/]+|charts\/chart\d+|drawings\/drawing\d+|pivotCache\/pivotCache(?:Definition|Records)\d+|externalLinks\/externalLink\d+|tables\/table\d+)\.xml|customXml\/item\d+\.xml)$/;

  async function xlsxApply(blob, state, session, decisions, progress) {
    var st = state.st, by = st.by, w = new Zip.Writer();
    var colType = {};    // 'лист:столбец' → тип
    state.sheetMeta.forEach(function (meta) {
      Object.keys(meta.columns).forEach(function (k) {
        var key = meta.index + ':' + k, d = decisions.columns && key in decisions.columns ? decisions.columns[key] : meta.columns[k].suggested;
        if (d && session.types[d]) colType[key] = d;
      });
    });
    var sstHint = new Array(state.sst.length);
    var sheetPaths = {}; st.sheets.forEach(function (s, i) { sheetPaths[s.path] = i; });
    var total = st.entries.reduce(function (a, e) { return a + (sheetPaths[e.name] != null || e.name === st.sstPath || XLSX_MISC.test(e.name) ? e.usize : 0); }, 0);
    var doneBase = 0, counts = {};
    function bump(t) { counts[t] = (counts[t] || 0) + 1; }

    function maskCellText(text, type) {
      var fs = session.detect(text, type), out = '', pos = 0;
      fs.forEach(function (f) { out += text.slice(pos, f.s) + session.tokenFor(f); pos = f.e; bump(f.type); });
      return fs.length ? out + text.slice(pos) : null;
    }
    function inlineCell(attrs, text) {
      var a = attrs.replace(/\s+t="[^"]*"/, '');
      return '<c' + a + ' t="inlineStr"><is><t xml:space="preserve">' + esc(text) + '</t></is></c>';
    }
    // Число или дата в ячейке стали меткой: в ключе запоминаем исходное число, чтобы вернуть ячейку числом
    // (с её форматом), а не текстом «20.05.2015».
    function numCell(attrs, masked, raw) {
      var tok = masked && session.key && session.key.tokens[masked];
      if (tok && raw != null && /^\[[^\]]+-\d+\]$/.test(masked)) tok.num = raw;
      return inlineCell(attrs, masked);
    }

    var ordered = st.entries.slice().sort(function (a, b) {
      function rank(e) { return e.name === '[Content_Types].xml' ? 0 : e.name === st.sstPath ? 2 : 1; }
      return rank(a) - rank(b);
    });

    for (var n = 0; n < ordered.length; n++) {
      var e = ordered[n], si = sheetPaths[e.name];
      if (si != null) {
        var meta = state.sheetMeta[si], out = w.open(e.name), rowCounter = 0;
        await Zip.eachChunk(blob, e, '</row>', async function (chunk) {
          var res = chunk.replace(ROW_RE, function (rowXml, rattrs, inner) {
            rowCounter++;
            var rn = Number(attr(rattrs, 'r')) || rowCounter; rowCounter = rn;
            if (!inner) return rowXml;
            var ci = -1, isData = rn > meta.headerRow;
            var newInner = inner.replace(CELL_RE, function (cellXml, a, body) {
              body = body || '';
              var r = attr(a, 'r'); ci = r ? colIndex(r.replace(/\d+/g, '')) : ci + 1;
              var t = attr(a, 't') || 'n', type = isData ? colType[si + ':' + ci] : null;
              var v = (/<v>([^<]*)<\/v>/.exec(body) || [])[1];
              if (t === 's') {
                if (type && v != null && !sstHint[+v]) sstHint[+v] = type;
                return cellXml;
              }
              var text = t === 'inlineStr' ? tTexts((/<is>([\s\S]*?)<\/is>/.exec(body) || [, ''])[1])
                       : t === 'str' || t === 'd' ? (v != null ? unesc(v) : '')
                       : t === 'n' && v != null ? numText(v) : null;
              if (text == null || text === '') return cellXml;
              if (type) {
                if (type === 'ID' && t === 'n') {
                  var ps = maskCellText(text, 'ID');
                  if (ps && /^\d+$/.test(ps)) return cellXml.replace(/<v>[^<]*<\/v>/, '<v>' + ps + '</v>');
                  return inlineCell(a, ps || text);
                }
                if (type === 'ДАТА_РОЖДЕНИЯ' && t === 'n') text = serialToDate(v);
                var mt = maskCellText(text, type);
                return t === 'n' ? numCell(a, mt || text, v) : inlineCell(a, mt || text);
              }
              var masked = maskCellText(text);
              return masked == null ? cellXml : t === 'n' ? numCell(a, masked, v) : inlineCell(a, masked);
            });
            return rowXml.replace(inner, function () { return newInner; });
          });
          await out.write(res);
        }, function (d) { progress('Лист «' + st.sheets[si].name + '»', doneBase + d, total); });
        await out.close(); doneBase += e.usize;
      } else if (e.name === st.sstPath) {
        var out2 = w.open(e.name), idx = 0;
        await Zip.eachChunk(blob, e, '</si>', async function (chunk) {
          var res = chunk.replace(/<si>([\s\S]*?)<\/si>|<si\/>/g, function (m, inner) {
            var i = idx++;
            if (!inner) return m;
            var hint = sstHint[i], nodes = [], re = /<t(\s[^>]*)?>([^<]*)<\/t>/g, mm, pos = [], skip = [];
            var rp = /<rPh\b[\s\S]*?<\/rPh>/g, x;
            while ((x = rp.exec(inner))) skip.push([x.index, x.index + x[0].length]);
            while ((mm = re.exec(inner))) {
              var at0 = mm.index;
              if (skip.some(function (s) { return at0 >= s[0] && at0 < s[1]; })) continue;
              nodes.push(unesc(mm[2])); pos.push({ at: at0, len: mm[0].length });
            }
            if (!nodes.length) return m;
            var news = processNodes(session, nodes, null, hint, function (txt, fs) { fs.forEach(function (f) { bump(f.type); }); });
            if (!news) return m;
            var outXml = '', last = 0;
            pos.forEach(function (p, k) {
              outXml += inner.slice(last, p.at) + '<t xml:space="preserve">' + esc(news[k]) + '</t>';
              last = p.at + p.len;
            });
            return '<si>' + outXml + inner.slice(last) + '</si>';
          });
          await out2.write(res);
        }, function (d) { progress('Общие строки', doneBase + d, total); });
        await out2.close(); doneBase += e.usize;
      } else if (XLSX_MISC.test(e.name)) {
        var xml = await Zip.entryText(blob, e);
        await w.addText(e.name, maskMiscXml(xml, session, e.name));
        doneBase += e.usize;
      } else {
        await w.copy(blob, e);
      }
    }
    return { blob: w.finish('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'), counts: counts };
  }

  // ───────────────────────── Word ─────────────────────────

  var DOCX_MAIN = /^word\/(?:document|header\d*|footer\d*|footnotes|endnotes|comments|glossary\/document)\.xml$/;
  var DOCX_MISC = /^(?:docProps\/(?:core|app|custom)\.xml|word\/(?:people|commentsExtended|commentsExtensible|commentsIds)\.xml|word\/_rels\/document\.xml\.rels|word\/(?:charts\/chart\d+|diagrams\/data\d+|diagrams\/drawing\d+)\.xml|customXml\/item\d+\.xml)$/;
  var WTOK = /<w:tbl[\s>]|<\/w:tbl>|<w:tr[\s>]|<w:tc[\s>]|<w:p[\s>\/]|<\/w:p>|<w:tab\b[^>]*\/>|<w:br\b[^>]*\/>|<w:cr\b[^>]*\/>|<w:(t|delText|instrText)(\s[^>]*)?>([^<]*)<\/w:\1>/g;

  // PowerPoint: тот же подход, другая разметка — абзацы <a:p>, текст <a:t>, таблицы <a:tbl>.
  var ATOK = /<a:tbl[\s>]|<\/a:tbl>|<a:tr[\s>]|<a:tc[\s>]|<a:p[\s>\/]|<\/a:p>|<a:br\b[^>]*\/>|<a:(t)(\s[^>]*)?>([^<]*)<\/a:t>/g;
  var DIALECT = {
    w: { tok: WTOK, ns: 'w', para: /^<w:p[\s>\/]|^<\/w:p>/, br: /^<w:(?:br|cr)\b/, tab: /^<w:tab\b/, end: '</w:p>' },
    a: { tok: ATOK, ns: 'a', para: /^<a:p[\s>\/]|^<\/a:p>/, br: /^<a:br\b/, tab: /^$/, end: '</a:p>' }
  };

  // Таблицы Word и PowerPoint: где мы сейчас (строка, столбец) и какие столбцы скрываются целиком по заголовку.
  function TableState(ns) { this.stack = []; this.ns = ns || 'w'; }
  TableState.prototype.cur = function () { return this.stack[this.stack.length - 1]; };
  TableState.prototype.tag = function (tok) {
    var p = '<' + this.ns + ':';
    if (tok.indexOf(p + 'tbl') === 0) this.stack.push({ row: -1, col: -1, heads: {}, types: {}, headerRow: -1 });
    else if (tok === '</' + this.ns + ':tbl>') this.stack.pop();
    else if (this.cur() && tok.indexOf(p + 'tr') === 0) { this.cur().row++; this.cur().col = -1; }
    else if (this.cur() && tok.indexOf(p + 'tc') === 0) this.cur().col++;
  };
  // Текст ячейки: в строке заголовка запоминаем тип столбца, в строках ниже — возвращаем его.
  TableState.prototype.hint = function (text) {
    var t = this.cur();
    if (!t || t.col < 0) return undefined;
    if (t.headerRow < 0 || t.row === t.headerRow) {
      var h = Engine.classifyHeader(text.trim());
      if (h) { t.types[t.col] = h; t.headerRow = t.row; }
      return undefined;
    }
    return t.row > t.headerRow ? t.types[t.col] : undefined;
  };

  // Пройти по кускам текста абзацев. onSeg(nodes, gaps, hintFromTable) → новые тексты или null.
  function docxChunk(chunk, onSeg, table, D) {
    D = D || DIALECT.w;
    var seg = [], gaps = [], pend = '', repl = [], TOK = D.tok;
    function flush() {
      if (seg.length) {
        var tableHint = table ? table.hint(seg.map(function (s) { return s.text; }).join('')) : undefined;
        var news = onSeg(seg.map(function (s) { return s.text; }), gaps, tableHint);
        if (news) seg.forEach(function (s, i) { if (news[i] !== s.text) repl.push({ s: s, text: news[i] }); });
      }
      seg = []; gaps = []; pend = '';
    }
    TOK.lastIndex = 0; var m;
    while ((m = TOK.exec(chunk))) {
      var tok = m[0];
      if (m[1]) {
        var isInstr = m[1] === 'instrText';
        var open = '<' + D.ns + ':' + m[1] + (m[2] || '') + '>';
        gaps.push(pend + (isInstr ? ' ' : '')); pend = isInstr ? ' ' : '';
        seg.push({ at: m.index, len: tok.length, open: open, tag: m[1], text: unesc(m[3]) });
      } else if (D.tab.test(tok)) pend += '\t';
      else if (D.br.test(tok)) pend += '\n';
      else if (D.para.test(tok)) flush();
      else { flush(); if (table) table.tag(tok); }
    }
    flush();
    if (!repl.length) return null;
    var out = '', last = 0;
    repl.forEach(function (r) {
      var open = r.s.open;
      if (/^\s|\s$/.test(r.text) && !/xml:space=/.test(open)) open = open.replace(/>$/, ' xml:space="preserve">');
      out += chunk.slice(last, r.s.at) + open + esc(r.text) + '</' + D.ns + ':' + r.s.tag + '>';
      last = r.s.at + r.s.len;
    });
    return out + chunk.slice(last);
  }

  async function docxAnalyze(blob, name, session, progress) {
    var entries = await Zip.readEntries(blob), report = new Report('docx', name, blob.size);
    var parts = entries.filter(function (e) { return DOCX_MAIN.test(e.name); });
    var total = parts.reduce(function (a, e) { return a + e.usize; }, 0), doneBase = 0, paragraphs = 0;
    for (var i = 0; i < parts.length; i++) {
      var e = parts[i], isMain = e.name === 'word/document.xml', money = new Engine.MoneyContext(), table = new TableState();
      await Zip.eachChunk(blob, e, '</w:p>', function (chunk) {
        docxChunk(chunk, function (nodes, gaps, tableHint) {
          paragraphs++;
          var j = joinNodes(nodes, gaps);
          if (!j.text.trim()) return null;
          session.collect(j.text);
          var hint = tableHint || (money.cell(j.text) ? 'ДЕНЬГИ' : undefined);
          var fs = session.detect(j.text, hint);
          if (tableHint === 'ФИО') fs.forEach(function (f) { session.notePerson(f); });
          fs.forEach(function (f) { session.notePerson(f); report.add(f, 1, snippetOf(j.text, f)); });
          if (isMain && report.preview.length < MAX_PREVIEW) {
            report.preview.push({ text: j.text.slice(0, 2000), spans: fs.filter(function (f) { return f.e <= 2000; })
              .map(function (f) { return { s: f.s, e: f.e, type: f.type, key: f.key }; }) });
          }
          return null;
        }, table);
      }, function (d) { progress(isMain ? 'Текст документа' : 'Колонтитулы и сноски', doneBase + d, total); });
      doneBase += e.usize;
    }
    // Авторы правок и комментариев, свойства файла.
    for (var k = 0; k < entries.length; k++) {
      var me = entries[k];
      if (!(DOCX_MISC.test(me.name) || DOCX_MAIN.test(me.name)) || me.usize > 50 * 1024 * 1024) continue;
      var xml = await Zip.entryText(blob, me), m, re = /\s(?:w:author|w15:author)="([^"]*)"/g, seen = {};
      while ((m = re.exec(xml))) {
        var a = unesc(m[1]).trim(); if (!a || seen[a]) continue; seen[a] = 1;
        session.detect(a, 'ФИО').forEach(function (f) { session.notePerson(f); report.add(f, 1, 'Автор правки или комментария: ' + a); });
      }
      if (/docProps\/core\.xml$/.test(me.name)) {
        var cr = /<dc:creator>([^<]*)<\/dc:creator>|<cp:lastModifiedBy>([^<]*)<\/cp:lastModifiedBy>/g;
        var whos = [];
        while ((m = cr.exec(xml))) { var who = unesc(m[1] || m[2] || ''); if (who && whos.indexOf(who) < 0) whos.push(who); }
        if (whos.length) report.warnings.push('Авторы в свойствах файла будут удалены: ' + whos.join(', ').replace(/\.$/, '') + '.');
      }
    }
    session.linkPeople();
    entries.forEach(function (e) {
      if (/^word\/media\//.test(e.name)) report._img = (report._img || 0) + 1;
      if (/^word\/embeddings\//.test(e.name)) report.warnings.push('В документ встроены другие файлы (таблицы, объекты): их содержимое не проверяется. Лучше удалить их перед отправкой.');
      if (/vbaProject\.bin$/.test(e.name)) report.warnings.push('В файле есть макросы: их код не проверяется.');
    });
    if (report._img) report.warnings.push('Картинок в документе: ' + report._img + '. Их содержимое (сканы, скриншоты, подписи) не проверяется.');
    report.warnings = Array.from(new Set(report.warnings));
    report.stats = { paragraphs: paragraphs };
    return { report: report, state: { entries: entries } };
  }

  async function docxApply(blob, state, tool, progress, mime) {
    var entries = state.entries, w = new Zip.Writer(), counts = {};
    var total = entries.reduce(function (a, e) { return a + (DOCX_MAIN.test(e.name) ? e.usize : 0); }, 0), doneBase = 0;
    for (var i = 0; i < entries.length; i++) {
      var e = entries[i];
      if (DOCX_MAIN.test(e.name)) {
        var out = w.open(e.name), money = new Engine.MoneyContext(), table = new TableState();
        await Zip.eachChunk(blob, e, '</w:p>', async function (chunk) {
          var res = docxChunk(chunk, function (nodes, gaps, tableHint) {
            var hint = tool instanceof Restorer ? undefined : tableHint || (money.cell(joinNodes(nodes, gaps).text) ? 'ДЕНЬГИ' : undefined);
            return processNodes(tool, nodes, gaps, hint, function (t, fs) { fs.forEach(function (f) { counts[f.type || 'метки'] = (counts[f.type || 'метки'] || 0) + 1; }); });
          }, table);
          res = maskMiscAttrs(res == null ? chunk : res, tool);
          await out.write(res);
        }, function (d) { progress('Записываю документ', doneBase + d, total); });
        await out.close(); doneBase += e.usize;
      } else if (DOCX_MISC.test(e.name) && e.usize < 50 * 1024 * 1024) {
        var xml = await Zip.entryText(blob, e);
        await w.addText(e.name, maskMiscXml(xml, tool, e.name));
      } else {
        await w.copy(blob, e);
      }
    }
    return { blob: w.finish(mime || 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'), counts: counts };
  }
  // Фигуры и картинки: Word и PowerPoint хранят в имени фигуры и замещающем тексте копию текста
  // («Ответственный Гусейнов Т. И., тел. …») — её не видно на слайде, но она уходит вместе с файлом.
  function maskDrawingAttrs(xml, tool) {
    return xml.replace(/<(?:\w+:)?(?:cNvPr|docPr)\b[^>]*>/g, function (tag) {
      return tag.replace(/(\s(?:name|descr|title)=")([^"]*)(")/g, function (m, a, v, b) {
        var t = unesc(v); if (!t.trim()) return m;
        var fs = tool.detect(t);
        if (!fs.length || tool.analyzeOnly) return m;
        var out = '', pos = 0;
        fs.forEach(function (f) { out += t.slice(pos, f.s) + tool.tokenFor(f); pos = f.e; });
        return a + escAttr(out + t.slice(pos)) + b;
      });
    });
  }

  // В основном тексте Word — только атрибуты авторов, текст уже обработан по абзацам.
  function maskMiscAttrs(xml, tool) {
    xml = maskDrawingAttrs(xml, tool);
    return xml.replace(/(\s(?:w:author)=")([^"]*)(")/g, function (m, a, v, b) {
      var t = unesc(v).trim(); if (!t) return m;
      var fs = tool.detect(t, tool instanceof Restorer ? undefined : 'ФИО');
      if (!fs.length) return m;
      return a + escAttr(tool.tokenFor(fs[0])) + b;
    }).replace(/(\sw:initials=")([^"]*)(")/g, function (m, a, v, b) { return tool instanceof Restorer ? m : a + b; });
  }

  // ───────────────────────── PowerPoint ─────────────────────────

  var PPTX_MAIN = /^ppt\/(?:slides\/slide\d+|notesSlides\/notesSlide\d+|slideLayouts\/slideLayout\d+|slideMasters\/slideMaster\d+|notesMasters\/notesMaster\d+|handoutMasters\/handoutMaster\d+|comments\/modernComment[^/]*)\.xml$/;
  var PPTX_MISC = /^(?:docProps\/(?:core|app|custom)\.xml|ppt\/(?:commentAuthors|authors|comments\/comment\d+|charts\/chart\d+|diagrams\/data\d+|diagrams\/drawing\d+)\.xml|ppt\/(?:slides|notesSlides)\/_rels\/[^/]+\.rels|customXml\/item\d+\.xml)$/;
  function slideNo(name) { var m = /slides\/slide(\d+)\.xml$/.exec(name); return m ? +m[1] : 0; }

  async function pptxAnalyze(blob, name, session, progress) {
    var entries = await Zip.readEntries(blob), report = new Report('pptx', name, blob.size);
    var parts = entries.filter(function (e) { return PPTX_MAIN.test(e.name); })
      .sort(function (a, b) { return (slideNo(a.name) || 1e9) - (slideNo(b.name) || 1e9) || (a.name < b.name ? -1 : 1); });
    var total = parts.reduce(function (a, e) { return a + e.usize; }, 0), doneBase = 0, paragraphs = 0, slides = 0;
    for (var i = 0; i < parts.length; i++) {
      var e = parts[i], isSlide = !!slideNo(e.name), money = new Engine.MoneyContext(), table = new TableState('a');
      if (isSlide) slides++;
      await Zip.eachChunk(blob, e, '</a:p>', function (chunk) {
        docxChunk(chunk, function (nodes, gaps, tableHint) {
          paragraphs++;
          var j = joinNodes(nodes, gaps);
          if (!j.text.trim()) return null;
          session.collect(j.text);
          var hint = tableHint || (money.cell(j.text) ? 'ДЕНЬГИ' : undefined);
          var fs = session.detect(j.text, hint);
          fs.forEach(function (f) { session.notePerson(f); report.add(f, 1, snippetOf(j.text, f)); });
          if (isSlide && report.preview.length < MAX_PREVIEW) {
            report.preview.push({ text: j.text.slice(0, 2000), spans: fs.filter(function (f) { return f.e <= 2000; })
              .map(function (f) { return { s: f.s, e: f.e, type: f.type, key: f.key }; }) });
          }
          return null;
        }, table, DIALECT.a);
      }, function (d) { progress(isSlide ? 'Слайды' : 'Заметки и шаблоны', doneBase + d, total); });
      doneBase += e.usize;
    }
    for (var k = 0; k < entries.length; k++) {
      var me = entries[k];
      if (!/ppt\/(?:commentAuthors|authors|comments\/[^/]+)\.xml$/.test(me.name) || me.usize > 50 * 1024 * 1024) continue;
      var xml = await Zip.entryText(blob, me), m, re = /\s(?:name|author|displayName)="([^"]*)"/g, seen = {};
      while ((m = re.exec(xml))) {
        var a = unesc(m[1]).trim(); if (!a || seen[a]) continue; seen[a] = 1;
        session.detect(a, 'ФИО').forEach(function (f) { session.notePerson(f); report.add(f, 1, 'Автор комментария: ' + a); });
      }
      var tx = /<p:text>([^<]*)<\/p:text>/g;
      while ((m = tx.exec(xml))) {
        var t = unesc(m[1]);
        session.detect(t).forEach(function (f) { session.notePerson(f); report.add(f, 1, snippetOf(t, f)); });
      }
    }
    var core = entries.filter(function (e) { return e.name === 'docProps/core.xml'; })[0];
    if (core) {
      var cx = await Zip.entryText(blob, core), cr = /<dc:creator>([^<]*)<\/dc:creator>|<cp:lastModifiedBy>([^<]*)<\/cp:lastModifiedBy>/g, whos = [], cm;
      while ((cm = cr.exec(cx))) { var who = unesc(cm[1] || cm[2] || ''); if (who && whos.indexOf(who) < 0) whos.push(who); }
      if (whos.length) report.warnings.push('Авторы в свойствах файла будут удалены: ' + whos.join(', ').replace(/\.$/, '') + '.');
    }
    session.linkPeople();
    var img = 0;
    entries.forEach(function (e) {
      if (/^ppt\/media\//.test(e.name)) img++;
      if (/^ppt\/embeddings\//.test(e.name)) report.warnings.push('В презентацию встроены другие файлы (таблицы Excel, документы): их содержимое не проверяется. Лучше удалить их перед отправкой.');
      if (/vbaProject\.bin$/.test(e.name)) report.warnings.push('В файле есть макросы: их код не проверяется.');
    });
    if (img) report.warnings.push('Картинок в презентации: ' + img + '. Их содержимое (скриншоты, фото, подписи) не проверяется.');
    report.warnings = Array.from(new Set(report.warnings));
    report.stats = { slides: slides, paragraphs: paragraphs };
    return { report: report, state: { entries: entries } };
  }

  async function pptxApply(blob, state, tool, progress) {
    var entries = state.entries, w = new Zip.Writer(), counts = {};
    var total = entries.reduce(function (a, e) { return a + (PPTX_MAIN.test(e.name) ? e.usize : 0); }, 0), doneBase = 0;
    for (var i = 0; i < entries.length; i++) {
      var e = entries[i];
      if (PPTX_MAIN.test(e.name)) {
        var out = w.open(e.name), money = new Engine.MoneyContext(), table = new TableState('a');
        await Zip.eachChunk(blob, e, '</a:p>', async function (chunk) {
          var res = docxChunk(chunk, function (nodes, gaps, tableHint) {
            var hint = tool instanceof Restorer ? undefined : tableHint || (money.cell(joinNodes(nodes, gaps).text) ? 'ДЕНЬГИ' : undefined);
            return processNodes(tool, nodes, gaps, hint, function (t, fs) { fs.forEach(function (f) { counts[f.type || 'метки'] = (counts[f.type || 'метки'] || 0) + 1; }); });
          }, table, DIALECT.a);
          await out.write(maskDrawingAttrs(res == null ? chunk : res, tool));
        }, function (d) { progress('Записываю презентацию', doneBase + d, total); });
        await out.close(); doneBase += e.usize;
      } else if (PPTX_MISC.test(e.name) && e.usize < 50 * 1024 * 1024) {
        var xml = await Zip.entryText(blob, e);
        await w.addText(e.name, maskMiscXml(xml, tool, e.name));
      } else {
        await w.copy(blob, e);
      }
    }
    return { blob: w.finish('application/vnd.openxmlformats-officedocument.presentationml.presentation'), counts: counts };
  }

  // ───────────────────────── Текст и CSV ─────────────────────────

  // Таблицы в тексте — столбцы через табуляцию (так их отдаёт PDF и копирование из Excel).
  // Строка заголовка («ФИО», «СНИЛС», «Дата рождения») задаёт тип столбцов для строк ниже,
  // а пара «Дата рождения<Tab>12.03.1985» — тип значения справа, как в анкетах.
  function TabTable() { this.t = null; }
  // Подпись столбца: коротко и без цифр. Кусок фразы с «логин» и «пароль» внутри — не заголовок.
  function isLabel(c) { c = c.trim(); return !c || c === '№' || (c.length <= 40 && !/\d/.test(c) && c.split(/\s+/).length <= 5); }
  TabTable.prototype.cells = function (line) {
    if (!line.replace(/\t/g, '').trim()) return null;                // пустая строка внутри таблицы её не обрывает
    if (line.indexOf('\t') < 0) { this.t = null; return null; }
    var cells = line.split('\t');
    if (this.t && cells.length === this.t.length) return { cells: cells, hints: this.t };
    var types = cells.map(function (c) { return Engine.classifyHeader(c.trim()); });
    var typed = types.filter(Boolean).length;
    if (typed >= 2 && cells.every(isLabel)) { this.t = types; return { cells: cells, hints: [], header: true }; }   // заголовок — названия столбцов
    // «Дата рождения<Tab>12.03.1985»: слева — короткая подпись без цифр, а не кусок фразы («Стоимость работ — 12 450 000 руб., срок»).
    var label = cells[0].trim();
    if (cells.length === 2 && types[0] && !types[1] && label.length <= 40 && !/\d/.test(label) && label.split(/\s+/).length <= 4)
      return { cells: cells, hints: [null, types[0]] };
    return null;
  };
  function detectLine(tool, line, hint, tt) {
    var r = tt && tt.cells(line);
    if (!r) return tool.detect(line, hint);
    if (r.header) return [];
    var out = [], off = 0;
    r.cells.forEach(function (c, i) {
      if (c.trim()) tool.detect(c, r.hints[i] || hint).forEach(function (f) { f.s += off; f.e += off; out.push(f); });
      off += c.length + 1;
    });
    return out;
  }

  async function detectEncoding(blob) {
    var head = new Uint8Array(await blob.slice(0, 256 * 1024).arrayBuffer());
    if (head[0] === 0xEF && head[1] === 0xBB && head[2] === 0xBF) return 'utf-8';
    if (head[0] === 0xFF && head[1] === 0xFE) return 'utf-16le';
    if (head[0] === 0xFE && head[1] === 0xFF) return 'utf-16be';
    try { new TextDecoder('utf-8', { fatal: true }).decode(head.length === 256 * 1024 ? head.subarray(0, head.length - 4) : head); return 'utf-8'; }
    catch (e) { return 'windows-1251'; }
  }

  async function eachLineChunk(blob, encoding, onChunk, onProgress) {
    var reader = blob.stream().getReader(), dec = new TextDecoder(encoding), buf = '', done = 0, first = true;
    for (;;) {
      var r = await reader.read();
      if (r.done) break;
      done += r.value.length;
      buf += dec.decode(r.value, { stream: true });
      if (first) { buf = buf.replace(/^\uFEFF/, ''); first = false; }
      if (buf.length > 2 * 1024 * 1024) {
        var cut = buf.lastIndexOf('\n');
        if (cut >= 0) { await onChunk(buf.slice(0, cut + 1)); buf = buf.slice(cut + 1); }
        if (onProgress) onProgress(done, blob.size);
      }
    }
    buf += dec.decode();
    if (buf) await onChunk(buf);
    if (onProgress) onProgress(blob.size, blob.size);
  }

  function csvSplit(line, delim) {
    var cells = [], cur = '', q = false;
    for (var i = 0; i < line.length; i++) {
      var ch = line[i];
      if (q) { if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch; }
      else if (ch === '"') q = true;
      else if (ch === delim) { cells.push(cur); cur = ''; }
      else cur += ch;
    }
    cells.push(cur);
    return cells;
  }
  function csvJoin(cells, delim) {
    return cells.map(function (c) {
      return /["\n\r]/.test(c) || c.indexOf(delim) >= 0 ? '"' + c.replace(/"/g, '""') + '"' : c;
    }).join(delim);
  }
  function quotesOpen(s) { return (s.split('"').length - 1) % 2 === 1; }

  // Перебор логических строк CSV (с учётом переносов внутри кавычек).
  function csvRecords(chunk, carry, onRec) {
    var lines = (carry + chunk).split('\n'), acc = null;
    var tail = lines.pop();
    for (var i = 0; i < lines.length; i++) {
      var l = lines[i];
      acc = acc == null ? l : acc + '\n' + l;
      if (!quotesOpen(acc)) { onRec(acc.replace(/\r$/, ''), /\r$/.test(acc)); acc = null; }
    }
    return (acc != null ? acc + '\n' : '') + tail;
  }

  async function textAnalyze(blob, name, kind, session, progress) {
    var enc = await detectEncoding(blob), report = new Report(kind, name, blob.size);
    var meta = { encoding: enc, delim: null, columns: {}, header: null };
    if (enc === 'windows-1251') report.warnings.push('Файл в кодировке Windows-1251. Результат будет в UTF-8 — Excel и другие программы откроют его без проблем.');
    var lines = 0;
    if (kind === 'csv') {
      var carry = '', buffer = [], decided = false;
      var decide = function () {
        var first = buffer.shift() || '';
        var counts = [';', ',', '\t', '|'].map(function (d) { return [d, csvSplit(first, d).length]; }).sort(function (a, b) { return b[1] - a[1]; });
        meta.delim = counts[0][0];
        meta.header = csvSplit(first, meta.delim);
        meta.header.forEach(function (h, i) { meta.columns[i] = { header: h.trim(), byHeader: Engine.classifyHeader(h), samples: [], nonEmpty: 0 }; });
        buffer.forEach(function (rec) { csvSplit(rec, meta.delim).forEach(function (c, i) { var col = meta.columns[i]; if (col && c.trim() && col.samples.length < SAMPLE_ROWS) col.samples.push(c); }); });
        Object.keys(meta.columns).forEach(function (k) { var c = meta.columns[k]; c.suggested = c.byHeader || session.classifyValues(c.samples); });
        decided = true;
        buffer.forEach(dataRec); buffer = [];
      };
      var dataRec = function (rec) {
        lines++;
        if (!report.table || report.table.rows.length < TABLE_ROWS) {
          var hdr = Object.keys(meta.columns).map(function (k) { return { col: +k, letter: colName(+k), header: meta.columns[k].header }; });
          tableAdd(report, 0, '', hdr, csvSplit(rec, meta.delim).map(function (c, i) {
            return { col: i, text: c, typed: !!(meta.columns[i] && meta.columns[i].suggested) };
          }), session);
        }
        csvSplit(rec, meta.delim).forEach(function (c, i) {
          var col = meta.columns[i] || (meta.columns[i] = { header: '', samples: [], nonEmpty: 0, suggested: null });
          if (!c.trim()) return;
          col.nonEmpty++;
          if (col.suggested) {
            report.byType[col.suggested] = (report.byType[col.suggested] || 0) + 1;
            if (col.suggested === 'ФИО') session.detect(c, 'ФИО').forEach(function (f) { session.notePerson(f); });
            if (col.suggested === 'ID') session.reserveId(c);
            return;
          }
          session.collect(c);
          session.detect(c).forEach(function (f) { session.notePerson(f); report.add(f, 1, (col.header ? col.header + ': ' : '') + snippetOf(c, f)); });
        });
      };
      await eachLineChunk(blob, enc, function (chunk) {
        carry = csvRecords(chunk, carry, function (rec) {
          if (!decided) { buffer.push(rec); if (buffer.length > SAMPLE_ROWS) decide(); } else dataRec(rec);
        });
      }, function (d, t) { progress('Читаю таблицу', d, t); });
      if (carry) { if (!decided) buffer.push(carry); else dataRec(carry); }
      if (!decided) decide();
      Object.keys(meta.columns).forEach(function (k) {
        var c = meta.columns[k];
        if (!c.nonEmpty && !c.header) return;
        report.columns.push({ sheet: 0, sheetName: '', col: Number(k), letter: colName(Number(k)), header: c.header,
          suggested: c.suggested || '', samples: c.samples.slice(0, 4), nonEmpty: c.nonEmpty });
      });
    } else {
      var money = new Engine.MoneyContext(), tt = new TabTable();
      await eachLineChunk(blob, enc, function (chunk) {
        chunk.split('\n').forEach(function (line) {
          lines++;
          session.collect(line);
          var fs = detectLine(session, line, money.cell(line) ? 'ДЕНЬГИ' : undefined, tt);
          fs.forEach(function (f) { session.notePerson(f); report.add(f, 1, snippetOf(line, f)); });
          if (report.preview.length < MAX_PREVIEW && line.trim())
            report.preview.push({ text: line.slice(0, 2000), spans: fs.filter(function (f) { return f.e <= 2000; }).map(function (f) { return { s: f.s, e: f.e, type: f.type, key: f.key }; }) });
        });
      }, function (d, t) { progress('Читаю текст', d, t); });
    }
    session.linkPeople();
    report.stats = { lines: lines, encoding: enc };
    return { report: report, state: { meta: meta } };
  }

  async function textApply(blob, state, tool, decisions, kind, progress) {
    var meta = state.meta, parts = [], counts = {}, pending = [], pendingLen = 0, all = [], allLen = 0;
    var enc = new TextEncoder();
    // Небольшой результат отдаём ещё и строкой: в Safari страница, открытая из файла, не может прочитать Blob из воркера.
    function emit(s) {
      Zip.inspect('text', s);
      if (all && (allLen += s.length) < 5 * 1024 * 1024) all.push(s); else all = null;
      pending.push(s); pendingLen += s.length;
      if (pendingLen > 8 * 1024 * 1024) { parts.push(new Blob([enc.encode(pending.join(''))])); pending = []; pendingLen = 0; }
    }
    function maskLine(text, type, tt) {
      var fs = detectLine(tool, text, type, tt), out = '', pos = 0;
      fs.forEach(function (f) { out += text.slice(pos, f.s) + tool.tokenFor(f); pos = f.e; counts[f.type || 'метки'] = (counts[f.type || 'метки'] || 0) + 1; });
      return out + text.slice(pos);
    }
    if (kind === 'csv' && meta.delim) {
      var colType = {};
      Object.keys(meta.columns).forEach(function (k) {
        var key = '0:' + k, d = decisions && decisions.columns && key in decisions.columns ? decisions.columns[key] : meta.columns[k].suggested;
        if (d && tool.types && tool.types[d]) colType[k] = d;
      });
      var carry = '', first = true;
      await eachLineChunk(blob, meta.encoding, function (chunk) {
        carry = csvRecords(chunk, carry, function (rec, cr) {
          var nl = cr ? '\r\n' : '\n';
          if (first) { first = false; emit(rec + nl); return; }
          var cells = csvSplit(rec, meta.delim).map(function (c, i) { return c.trim() ? maskLine(c, colType[i]) : c; });
          emit(csvJoin(cells, meta.delim) + nl);
        });
      }, function (d, t) { progress('Записываю', d, t); });
      if (carry) emit(first ? carry : csvJoin(csvSplit(carry, meta.delim).map(function (c, i) { return c.trim() ? maskLine(c, colType[i]) : c; }), meta.delim));
    } else {
      var money = new Engine.MoneyContext(), restoring = tool instanceof Restorer, tt = restoring ? null : new TabTable();
      await eachLineChunk(blob, meta.encoding, function (chunk) {
        emit(chunk.split('\n').map(function (line) {
          return maskLine(line, !restoring && money.cell(line) ? 'ДЕНЬГИ' : undefined, tt);
        }).join('\n'));
      }, function (d, t) { progress('Записываю', d, t); });
    }
    if (pending.length) parts.push(new Blob([enc.encode(pending.join(''))]));
    var bom = kind === 'csv' ? [new Uint8Array([0xEF, 0xBB, 0xBF])] : [];
    return { blob: new Blob(bom.concat(parts), { type: kind === 'csv' ? 'text/csv' : 'text/plain' }), text: all ? all.join('') : null, counts: counts };
  }

  // ───────────────────────── Возврат данных в файл ─────────────────────────

  async function restoreFile(blob, name, key, progress) {
    var kind = await sniff(blob, name), tool = new Restorer(key), result;
    if (kind === 'docx') {
      result = await docxApply(blob, { entries: await Zip.readEntries(blob) }, tool, progress);
    } else if (kind === 'pptx') {
      result = await pptxApply(blob, { entries: await Zip.readEntries(blob) }, tool, progress);
    } else if (kind === 'xlsx') {
      var entries = await Zip.readEntries(blob), w = new Zip.Writer();
      var textNode = function (m, lead, s) { return lead + esc(tool.text(unesc(s))); };
      for (var i = 0; i < entries.length; i++) {
        var e = entries[i];
        if (!/\.(xml|rels)$/.test(e.name)) { await w.copy(blob, e); continue; }
        var isSheet = /^xl\/worksheets\/[^/]+\.xml$/.test(e.name), out = w.open(e.name);
        await Zip.eachChunk(blob, e, isSheet ? '</row>' : '>', async function (chunk) {
          var res;
          if (isSheet) {
            // В ячейках со ссылкой на общую строку число — это номер строки, его не трогаем.
            res = chunk.replace(CELL_RE, function (cell, a, body) {
              if (!body || (attr(a, 't') || 'n') === 's') return cell;
              // Ячейка — ровно одна метка, а была числом или датой: возвращаем число с прежним форматом.
              if (attr(a, 't') === 'inlineStr') {
                var only = tTexts((/<is>([\s\S]*?)<\/is>/.exec(body) || [, ''])[1]).trim(), tk = key.tokens && key.tokens[only];
                if (tk && tk.num != null) { tool.count++; return '<c' + a.replace(/\s+t="[^"]*"/, '') + '><v>' + esc(String(tk.num)) + '</v></c>'; }
              }
              return cell.replace(/(<v>|<t(?:\s[^>]*)?>)([^<]+)/g, function (m, open, s) { return open + esc(tool.text(unesc(s))); });
            });
          } else {
            res = chunk.replace(/(^|>)([^<]+)(?=<|$)/g, textNode)
              .replace(/="([^"]*)"/g, function (m, s) { return /\[[А-ЯЁA-Z_]+-\d+\]/.test(s) ? '="' + escAttr(tool.text(unesc(s))) + '"' : m; });
          }
          await out.write(res);
        }, function (d) { progress('Возвращаю данные', d, e.usize); });
        await out.close();
      }
      result = { blob: w.finish('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet') };
    } else {
      var enc = await detectEncoding(blob);
      result = await textApply(blob, { meta: { encoding: enc } }, tool, null, 'text', progress);
    }
    return { blob: result.blob, count: tool.count, missing: tool.missing, kind: kind };
  }

  return {
    sniff: sniff, xlsxAnalyze: xlsxAnalyze, xlsxApply: xlsxApply, docxAnalyze: docxAnalyze, docxApply: docxApply,
    pptxAnalyze: pptxAnalyze, pptxApply: pptxApply,
    textAnalyze: textAnalyze, textApply: textApply, restoreFile: restoreFile, Restorer: Restorer,
    _test: { splitBack: splitBack, joinNodes: joinNodes, docxChunk: docxChunk, csvSplit: csvSplit, unesc: unesc }
  };
})();
