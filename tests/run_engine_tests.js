// Запуск: osascript -l JavaScript tests/run_engine_tests.js <папка проекта>
ObjC.import('Foundation');
function read(p) { return $.NSString.stringWithContentsOfFileEncodingError(p, $.NSUTF8StringEncoding, null).js; }
function run(argv) {
  var root = argv[0];
  eval(read(root + '/src/lexicon.js')); eval(read(root + '/src/engine.js'));
  var cases = JSON.parse(read(root + '/tests/engine_cases.json'));
  var fails = [], out = [];
  cases.forEach(function (c, n) {
    // Метками, а не новыми ID: случайный новый ID может содержать цифры старого и сбить проверку подстрок.
    var s = new Engine.Session({ idMode: 'token' });
    var masked = s.maskText(c.text, c.hint);
    var bad = [];
    (c.hide || []).forEach(function (h) { if (masked.indexOf(h) >= 0) bad.push('не скрыто: ' + h); });
    (c.keep || []).forEach(function (h) { if (masked.indexOf(h) < 0) bad.push('скрыто лишнее: ' + h); });
    out.push((bad.length ? '✗ ' : '✓ ') + masked + (bad.length ? '   ← ' + bad.join('; ') : ''));
    if (bad.length) fails.push(n);
  });
  // Склейка людей: «Анна» после «Анна Сергеевна Петрова» → та же метка.
  var s2 = new Engine.Session();
  var texts = ['Анна Сергеевна Петрова пришла.', 'Анна ушла раньше.', 'Потом Петрова вернулась.', 'Сидоров И. И. и Иван Иванович Сидоров', 'Сидоров сказал, что согласен.'];
  texts.forEach(function (t) { s2.detect(t).forEach(function (f) { s2.notePerson(f); }); });
  s2.linkPeople();
  var linked = texts.map(function (t) { return s2.maskText(t); });
  out.push('Склейка: ' + linked.join(' | '));
  var ok = linked[0].indexOf('[ФИО-1]') >= 0 && linked[1].indexOf('[ФИО-1]') >= 0 && linked[2].indexOf('[ФИО-1]') >= 0 && /\[ФИО-2\] и \[ФИО-2\]/.test(linked[3]) && linked[4].indexOf('[ФИО-2]') === 0;
  if (!ok) fails.push('link');
  var key = s2.exportKey();
  var back = Engine.unmaskText('Итог: [ФИО-1] и [ФИО-2].', key);
  out.push('Возврат: ' + back.text);
  // ID: одинаковый ID → одинаковый новый, разные → разные, вид сохраняется, данные возвращаются.
  var s3 = new Engine.Session();
  var ids = ['1', '2', '1', '1000023336124', '3F2504E0-4F89-41D3-9A0C-0305E82C3301', 'AB-1234', '000123'];
  var ps = ids.map(function (v) { return s3.maskText(v, 'ID'); });
  var uniq = {}; ps.forEach(function (p, i) { uniq[ids[i]] = uniq[ids[i]] || {}; uniq[ids[i]][p] = 1; });
  var consistent = Object.keys(uniq).every(function (k) { return Object.keys(uniq[k]).length === 1; });
  var distinct = new Set(ps).size === new Set(ids).size;
  var shape = /^\d{6}$/.test(ps[0]) && /^\d{13}$/.test(ps[3]) && /^[0-9A-F]{8}-[0-9A-F]{4}-4/.test(ps[4]) && /^[A-Z]{2}-\d{4}$/.test(ps[5]) && /^0\d{5}$/.test(ps[6]);
  var back = Engine.unmaskText('Ученик ' + ps[0] + ' и ' + ps[3] + ', орг ' + ps[5] + '.', s3.exportKey());
  var restoredOk = back.text === 'Ученик 1 и 1000023336124, орг AB-1234.';
  out.push('ID: ' + ids.map(function (v, i) { return v + '→' + ps[i]; }).join(', '));
  out.push('Возврат ID: ' + back.text);
  if (!(consistent && distinct && shape && restoredOk)) { fails.push('id'); out.push('✗ ID: одинаковость ' + consistent + ', уникальность ' + distinct + ', вид ' + shape + ', возврат ' + restoredOk); }
  // 10 000 разных ID — ни одного совпадения.
  var s4 = new Engine.Session(), seen = {}, dup = 0;
  for (var q = 1; q <= 10000; q++) { s4.reserveId(String(q)); }
  for (q = 1; q <= 10000; q++) { var p = s4.maskText(String(q), 'ID'); if (seen[p]) dup++; seen[p] = 1; if (+p >= 1 && +p <= 10000) dup++; }
  out.push('10 000 ID: совпадений ' + dup);
  if (dup) fails.push('id-unique');
  // Денежная таблица: подпись «тыс. руб.» — числа в ячейках деньги, ставки и номера периодов — нет.
  var mc = new Engine.MoneyContext();
  var cells = ['Таблица 2 - Показатели, тыс. руб.', 'Доход', '21 400,0', '−15 050,0', '428,0', 'Ставка', '0,12', '1,1200', '3',
               'Учитывая рассчитанный поток и ставку дисконтирования, можно рассчитать дисконтированный поток для каждого периода работы платформы, после чего сравнить итоговые значения и сделать вывод об эффективности проекта в целом и о сроке окупаемости. Дальше идёт таблица без единиц измерения, где числа — это не деньги, а количество учеников и классов в школах региона за последние годы.', '12 500'];
  var money = cells.filter(function (c) { return mc.cell(c); });
  out.push('Денежная таблица: ' + money.join(' · '));
  if (money.join('|') !== '21 400,0|−15 050,0|428,0') fails.push('money-table');
  out.push(fails.length ? 'ПРОВАЛЕНО: ' + fails.length + ' из ' + (cases.length + 4) : 'ВСЕ ' + (cases.length + 4) + ' ПРОШЛИ');
  return out.join('\n');
}
