// Полнота поиска на размеченном корпусе: osascript -l JavaScript tests/run_corpus.js <папка проекта> [подробно] [файл корпуса, по умолчанию tests/corpus.txt]
// Проходит как настоящий файл: сначала все строки (запоминаем людей и найденное), потом маскирует.
ObjC.import('Foundation');
function read(p) { return $.NSString.stringWithContentsOfFileEncodingError(p, $.NSUTF8StringEncoding, null).js; }
function run(argv) {
  var root = argv[0], verbose = argv.indexOf('подробно') >= 0;
  var file = argv.filter(function (a, i) { return i > 0 && a !== 'подробно'; })[0] || root + '/tests/corpus.txt';
  eval(read(root + '/src/lexicon.js')); eval(read(root + '/src/engine.js'));
  var raw = read(file).split('\n').filter(function (l) { return l[0] !== '#'; }).join('\n');
  var blocks = raw.split(/^=== /m).filter(function (b) { return b.trim(); });
  var KEEP = ['INFO', 'WARN', 'ERROR', 'GET', 'HTTP/1.1', '9092', 'НДС 20%', '7Б', '25 из 25', '120 мс', '12.03.2026',
    'Министерство просвещения', 'СМЭВ 4', 'GradeService.java:142', 'оценка «5»', 'Испытания проводит комиссия'];
  var total = 0, hit = 0, byType = {}, missed = [], keptBad = [], out = [];
  blocks.forEach(function (b) {
    var name = b.split('\n')[0].trim(), body = b.slice(b.indexOf('\n') + 1);
    var expected = [], text = body.replace(/\{\{([A-ZА-ЯЁ_]+):([\s\S]*?)\}\}/g, function (m, t, v) { expected.push({ type: t, value: v }); return v; });
    var s = new Engine.Session({ idMode: 'token' });
    var lines = text.split('\n');
    lines.forEach(function (l) { s.detect(l).forEach(function (f) { s.notePerson(f); }); });
    s.linkPeople();
    var masked = lines.map(function (l) { return s.maskText(l); }).join('\n');
    expected.forEach(function (e) {
      total++; byType[e.type] = byType[e.type] || [0, 0]; byType[e.type][1]++;
      var core = e.value.replace(/^[\s:\/]+|[\s:\/]+$/g, '');
      if (masked.indexOf(core) < 0) { hit++; byType[e.type][0]++; } else missed.push(name + ' · ' + e.type + ': ' + core);
    });
    KEEP.forEach(function (k) { if (text.indexOf(k) >= 0 && masked.indexOf(k) < 0) keptBad.push(name + ': «' + k + '»'); });
    if (verbose) out.push('--- ' + name + '\n' + masked);
  });
  out.push('Найдено ' + hit + ' из ' + total + ' (' + Math.round(100 * hit / total) + '%)');
  out.push(Object.keys(byType).sort().map(function (t) { return t + ' ' + byType[t][0] + '/' + byType[t][1]; }).join(' · '));
  if (missed.length) out.push('Пропущено:\n  ' + missed.join('\n  '));
  if (keptBad.length) out.push('Лишнее скрыто:\n  ' + keptBad.join('\n  '));
  return out.join('\n');
}
