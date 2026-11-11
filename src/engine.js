/* Обезличиватель — ядро: поиск персональных данных в тексте и выдача меток.
 *
 * Не зависит от браузера: работает в веб-воркере страницы и в JavaScriptCore
 * (тесты через `osascript -l JavaScript`). Никаких сетевых вызовов.
 *
 * Главный объект — Session: держит ключ (метка ↔ исходное значение),
 * решения пользователя (что не скрывать, что скрыть дополнительно) и
 * выдаёт одинаковую метку одному и тому же человеку во всём файле.
 */
var Engine = (function () {
  'use strict';

  // ───────────────────────── Типы ─────────────────────────

  var TYPES = {
    'ФИО':            { title: 'ФИО и имена',           on: true },
    'ТЕЛЕФОН':        { title: 'Телефоны',              on: true },
    'ПОЧТА':          { title: 'Электронная почта',     on: true },
    'СНИЛС':          { title: 'СНИЛС',                 on: true },
    'ИНН':            { title: 'ИНН физлица',           on: true },
    'ПАСПОРТ':        { title: 'Паспорт',               on: true },
    'ПОЛИС':          { title: 'Полис ОМС',             on: true },
    'КАРТА':          { title: 'Банковские карты',      on: true },
    'СЧЁТ':           { title: 'Банковские счета',      on: true },
    'ДАТА_РОЖДЕНИЯ':  { title: 'Даты рождения',         on: true },
    'АДРЕС':          { title: 'Адреса',                on: true },
    'ШКОЛА':          { title: 'Школы и организации',   on: true },
    'ГОСНОМЕР':       { title: 'Госномера авто',        on: true },
    'НИК':            { title: 'Ники и логины',         on: true },
    'IP':             { title: 'IP-адреса',             on: true },
    'ID':             { title: 'ID и идентификаторы',   on: true },
    'ТОКЕН':          { title: 'Пароли, токены, ключи', on: true },
    'ДЕНЬГИ':         { title: 'Деньги и суммы',        on: true },
    'РЕКВИЗИТЫ':      { title: 'Реквизиты организаций', on: true },
    'ДОГОВОР':        { title: 'Номера договоров',      on: true },
    'ОРГАНИЗАЦИЯ':    { title: 'Организации',           on: true },
    'ХОСТ':           { title: 'Серверы, домены, URL',  on: true },
    'МЕТОД':          { title: 'Методы API и классы',   on: true },
    'СВОЁ':           { title: 'Свои правила',          on: true }
  };

  // ───────────────────────── Словари имён ─────────────────────────

  var MALE = ('Александр Алексей Анатолий Андрей Антон Аркадий Арсений Артём Артем Артемий Артур Богдан Борис ' +
    'Вадим Валентин Валерий Василий Вениамин Виктор Виталий Владимир Владислав Владлен Всеволод Вячеслав ' +
    'Гавриил Геннадий Георгий Герман Глеб Григорий Давид Даниил Данила Даниэль Демид Денис Дмитрий Добрыня ' +
    'Евгений Егор Елисей Емельян Ефим Захар Иван Игнат Игорь Илья Иннокентий Иосиф Кирилл Климент Константин ' +
    'Кузьма Лаврентий Леонид Леонтий Лука Макар Максим Марк Матвей Мирон Мирослав Михаил Назар Нестор Никита ' +
    'Никифор Николай Олег Остап Павел Платон Прохор Пётр Петр Родион Роман Ростислав Руслан Савелий Святослав ' +
    'Семён Семен Серафим Сергей Станислав Степан Тарас Тимофей Тимур Тихон Трофим Фёдор Федор Феликс Филипп Фома ' +
    'Эдуард Эрик Эдгар Эмиль Юлиан Юрий Яков Ярослав Адам Альберт Анзор Ахмед Ахмад Азат Айдар Алан Али Алим ' +
    'Амир Арсен Аслан Байрам Булат Вагиз Гусейн Дамир Джамал Ильдар Ильнур Ильдус Ильяс Ислам Ибрагим Камиль ' +
    'Карим Мансур Марат Магомед Мухаммад Мурат Нурлан Олжас Рамиль Рамазан Ренат Ринат Ришат Рустам Рафаэль ' +
    'Рашид Салават Тагир Талгат Фарид Хасан Шамиль Эльдар Эльмир Юсуф Гордей Ратмир Лев Ян Самуил Генрих ' +
    'Аристарх Евдоким Харитон Велимир Мстислав Изяслав Арнольд Валентин Бронислав Казимир Филимон Афанасий Аким ' +
    'Мартин Давыд Даниэль Тимур Эмир Захарий').split(' ');

  var FEMALE = ('Александра Алёна Алена Алина Алиса Алла Анастасия Ангелина Анжела Анна Антонина Арина Валентина ' +
    'Валерия Варвара Василиса Вера Вероника Виктория Виолетта Галина Дарина Дарья Диана Ева Евгения Екатерина ' +
    'Елена Елизавета Жанна Зинаида Зоя Злата Инга Инна Ирина Камилла Карина Кира Клавдия Кристина Ксения Лада ' +
    'Лариса Леся Лидия Лилия Любовь Людмила Майя Маргарита Марианна Марина Мария Марьяна Милана Мирослава ' +
    'Надежда Наталья Наталия Нелли Ника Нина Нонна Оксана Олеся Ольга Полина Раиса Регина Римма Роза Сабина ' +
    'Светлана Серафима Снежана Софья София Стефания Таисия Тамара Татьяна Ульяна Устинья Эвелина Элина Эльвира ' +
    'Эмилия Юлия Яна Ярослава Айгуль Алсу Альбина Амина Асель Гульнара Гульшат Динара Дина Залина Зарина Зульфия ' +
    'Ильмира Лейла Ляйсан Мадина Малика Наиля Розалия Рената Резеда Фатима Эльмира Аида Аделина Агата Ариадна ' +
    'Василина Владислава Виталина Есения Мелания Милена Олимпиада Пелагея Прасковья Эльза Ирма Изабелла Луиза ' +
    'Эльвина Юлиана Ассоль Василиса Дария').split(' ');

  // Уменьшительные: как в разговоре и в расшифровках встреч.
  var SHORT = ('Саша Сашенька Шура Алёша Алеша Лёша Леша Толя Андрюша Тоша Тёма Тема Боря Вадик Валя Вася Витя ' +
    'Володя Вова Гена Гоша Гриша Дима Димон Женя Жора Ваня Ванечка Игорёк Илюша Костя Лёва Лева Лёня Леня Миша ' +
    'Коля Олежка Паша Петя Рома Серёжа Сережа Стас Стёпа Степа Тима Федя Юра Ярик Даня Кирюша Эдик Аркаша Сёма ' +
    'Сема Филя Яша Славик Аня Анечка Настя Аля Варя Вика Галя Даша Катя Лена Леночка Лиза Люба Люда Маша ' +
    'Машенька Надя Наташа Оля Света Соня Таня Уля Юля Ксюша Лера Ира Рая Тоня Лида Зина Ната Нюша Поля Алёнка ' +
    'Маруся Сонечка Танюша').split(' ');

  // Имена, которые совпадают с обычными словами: скрываем, только если рядом
  // отчество, фамилия или инициалы.
  var AMBIGUOUS = ('Вера Надежда Любовь Роза Лилия Слава Лев Майя Ника Лада Злата Макс Мила Аля Тома Рая Ян ' +
    'Марк Ева Дина Яна Алла Инна Нина Роман Гена Поля Тема Лена').split(' ');

  // Слова с «фамильными» окончаниями, которые фамилиями не являются.
  var NOT_SURNAMES = ('Ростов Саратов Тамбов Псков Азов Киров Королёв Королев Чехов Пушкин Калинин Губкин Ковров ' +
    'Балашов Ржев Берлин Пекин Минфин Кремлин Харьков Киев Львов Кишинёв Кишинев Гатчина Иваново Обнинск Ульяновск ' +
    'Дубна Электросталь Подольск Мытищи Химки Люберцы Абакан Ачинск Канск Кемерово Тутаев Касимов Великий Новгород ' +
    'Петербург Петроград Ленинград Сталинград Царицын Мичуринск Лермонтов Пугачёв Пугачев Галич Ростова Саратова ' +
    'Тамбова Пскова Азова Кирова Королёва Королева Чехова Пушкина Калинина Ржева Харькова Киева Львова ' +
    'Ростове Саратове Тамбове Пскове Азове Кирове Королёве Чехове Пушкине Калинине Ржеве Харькове Киеве Львове ' +
    'Ростову Саратову Тамбову Пскову Кирову Чехову Пушкину Ржеву Киеву Львову ' +
    'Минпросвещения Минобрнауки Минцифры Минтруд Минюст Минздрав Росстат Роскомнадзор Рособрнадзор ' +
    'Сбербанк Тинькофф Газпром Ростелеком Аэрофлот Яндекс Госуслуги Мосгорсуд Мосгордума Ленин Сталин').split(' ');

  // Слова, которые никогда не скрываем, даже если они похожи на ФИО.
  var DEFAULT_ALLOW = ('Госуслуги Госуслуг Госуслугах Госуслугами Госуслугам Москва Москвы Москве Москву ' +
    'Россия России Российской Российская Федерации Федерация Минпросвещения Министерство Министерства ' +
    'Моя Школа ТОР ЕЖД ЦОК ЦПУ ЕСИА Claude Яндекс Telegram Макс МАКС Сферум').split(' ');

  // Слова-подсказки: после них идут ФИО даже без словаря имён.
  var PERSON_CUES = /(?:^|[^А-Яа-яЁё])(учитель|учительница|учителя|учителю|учителем|ученик|ученица|ученика|ученицы|ученику|ученице|родитель|родителя|родителю|мама|мамы|маме|папа|папы|папе|мать|отец|сын|сына|дочь|дочери|заявитель|заявителя|заявительница|гражданин|гражданка|гражданина|гражданки|директор|директора|завуч|завуча|педагог|педагога|классный руководитель|классного руководителя|руководитель|руководителя|ребёнок|ребенок|ребёнка|ребенка|сотрудник|сотрудника|специалист|специалиста|оператор|абонент|пользователь|пользователя|фио|ф\.\s?и\.\s?о\.|исполнитель|ответственный|ответственная|автор|коллега|коллеги)\s*[:—–-]?\s*$/i;

  var CUE_WORDS = Object.create(null);
  ('учитель учительница учителя ученик ученица ученика ученицы родитель родителя мама папа мать отец сын дочь заявитель ' +
   'гражданин гражданка директор завуч педагог руководитель ребёнок ребенок сотрудник специалист оператор абонент ' +
   'пользователь исполнитель ответственный ответственная автор коллега коллеги фио').split(' ').forEach(function (w) { CUE_WORDS[w] = true; });

  // ───────────────────────── Склонение имён ─────────────────────────

  var NAME_FORMS = Object.create(null);   // форма в нижнем регистре → именительный падеж

  function addForms(base, isFemaleLike) {
    var b = base.toLowerCase(), forms = [b], stem;
    var last = b.slice(-1), last2 = b.slice(-2);
    if (last2 === 'ия') {
      stem = b.slice(0, -1); forms.push(stem + 'и', stem + 'ю', stem + 'ей', stem + 'ею');
    } else if (last === 'а') {
      stem = b.slice(0, -1); forms.push(stem + 'ы', stem + 'и', stem + 'е', stem + 'у', stem + 'ой', stem + 'ою');
      if (/[жшчщц]$/.test(stem)) forms.push(stem + 'ей', stem + 'ею');
    } else if (last === 'я') {
      stem = b.slice(0, -1); forms.push(stem + 'и', stem + 'е', stem + 'ю', stem + 'ей', stem + 'ею');
    } else if (last2 === 'ий') {
      stem = b.slice(0, -1); forms.push(stem + 'я', stem + 'ю', stem + 'ем', stem + 'и');
    } else if (last === 'й') {
      stem = b.slice(0, -1); forms.push(stem + 'я', stem + 'ю', stem + 'ем', stem + 'е');
    } else if (last === 'ь') {
      stem = b.slice(0, -1); forms.push(stem + 'я', stem + 'ю', stem + 'ем', stem + 'е');
    } else if (!isFemaleLike) {
      stem = b;
      if (b === 'павел') stem = 'павл';
      if (b === 'лев') stem = 'льв';
      if (b === 'пётр') stem = 'петр';
      var o = /[жшчщц]$/.test(stem) ? 'ем' : 'ом';
      forms.push(stem + 'а', stem + 'у', stem + o, stem + 'е');
    }
    forms.forEach(function (f) { if (!NAME_FORMS[f]) NAME_FORMS[f] = b; });
  }
  MALE.forEach(function (n) { addForms(n, false); });
  FEMALE.forEach(function (n) { addForms(n, true); });
  SHORT.forEach(function (n) { addForms(n, true); });

  var AMBIG = Object.create(null);
  AMBIGUOUS.forEach(function (n) { addFormsTo(AMBIG, n); });
  function addFormsTo(target, n) {
    var saved = Object.keys(NAME_FORMS).length;
    var tmp = Object.create(null);
    var keep = NAME_FORMS; NAME_FORMS = tmp; addForms(n, /[ая]$/.test(n.toLowerCase())); NAME_FORMS = keep;
    Object.keys(tmp).forEach(function (k) { target[k] = true; });
    return saved;
  }

  function setOf(list) { var s = Object.create(null); list.forEach(function (w) { s[w.toLowerCase()] = true; }); return s; }
  var NOT_SURNAME = setOf(NOT_SURNAMES);

  // ───────────────────────── Распознавание слов ─────────────────────────

  var RE_PATR = /^[А-ЯЁ][а-яё]+(?:(?:ов|ев|ёв)ич(?:а|у|ем|е)?|(?:ов|ев)н(?:а|ы|е|у|ой|ою)|ичн(?:а|ы|е|у|ой|ою)|иничн(?:а|ы|е|у|ой))$/;
  var PATR_SPECIAL = setOf(['Ильич', 'Ильича', 'Ильичу', 'Ильичом', 'Кузьмич', 'Кузьмича', 'Лукич', 'Лукича',
    'Фомич', 'Фомича', 'Никитич', 'Никитича', 'Саввич', 'Саввича']);
  // Фамилии, которые узнаём сами по себе.
  var RE_SURN_STRONG = /^[А-ЯЁ][а-яё]{2,}(?:(?:ов|ев|ёв|ин|ын)(?:а|у|ым|ом|е|ой|ою|ых|ыми|ы)?|енко|(?:чук|щук|ук|юк)(?:а|у|ом|е)?|швили|дзе|(?:ян|янц)(?:а|у|ом|е)?)$/;
  // Фамилии, которые узнаём только рядом с именем или инициалами.
  var RE_SURN_WEAK = /^[А-ЯЁ][а-яё]{2,}(?:(?:ск|цк)(?:ий|ая|ого|ому|им|ом|ой|ую|ая)|(?:ых|их)|ко|ич|ец)$/;
  // Женские фамилии, которые можно узнать даже в начале предложения.
  var RE_SURN_FEM = /^[А-ЯЁ][а-яё]{2,}(?:ова|ева|ёва|ина|ына)$|^[А-ЯЁ][а-яё]{2,}(?:енко|швили|дзе|чук|щук|юк)$/;
  var COMMON_NOUNS = setOf(('Машина Картина Причина Половина Глубина Вершина Мужчина Женщина Пружина Малина Витрина Рутина ' +
    'Дисциплина Медицина Доктрина Вакцина Долина Равнина Середина Тишина Ширина Длина Величина Скотина Резина Калина ' +
    'Основа Корова Слова Голова Подкова Обнова Королева Дева Сова Готова Здорова Сурова Новинка Ветчина Вина Тина ' +
    'Пластина Плотина Перина Гостиная Кабина Лавина Лощина Мишура Морщина Пучина Старшина Целина Шина Щетина').split(' '));
  var RE_CAP = /^[А-ЯЁ][а-яё]+(?:-[А-ЯЁ][а-яё]+)?$/;
  var RE_INIT = /^[А-ЯЁ]\.$/;

  function titleCase(w) {
    return w.toLowerCase().replace(/(^|-)([а-яё])/g, function (m, a, c) { return a + c.toUpperCase(); });
  }
  function classify(word) {
    if (CUE_WORDS[word.toLowerCase()]) return null;
    if (word.length > 2 && /^[А-ЯЁ-]+$/.test(word)) word = titleCase(word);
    var lw = word.toLowerCase();
    if (RE_INIT.test(word)) return 'I';
    if (!RE_CAP.test(word)) return null;
    if (NAME_FORMS[lw]) return AMBIG[lw] ? 'n' : 'N';
    if (RE_PATR.test(word) || PATR_SPECIAL[lw]) return 'P';
    if (NOT_SURNAME[lw]) return 'C';
    var strong = RE_SURN_STRONG.test(word), weak = !strong && RE_SURN_WEAK.test(word);
    if ((strong || weak) && isCommonWord(lw)) return 'C';     // «Корзина», «Логин», «Причина» — обычные слова
    if (strong) return 'S';
    if (weak) return 's';
    var parts = word.split('-');
    if (parts.length === 2 && (RE_SURN_STRONG.test(parts[0]) || RE_SURN_STRONG.test(parts[1]))) return 'S';
    return 'C';
  }

  // Словарь OpenCorpora (src/lexicon.js): слово с «фамильным» окончанием, которое на деле обычное.
  function isCommonWord(lw) {
    if (typeof Lexicon === 'undefined') return false;
    lw = lw.replace(/ё/g, 'е');
    return Lexicon.commonForms.has(lw) || Lexicon.commonStems.has(surnameKey(lw));
  }

  function surnameKey(w) {
    var lw = w.toLowerCase(), m;
    if ((m = /^(.+?(?:ов|ев|ёв|ин|ын))(?:а|у|ым|ом|е|ой|ою|ых|ыми|ы)?$/.exec(lw))) return m[1];
    if ((m = /^(.+?(?:ск|цк))(?:ий|ая|ого|ому|им|ом|ой|ую)$/.exec(lw))) return m[1];
    if ((m = /^(.+?(?:ук|юк|ян|янц))(?:а|у|ом|е)?$/.exec(lw))) return m[1];
    return lw;
  }
  function patrKey(w) {
    var lw = w.toLowerCase(), m;
    if ((m = /^(.+?(?:ович|евич|ёвич|ич))(?:а|у|ем|е|ом)?$/.exec(lw))) return m[1];
    if ((m = /^(.+?(?:овн|евн|ичн|иничн))(?:а|ы|е|у|ой|ою)$/.exec(lw))) return m[1] + 'а';
    return lw;
  }

  // ───────────────────────── Структурные шаблоны ─────────────────────────

  function digits(s) { return s.replace(/\D/g, ''); }

  function snilsOk(s) {
    var d = digits(s); if (d.length !== 11) return false;
    var num = d.slice(0, 9), ctrl = +d.slice(9), sum = 0;
    for (var i = 0; i < 9; i++) sum += (+num[i]) * (9 - i);
    var c = sum < 100 ? sum : sum === 100 || sum === 101 ? 0 : (sum % 101 === 100 ? 0 : sum % 101);
    return c === ctrl;
  }
  function innOk(s) {
    var d = digits(s).split('').map(Number);
    function k(w) { var t = 0; for (var i = 0; i < w.length; i++) t += w[i] * d[i]; return t % 11 % 10; }
    if (d.length === 10) return k([2, 4, 10, 3, 5, 9, 4, 6, 8]) === d[9];
    if (d.length === 12) return k([7, 2, 4, 10, 3, 5, 9, 4, 6, 8]) === d[10] && k([3, 7, 2, 4, 10, 3, 5, 9, 4, 6, 8]) === d[11];
    return false;
  }
  function luhnOk(s) {
    var d = digits(s), sum = 0, alt = false;
    for (var i = d.length - 1; i >= 0; i--) {
      var n = +d[i]; if (alt) { n *= 2; if (n > 9) n -= 9; } sum += n; alt = !alt;
    }
    return d.length >= 13 && sum % 10 === 0;
  }
  function ctx(text, start, n) {
    var s = text.slice(Math.max(0, start - n), start), nl = s.lastIndexOf('\n');
    return (nl >= 0 ? s.slice(nl + 1) : s).toLowerCase();
  }

  var MONTHS = '(?:января|февраля|марта|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря)';
  var STREET = '(?:ул\\.?|улиц[аеуы]|пр-?т\\.?|просп\\.?|проспект[аеу]?|пер\\.?|переул(?:ок|ка|ке)|б-р|бульвар[аеу]?|ш\\.|шоссе|наб\\.?|набережн(?:ая|ой)|пл\\.?|площад[ьи]|мкр\\.?|микрорайон[аеу]?|проезд[аеу]?|туп\\.?|тупик[аеу]?|аллея|аллеи|линия|тракт[аеу]?|кв-л|квартал[аеу]?)';

  // ── Деньги ──
  var NUM = '\\d{1,3}(?:[\\s\\u00a0\\u202f.]\\d{3})+(?:[.,]\\d{1,2})?|\\d+(?:[.,]\\d{1,3})?';
  var MULT = '(?:\\s*(?:тыс\\.?|тысяч[а-я]*|млн\\.?|миллион[а-я]*|млрд\\.?|миллиард[а-я]*))?';
  var MULT_REQ = '\\s*(?:тыс\\.?|тысяч[а-я]*|млн\\.?|миллион[а-я]*|млрд\\.?|миллиард[а-я]*)';
  var WORDS = '(?:\\s*\\([а-яё\\s-]{3,}\\))?';
  var CUR = '(?:руб(?:лей|ля|ль)?\\.?|р\\.|₽|RUB|RUR|USD|EUR|долл(?:аров|ара|ар)?\\.?|\\$|€|евро)';
  var KOP = '(?:\\s*\\d{1,2}\\s*коп(?:еек|ейки|ейка|\\.)?)?';
  var NOT_WORD = '(?![А-Яа-яЁёA-Za-z])';
  // Хосты: домены первого уровня, которые встречаются в рабочих документах и логах.
  var TLD = '(?:ru|su|рф|com|net|org|info|biz|io|local|lan|corp|internal|intra|loc|localdomain|gov|edu|test|dev|stage|prod|cloud|online|tech)';
  var INFRA = /(?:^|-)(?:db|pg|psql|sql|srv|app|api|web|kafka|redis|node|host|vm|k8s|nginx|proxy|gw|mq|rabbit|es|elastic|ch|mongo|test|prod|stage|dev|uat|preprod|backend|front|worker|cache|ldap|ad|dc|fs|s3|minio|etcd)(?:-|$)/;
  var NOT_HOST_PREFIX = /^(?:utf|iso|sha|md|cp|win|windows|koi|rfc|covid|x|ipv|ip|tls|ssl|http|ver|v|step|шаг|h|tcp|udp|log4j|java|python|node)$/i;

  var PATTERNS = [
    { type: 'ПАСПОРТ', rank: 2.6, group: 1, re: /(?<![A-Za-zА-Яа-яЁё])(?:passport|pasport|паспорт|doc_?number)["']?\s*(?:[:=]|=>)\s*["']?(\d{2}\s?\d{2}\s?№?\s?\d{6})(?!\d)/gi },
    { type: 'ДАТА_РОЖДЕНИЯ', group: 1, re: new RegExp('(?:birth_?[Dd]ate|[Bb]irthday|[Dd]ate_?[Oo]f_?[Bb]irth|\\bdob|ДатаРождения|дата_?рождения)["\'>]?\\s*[:=]?\\s*["\']?(\\d{1,2}\\s+' + '(?:января|февраля|марта|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря)' + '\\s+(?:19|20)\\d{2}(?:\\s*г\\.?)?)', 'g') },
    // Телефоны без кода страны: «(913)186-9993», и закодированные в адресной строке: «+7%20985%20260…»
    { type: 'ТЕЛЕФОН', re: /(?<![\d)])\(\d{3}\)\s?\d{3}[-\s]?\d{2}[-\s]?\d{2}(?!\d)/g },
    { type: 'ТЕЛЕФОН', re: /(?:%2B7|\+7|(?<![\d%])8)(?:%20|%28|%29|[-\s()])*\d{3}(?:%20|%28|%29|[-\s()])*\d{3}(?:%20|-|\s)*\d{2}(?:%20|-|\s)*\d{2}(?!\d)/g,
      check: function (m) { return /%2[089B]/i.test(m) && m.replace(/%2[089B]/gi, '').replace(/\D/g, '').length === 11; } },
    // Адрес, где название перед типом улицы: «г. Казань, Цветной б-р, д. 24, кв. 25», «Садовая ул. 83-19»
    { type: 'АДРЕС', re: /(?:\d{6},\s*)?(?:(?:г\.?\s*)?[А-ЯЁ][а-яё]+(?:[\s-][А-ЯЁ][а-яё]+)?,\s*)?[А-ЯЁ][а-яё]+(?:ая|ой|ий|ый|ое|ей)?\s+(?:ул\.?|улица|б-р|бульвар|пр-т|проспект|пер\.?|переулок|ш\.|шоссе|наб\.?|набережная|пл\.?|площадь|проезд|тупик)(?:,?\s*(?:д\.?|дом)?\s*\d+[А-Яа-я]?(?:\s*[-/]\s*\d+)?)(?:,?\s*(?:к\.?|корп\.?|стр\.?)\s*\d+)?(?:,?\s*(?:кв\.?|оф\.?)\s*\d+)?/g },
    // Индекс и город перед адресом: «581141, Казань,»
    { type: 'АДРЕС', re: /(?<!\d)\d{6},\s*(?:г\.?\s*)?[А-ЯЁ][а-яё]+(?:[\s-][А-ЯЁ][а-яё]+)?(?=,)/g },
    // ── Деньги без валюты: формат «1 250 000,00» и суммы рядом со словами про деньги ──
    { type: 'ДЕНЬГИ', re: /(?<![\d.,])\d{1,3}(?:[\s  ]\d{3})+,\d{2}(?![\d])/g },
    { type: 'ДЕНЬГИ', group: 1, re: /(?<![А-Яа-яЁё])(?:[Сс]тоимост\S*|[Сс]умм[аеуыо]\S*|[Цц]ен[аеуыо]\S*|НМЦК|НМЦ|[Бб]юджет\S*|[Оо]плат\S*|[Аа]ванс\S*|[Шш]траф\S*|[Пп]ен[яиюе]\S*|[Оо]беспечени\S*|[Сс]тавк\S*|[Ии]того|[Оо]клад\S*|[Зз]арплат\S*|[Вв]ыплат\S*|[Вв]ознагражден\S*|[Пп]ремия|[Пп]ремии)[^\d\n]{0,40}?(\d{1,3}(?:[\s  ]\d{3})+(?:[.,]\d{1,2})?|\d{4,}(?:[.,]\d{1,2})?)(?![\d.,]*\s*(?:%|шт|ч\b|час|дн|мес|лет|год|чел|мин|сек|мс|раз|запис|строк|страниц))/g },
    // ── Даты рождения и паспорт в логах и анкетах ──
    { type: 'ДАТА_РОЖДЕНИЯ', group: 1, re: /(?:birth_?[Dd]ate|[Bb]irthday|[Dd]ate_?[Oo]f_?[Bb]irth|\bdob|ДатаРождения|дата_?рождения)["'>]?\s*[:=]?\s*["']?(\d{4}-\d{2}-\d{2}|\d{1,2}[./-]\d{1,2}[./-]\d{2,4})/g },
    { type: 'ПАСПОРТ', group: 1, re: /[Сс]ери[яиюей]\s*[:№]?\s*(\d{2}\s?\d{2})(?=\s*(?:,\s*)?(?:№|номер|N)\s*\d{6})/g },
    { type: 'ПАСПОРТ', group: 1, re: /[Сс]ери[яиюей]\s*[:№]?\s*\d{2}\s?\d{2}\s*(?:,\s*)?(?:№|номер|N)\s*(\d{6})(?!\d)/g },
    { type: 'ПАСПОРТ', group: 1, re: /[Вв]ыдан\S*\s+((?:[А-ЯЁ][А-Яа-яЁё.-]*|[а-яё.-]+)(?:\s+(?:[А-ЯЁ][А-Яа-яЁё.-]*|[а-яё.-]+)){0,8}?(?:\s+\d{2}\.\d{2}\.\d{4})?)(?=[,;]|\.\s|\.?$|\s+код)/gm,
      check: function (m, text, i) { return /паспорт|серия|сери[ия]\s*\d|удостоверени|свидетельств/.test(text.slice(Math.max(0, i - 100), i + 1).toLowerCase()); } },
    { type: 'ДЕНЬГИ', re: new RegExp('(?<![\\d.,])(?:' + NUM + ')' + MULT + '(?:\\s+(?:' + NUM + ')' + MULT_REQ + ')*' + WORDS + '\\s*' + CUR + KOP + NOT_WORD, 'g') },
    { type: 'ДЕНЬГИ', re: new RegExp('(?:\\$|€|₽|USD|EUR|RUB)\\s?(?:' + NUM + ')' + MULT, 'g') },
    { type: 'ДЕНЬГИ', group: 1, re: /(?<![A-Za-z])(?:amount|sum|summa|total|price|cost|balance|payment|salary|fee)["']?\s*(?:[:=]|=>)\s*["']?(\d[\d.,]*\d|\d)/gi },
    { type: 'ДЕНЬГИ', group: 1, re: /(?<![А-Яа-яЁё])(?:[Сс]умм[аеуы]|[Сс]тоимост[ьи]|[Цц]ен[аеуы])\s*[:=]\s*(\d[\d\s .,]*\d)/g },
    // ── Реквизиты, счета, договоры, организации ──
    { type: 'РЕКВИЗИТЫ', group: 1, re: /ИНН\s*\/\s*КПП\s*[:№]?\s*(\d{10,12})\s*\/\s*\d{9}(?!\d)/g },
    { type: 'РЕКВИЗИТЫ', group: 1, re: /ИНН\s*\/\s*КПП\s*[:№]?\s*\d{10,12}\s*\/\s*(\d{9})(?!\d)/g },
    { type: 'КАРТА', group: 1, re: /(?:\*{4}|x{4}|X{4}|•{4})[\s-]?(\d{4})(?!\d)/g },
    { type: 'ТЕЛЕФОН', group: 1, re: /(?<![А-Яа-яЁё])(?:доб\.?|добавочн\S*|вн\.|внутр\S*\s+номер\S*)\s*(\d{2,6})(?!\d)/gi },
    { type: 'ОРГАНИЗАЦИЯ', re: /(?<![А-Яа-яЁё«"])(?:ООО|ОАО|ЗАО|ПАО|НАО|АО|ИП|ТОО|НПО)\s+(?:[А-ЯЁA-Z][\wА-Яа-яЁё]*(?:-[\wА-Яа-яЁё]+)*)(?:\s+[А-ЯЁA-Z][\wА-Яа-яЁё-]+){0,2}/g },
    { type: 'РЕКВИЗИТЫ', group: 1, re: /(?<![А-Яа-яЁёA-Za-z])(?:ИНН|КПП|ОГРН(?:ИП)?|БИК|ОКПО|ОКТМО|ОКАТО)\s*(?:организации|юр\.?\s*лица|получателя|банка)?\s*[:№]?\s*(\d{8,15})(?!\d)/g },
    { type: 'СЧЁТ', group: 1, re: /(?:р\/с|к\/с|р\/сч|к\/сч|[Рр]асч[её]тн\S*\s+сч[её]т\S*|[Кк]орр?\S*\s*сч[её]т\S*|[Лл]ицев\S*\s+сч[её]т\S*|[Сс]ч[её]т)\s*[:№]?\s*(\d{20})(?!\d)/g },
    { type: 'ДОГОВОР', group: 1, re: /(?<![А-Яа-яЁё])(?:[Кк]онтракт\S*|[Дд]оговор\S*|[Сс]ч[её]т(?:а|у|ом|е)?|[Аа]кт(?:а|у|ом|е)?|УПД|[Нн]акладн\S*|[Сс]оглашени\S*|[Зз]аявк\S*|[Ии]звещени\S*|[Зз]акупк\S*|ИКЗ)\s*(?:№|N|#)\s*([A-Za-zА-Яа-яЁё0-9][\wА-Яа-яЁё./-]{2,40}[A-Za-zА-Яа-яЁё0-9])/g },
    { type: 'ОРГАНИЗАЦИЯ', re: /(?<![А-Яа-яЁё])(?:ООО|ОАО|ЗАО|ПАО|НАО|АО|ФГУП|ГУП|МУП|ФГБУ|ФГАУ|ФГКУ|ФКУ|ГБУ|ГАУ|ГКУ|МКУ|МБУ|МАУ|АНО|НКО|НП|ТОО|НПО|НИИ)\s*(?:«[^»\n]{2,80}»|"[^"\n]{2,80}"|„[^“\n]{2,80}“)/g },
    // ── Серверы, домены, URL, пути ──
    { type: 'ХОСТ', re: /(?:https?|ftps?|sftp|wss?|jdbc:[a-z0-9]+|ldaps?|amqps?|redis|mongodb(?:\+srv)?|kafka|s3|smb|nfs):\/\/[^\s"'<>()\]]*[^\s"'<>()\].,;:]/gi },
    { type: 'ХОСТ', re: new RegExp('(?<![\\w@.\\-/])(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\\.)+' + TLD + '(?![\\w-]|\\.[A-Za-z0-9])', 'gi') },
    { type: 'ХОСТ', group: 1, re: /\\\\([A-Za-z0-9][A-Za-z0-9.-]+)\\/g },
    { type: 'ХОСТ', group: 1, re: /(?<![A-Za-zА-Яа-яЁё])(?:[Сс]ервер\S*|[Хх]ост\S*|[Hh]ost(?:name)?|[Сс]тенд\S*|[Бб]аз[аеуы]|БД|[Dd][Bb]|[Dd]atabase|[Nn]ode|[Уу]зел|[Ss]erver|[Бб]акет\S*|[Bb]ucket)\s*[:=]?\s*([a-z][a-z0-9_]*(?:[-_.][a-z0-9_]+)+)/g },
    { type: 'ХОСТ', re: /(?<![\w.\-/\[])[a-z][a-z0-9]*(?:-[a-z0-9]+)*-\d{1,3}(?![\w.\-\]])/g,
      check: function (m) { return !NOT_HOST_PREFIX.test(m.split('-')[0]) && m.length >= 6 && INFRA.test(m); } },
    // ── Методы API и классы ──
    { type: 'МЕТОД', group: 1, re: /(?<![A-Za-z])(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(\/[^\s"?#]*[^\s"?#.,;:])/g },
    { type: 'МЕТОД', re: /(?<![\w\/.:])\/(?:api|rest|esia|oauth2?|v\d+|ws|services|soap|graphql|internal)\/[A-Za-z0-9_\-\/{}.]*[A-Za-z0-9_}]/g },
    { type: 'МЕТОД', re: /(?<![\w.$])(?:[a-z][a-z0-9_]*\.){2,}[A-Z][A-Za-z0-9_$]*(?:\.[a-z_][A-Za-z0-9_$]*)?(?![\w$])/g },
    // ── Параметры адресной строки: ?student=778812&class=7 ──
    { type: 'ID', group: 1, re: /[?&;][A-Za-z_][A-Za-z0-9_]*=(\d{3,20}|[0-9a-fA-F-]{32,36})(?![\w-])/g },
    // ── Логин / пароль одной строкой ──
    { type: 'ТОКЕН', group: 1, re: /(?:[Уу]ч[её]тн\S*\s+запис\S*|[Лл]огин(?:\s*\/\s*пароль)?|[Вв]ход|[Cc]redentials|[Ll]ogin(?:\s*\/\s*password)?)[^\n]{0,40}?[\w.@-]{3,}\s*\/\s*(\S*[A-Za-z]\S*\d\S*?|\S*\d\S*[A-Za-z]\S*?)(?=[.,;]?(?:\s|$))/gm,
      check: function (m) { return !/^(?:пароль|password)$/i.test(m.split('/').pop().trim()); } },
    // ── Сеть ──
    { type: 'IP', re: /(?<![0-9A-Fa-f:])(?:[0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}(?![0-9A-Fa-f:])/g },
    { type: 'IP', re: /(?<![0-9A-Fa-f:])(?:[0-9A-Fa-f]{1,4}:){2,7}[0-9A-Fa-f]{1,4}(?![0-9A-Fa-f:])/g, check: function (m) { return /[a-f]/i.test(m) || m.split(':').length >= 4; } },
    // ── Логины и секреты в логах ──
    { type: 'НИК', group: 1, re: /(?<![A-Za-z])(?:for|by|from user|as)\s+(?:user\s+|invalid user\s+)?([a-z_][a-z0-9]*(?:[._-][a-z0-9]+)+|[a-z_]+\d+[a-z0-9_]*)\s+from\s/g },
    { type: 'НИК', group: 1, re: /(?<![\w.@-])([a-z][a-z0-9]*(?:[._-][a-z0-9]+)*)@(?=[a-z][a-z0-9-]*(?![\w-]|\.\w))/g },
    { type: 'ХОСТ', group: 1, re: /(?<![\w.@-])[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*@([a-z][a-z0-9-]*)(?![\w-]|\.\w)/g },
    { type: 'НИК', group: 1, re: /(?:^|\n)\S+\s+-\s+([A-Za-z0-9._@-]*[A-Za-z][A-Za-z0-9._@-]*)\s+\[/g },
    { type: 'НИК', group: 1, re: /(?<![A-Za-z])(?:User|user|[Пп]ользовател\S*|[Aa]ccount)\s+([a-z][a-z0-9]*(?:[._-][a-z0-9]+)+|[a-z]+\d+[a-z0-9]*)(?![\w@.-])/g },
    { type: 'НИК', group: 1, re: /(?<![A-Za-z])(?:user|usr|owner|author)["']?\s*(?:[:=]|=>)\s*["']?([A-Za-z0-9][A-Za-z0-9._@-]{0,62}[A-Za-z0-9])/g },
    { type: 'НИК', group: 1, re: /(?:[Пп]ользовател\S*\s+(?:БД|базы|СУБД)|db_?user|DB user)\s*[:=]?\s*([A-Za-z0-9][A-Za-z0-9._-]{1,40})/g },
    { type: 'НИК', group: 1, re: /(?:\/home\/|\/Users\/|[A-Za-z]:\\Users\\|\\Users\\)([A-Za-z0-9._-]{2,40})/g },
    { type: 'ТОКЕН', re: /(?<![0-9A-Za-z-])(?=[0-9a-f]*[a-f])(?=[0-9a-f]*\d)[0-9a-f]{16,}(?![0-9A-Za-z-])/g },
    { type: 'ТОКЕН', group: 1, re: /(?<![А-Яа-яЁёA-Za-z])(?:[Пп]ароль|[Pp]assword|[Pp]asswd)\s*[:=—–-]?\s*([A-Za-z0-9!@#$%^&*_+\-]+(?:\.[A-Za-z0-9!@#$%^&*_+\-]+)*)/g,
      check: function (m) { return /\d|[A-Z]|[!@#$%^&*]/.test(m.replace(/^\S+\s*[:=—–-]?\s*/, '')) && m.replace(/^\S+\s*[:=—–-]?\s*/, '').length >= 4; } },
    { type: 'ПОЧТА', re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-zА-Яа-я]{2,}/g },
    { type: 'ПОЧТА', re: /[А-Яа-яЁё0-9._-]+@[А-Яа-яЁё0-9.-]+\.(?:рф|рус|ru|com)/g },
    { type: 'АДРЕС', re: new RegExp('(?:\\d{6},\\s*)?(?:(?:г\\.?|город|пос\\.|посёлок|поселок|с\\.|село|д\\.|деревня|пгт)\\s+[А-ЯЁ][А-Яа-яЁё-]+,?\\s*)?' + STREET +
        '\\s+[А-ЯЁ0-9][А-Яа-яЁё0-9 .-]{0,40}?,?\\s*(?:д\\.?|дом)\\s*\\d+[А-Яа-яЁё]?(?:\\s*[,/]?\\s*(?:к\\.?|корп\\.?|корпус|стр\\.?|строение)\\s*\\d+)?(?:\\s*,?\\s*(?:кв\\.?|квартира|оф\\.?|офис)\\s*\\d+)?', 'gi') },
    { type: 'АДРЕС', re: new RegExp(STREET + '\\s+[А-ЯЁ][А-Яа-яЁё-]+(?:\\s+[А-ЯЁ][А-Яа-яЁё-]+)?,?\\s*\\d+[А-Яа-яЁё]?(?:\\s*[,-]\\s*(?:кв\\.?\\s*)?\\d+)?', 'g') },
    { type: 'КАРТА', re: /(?<!\d)(?:\d{4}[ -]?){3}\d{4}(?:[ -]?\d{3})?(?!\d)/g, check: function (m) { return luhnOk(m); } },
    { type: 'СЧЁТ', re: /(?<!\d)4\d{4}[ .]?\d{3}[ .]?\d[ .]?\d{4}[ .]?\d{7}(?!\d)/g },
    { type: 'ПАСПОРТ', re: /(?<!\d)\d{2}\s?\d{2}\s?№?\s?\d{6}(?!\d)/g,
      check: function (m, t, i) { return /паспорт|серия|сер\.|документ|удостовер/.test(ctx(t, i, 40)) || /^\d{2} \d{2} \d{6}$/.test(m); } },
    { type: 'ПОЛИС', re: /(?<!\d)\d{16}(?!\d)/g, check: function (m, t, i) { return /полис|омс|polis|oms|policy/.test(ctx(t, i, 40)); } },
    { type: 'СНИЛС', re: /(?<!\d)\d{3}[- ]?\d{3}[- ]?\d{3}[- ]?\d{2}(?!\d)/g,
      check: function (m, t, i) { return snilsOk(m) || /^\d{3}-\d{3}-\d{3}[ -]\d{2}$/.test(m) || /снилс/.test(ctx(t, i, 30)); } },
    { type: 'ИНН', re: /(?<!\d)\d{12}(?!\d)/g, check: function (m, t, i) { return innOk(m) || /инн|inn/.test(ctx(t, i, 20)); } },
    { type: 'ИНН', rank: 3.5, re: /(?<!\d)\d{10}(?!\d)/g, check: function (m, t, i) { return /(?:^|[^a-zа-яё])(?:инн|inn)["'\]]?\s*(?:[:=№]|=>)?\s*["']?$/.test(ctx(t, i, 20)); } },
    { type: 'ИНН', re: /(?<!\d)\d{10}(?!\d)/g, check: function (m, t, i) { return /инн\s*(?:физ|граждан|заявител|родител|учител|сотрудник)/.test(ctx(t, i, 40)); } },
    { type: 'ТЕЛЕФОН', re: /(?<![\d+])(?:\+7|8|7)[\s\u00a0]*[(\-–]?[\s\u00a0]*\d{3,5}[\s\u00a0]*[)\-–]?[\s\u00a0]*\d{1,3}(?:[\s\u00a0\-–]*\d{2}){2}(?!\d)/g,
      check: function (m) { return digits(m).length === 11; } },
    { type: 'ТЕЛЕФОН', re: /(?<![\d+])9\d{2}[\s \-–]?\d{3}[\s \-–]?\d{2}[\s \-–]?\d{2}(?!\d)/g },
    { type: 'ДАТА_РОЖДЕНИЯ', re: new RegExp('(?<!\\d)(?:\\d{1,2}[./-]\\d{1,2}[./-](?:19|20)?\\d{2}|\\d{1,2}\\s+' + MONTHS + '\\s+(?:19|20)\\d{2}(?:\\s*г\\.?)?|(?:19|20)\\d{2}-\\d{2}-\\d{2})(?!\\d)', 'g'),
      check: function (m, t, i) { return /рожд|д\.\s?р\.|г\.\s?р\.|родил|дата рожд|\bдр\b|возраст/.test(ctx(t, i, 30)); } },
    { type: 'ШКОЛА', re: /(?<![А-Яа-яЁё])(?:МБОУ|МАОУ|МКОУ|МОУ|ГБОУ|ГАОУ|ГКОУ|ЧОУ|ФГБОУ|МБДОУ|МАДОУ|ГБПОУ|НОУ|АНО)\s*(?:«[^»\n]{1,120}»|"[^"\n]{1,120}"|[^,;\n.()]{1,80})/g },
    { type: 'ШКОЛА', re: /(?<![А-Яа-яЁё])(?:[Шш]кол[аыеуой]{1,2}|СОШ|ООШ|НОШ|[Гг]имнази[яиюей]{1,2}|[Лл]ице[йяюем]{1,2}|[Дд]етск(?:ий|ого) сад[а]?)\s*№\s*\d+(?:\s*(?:им\.|имени)\s*[А-ЯЁ][А-Яа-яЁё. ]{2,40})?/g },
    { type: 'ГОСНОМЕР', re: /(?<![А-ЯЁA-Z0-9])[АВЕКМНОРСТУХ]\s?\d{3}\s?[АВЕКМНОРСТУХ]{2}\s?\d{2,3}(?![А-ЯЁA-Z0-9])/g },
    { type: 'НИК', re: /(?<![\w@.])@[A-Za-z][A-Za-z0-9_]{3,31}(?![\w@])/g },
    { type: 'НИК', re: /(?:vk\.com|t\.me|ok\.ru)\/[A-Za-z0-9_.]{3,}/g },
    { type: 'IP', re: /(?<![\d.])(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)(?![\d.])/g },
    // Пароли и токены доступа — в логах, выгрузках, настройках.
    { type: 'ТОКЕН', re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g },
    { type: 'ТОКЕН', group: 1, re: /(?:Bearer|Basic)\s+([A-Za-z0-9._~+\/-]{12,}=*)/g },
    { type: 'ТОКЕН', group: 1, re: /(?<![A-Za-z])(?:password|passwd|pwd|пароль|token|access_token|refresh_token|secret|api_?key|apikey|session_?id|sessionid|cookie|private_?key|access_?key(?:_id)?|client_?secret)[A-Za-z_]*["']?\s*(?:[:=]|=>)\s*["']?([^\s"',;&}]{3,})/gi },
    // Логины.
    { type: 'НИК', group: 1, re: /(?<![A-Za-z])(?:login|username|user_name|userName)["']?\s*(?:[:=]|=>)\s*["']?([A-Za-z0-9][A-Za-z0-9._@-]{1,62}[A-Za-z0-9])/g },
    // По-русски, как в ЧТЗ и ПМИ: «Логин в стенд: smirnov_op», «логин для входа в админку — petrov_v», «учётка ivanov_a»
    { type: 'НИК', group: 1, re: /(?<![А-Яа-яЁё])(?:[Лл]огин\S{0,2}|[Уу][чч][её]тк[аеуио]й?|[Уу][чч][её]тн\S*\s+запис\S*)(?:\s+(?:в|для|от|на|к|пользователя)\s+[^\n:—–=]{1,30}?)?\s*(?:[:=—–-]\s*|\s+)([A-Za-z0-9][A-Za-z0-9._@-]{1,62}[A-Za-z0-9])(?![\w@.-])/g, rank: 1 },
    // Пароли и ПИН: «Пароль от стенда: Qwerty123», «пароль — P@ssw0rd!», «PIN 4821». Слова по-русски паролем не считаем.
    { type: 'ТОКЕН', group: 1, re: /(?<![А-Яа-яЁёA-Za-z])(?:[Пп]ароль|[Pp]assword|[Pp]ass|pwd|PIN|ПИН|[Пп]ин-код|[Кк]од доступа)(?:\s+(?:в|для|от|на|к|пользователя|администратора)\s+[^\n:—–=]{1,30}?)?\s*(?:[:=—–-]\s*|\s+)((?=[^\s,;]*[A-Za-z0-9!@#$%^&*])[^\s,;«»"']{3,63}[^\s,;.«»"'])/g },
    { type: 'НИК', group: 1, re: /(?<![А-Яа-яЁё])(?:[Лл]огин|[Уу]ч[её]тн\S{2,3} запис\S{1,2})\s*[:—–-]?\s*([A-Za-z0-9][A-Za-z0-9._@-]{1,62}[A-Za-z0-9])/g },
    // ID: UUID, «ключ = значение» в логах и JSON, «ID 12345», длинные номера.
    { type: 'ID', re: /(?<![0-9A-Za-z-])[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}(?![0-9A-Za-z-])/g },
    { type: 'ID', group: 1, re: /(?<![A-Za-z])(?:[A-Za-z]*(?:Id|ID|Uuid|UUID|Guid|GUID)|[a-z]+_(?:id|uuid|guid)|id|uid|uuid|guid|oid|order|request|ticket|case|trace|transaction|txn|invoice|claim|application)["'\]]?\s*(?:[:=]|=>)\s*["']?([A-Za-z0-9](?:[A-Za-z0-9._-]{0,62}[A-Za-z0-9])?)/g ,
      check: function (m) { return /\d/.test(m.slice(m.search(/[:=]/) + 1)); } },
    { type: 'ID', group: 1, re: /(?<![A-Za-zА-Яа-яЁё])(?:ID|Id|ИД|id|[Ии]дентификатор\S{0,3})\s*[#№:]?\s*(\d[\d-]{0,30}\d|\d)(?!\d)/g },
    { type: 'ID', group: 1, re: /(?<![A-Za-zА-Яа-яЁё])(?:ID|ИД|[Ии]дентификатор)\s+[а-яё]+(?:\s+[а-яё]+)?\s*[—–:=-]?\s*(\d[\d-]{0,30}\d|\d)(?!\d)/g },
    // «заявка 10000», «обращения № 4521», «тикет #88213» — номер из трёх и больше цифр
    { type: 'ID', group: 1, re: /(?<![А-Яа-яЁё])(?:[Зз]аявк(?:а|и|у|е|ой)|[Зз]аявлени(?:е|я|ю|ем)|[Оо]бращени(?:е|я|ю|ем)|[Зз]аказ(?:а|у|е|ом)?|[Тт]икет(?:а|у|е|ом)?|[Ии]нцидент(?:а|у|е|ом)?|[Зз]апрос(?:а|у|е|ом)?)\s*(?:№|#|N)?\s*(\d[\d-]{1,30}\d)(?![\d.,]\d)/g },
    { type: 'ID', re: /(?<![\d.,])\d{10,20}(?![\d.,])/g }
  ];

  // ───────────────────────── Сессия ─────────────────────────

  function Session(opts) {
    opts = opts || {};
    this.types = {};
    for (var t in TYPES) this.types[t] = TYPES[t].on;
    if (opts.types) for (var k in opts.types) this.types[k] = !!opts.types[k];
    // Ключ: метка → { type, value } и обратный индекс.
    this.key = { version: 1, counters: {}, tokens: {}, index: {} };
    if (opts.key) this.loadKey(opts.key);
    this.allow = setOf(DEFAULT_ALLOW);
    this.skip = Object.create(null);    // значения, которые пользователь не скрывает (по ключу нормализации)
    this.extra = [];                    // свои правила: { type, re }
    this.people = [];                   // все найденные упоминания людей (для склейки «Анна» → «Анна Петрова»)
    this.personAlias = Object.create(null);
    this.idMode = opts.idMode === 'token' ? 'token' : 'pseudo';
    this.idOriginals = Object.create(null);   // исходные ID: новые не должны с ними совпадать
    if (opts.allow) this.addAllow(opts.allow);
    if (opts.people) this.addPeople(opts.people);
    if (opts.rules) this.setRules(opts.rules);
  }

  Session.prototype.loadKey = function (key) {
    this.key = { version: 1, counters: key.counters || {}, tokens: key.tokens || {}, index: key.index || {} };
  };

  Session.prototype.addAllow = function (words) {
    var self = this;
    (words || []).forEach(function (w) { if (w) self.allow[String(w).toLowerCase()] = true; });
  };

  // Свои правила: строки. «/шаблон/» — регулярное выражение, остальное — слово или фраза.
  // Можно указать тип: «ШКОЛА: Лицей Вектор».
  Session.prototype.setRules = function (lines) {
    var out = [];
    (lines || []).forEach(function (line) {
      line = String(line).trim(); if (!line || line[0] === '#') return;
      var type = 'СВОЁ', m = /^([А-ЯЁA-Z_]{2,20})\s*:\s*(.+)$/.exec(line);
      if (m && TYPES[m[1]]) { type = m[1]; line = m[2].trim(); }
      var re;
      if (/^\/.+\/[a-z]*$/.test(line)) {
        var last = line.lastIndexOf('/');
        try { re = new RegExp(line.slice(1, last), 'g' + line.slice(last + 1).replace('g', '')); } catch (e) { return; }
      } else {
        var esc = line.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
        re = new RegExp('(?<![А-Яа-яЁёA-Za-z0-9])' + esc + '(?![А-Яа-яЁёA-Za-z0-9])', 'gi');
      }
      out.push({ type: type, re: re, source: line });
    });
    this.extra = out;
  };

  Session.prototype.setSkip = function (keys) {
    var s = Object.create(null); (keys || []).forEach(function (k) { s[k] = true; }); this.skip = s;
  };

  // Нормализованный ключ значения: одно и то же лицо/номер → один ключ.
  function normKey(type, value, person) {
    if (type === 'ФИО' && person) return 'ФИО:' + personKey(person);
    if (type === 'ТЕЛЕФОН') { var d = digits(value); if (d.length === 11) d = d.slice(1); return type + ':' + d; }
    if (/^(СНИЛС|ИНН|ПАСПОРТ|ПОЛИС|КАРТА|СЧЁТ)$/.test(type)) return type + ':' + digits(value);
    if (type === 'МЕТОД') return 'МЕТОД:' + value.replace(/\/(?:\d+|[0-9a-f]{8,}|[0-9a-f-]{36})(?=\/|$)/gi, '/{id}');
    if (type === 'ДЕНЬГИ') return 'ДЕНЬГИ:' + value.replace(/[\s\u00a0\u202f]+/g, ' ').toLowerCase();
    if (type === 'ID') return 'ID:' + (/^[0-9a-f-]{36}$/i.test(value.trim()) ? value.trim().toLowerCase() : value.trim());
    return type + ':' + value.toLowerCase().replace(/\s+/g, ' ').replace(/ё/g, 'е').trim();
  }
  function personKey(p) {
    return [p.s || '', p.n || '', p.p || '', (p.i || []).join('')].join('|');
  }

  // Разбор упоминания на части: фамилия, имя, отчество, инициалы.
  function parsePerson(words, kinds) {
    var p = { s: null, n: null, p: null, i: [] };
    for (var k = 0; k < words.length; k++) {
      var w = words[k], c = kinds[k];
      if (c === 'N' || c === 'n') { if (!p.n) p.n = NAME_FORMS[w.toLowerCase()]; else if (!p.s) p.s = surnameKey(w); }
      else if (c === 'P') p.p = patrKey(w);
      else if (c === 'I') p.i.push(w[0].toLowerCase());
      else if (!p.s) p.s = surnameKey(w);
    }
    return p;
  }

  function compatible(a, b) {   // a — короткое упоминание, b — полное
    if (a.s && a.s !== b.s) return false;
    if (a.n && a.n !== b.n) return false;
    if (a.p && a.p !== b.p) return false;
    if (a.i.length) {
      var letters = [b.n && b.n[0], b.p && b.p[0]].filter(Boolean).concat(b.i);
      for (var k = 0; k < a.i.length; k++) if (letters.indexOf(a.i[k]) < 0) return false;
    }
    return richness(b) > richness(a);
  }
  function richness(p) { return (p.s ? 2 : 0) + (p.n ? 2 : 0) + (p.p ? 1 : 0) + p.i.length * 0.5; }

  // ── ФИО латиницей (в логах, почте, системах): Ivanov Ivan, Petrova A. ──
  var TR = { 'а': 'a', 'б': 'b', 'в': 'v', 'г': 'g', 'д': 'd', 'е': 'e', 'ё': 'e', 'ж': 'zh', 'з': 'z', 'и': 'i', 'й': 'y', 'к': 'k',
    'л': 'l', 'м': 'm', 'н': 'n', 'о': 'o', 'п': 'p', 'р': 'r', 'с': 's', 'т': 't', 'у': 'u', 'ф': 'f', 'х': 'kh', 'ц': 'ts', 'ч': 'ch',
    'ш': 'sh', 'щ': 'shch', 'ъ': '', 'ы': 'y', 'ь': '', 'э': 'e', 'ю': 'yu', 'я': 'ya' };
  function translit(w) { return w.toLowerCase().split('').map(function (c) { return c in TR ? TR[c] : c; }).join(''); }
  var LAT_NAMES = Object.create(null);
  MALE.concat(FEMALE, SHORT).forEach(function (n) {
    if (AMBIG[n.toLowerCase()]) return;
    var l = translit(n); LAT_NAMES[l] = true;
    LAT_NAMES[l.replace(/kh/g, 'h')] = true; LAT_NAMES[l.replace(/iya$/, 'ia').replace(/ya$/, 'ia')] = true;
    LAT_NAMES[l.replace(/yu/g, 'iu').replace(/ya/g, 'ia')] = true; LAT_NAMES[l.replace(/^e/, 'ye')] = true;
  });
  ['alex', 'kate', 'helen', 'mike', 'nick', 'max', 'eugene', 'sergey', 'sergei', 'dmitry', 'dmitrii', 'yuri', 'yury', 'iurii', 'alexey', 'aleksei',
   'alexander', 'alexandra', 'andrei', 'nikolai', 'tatiana', 'natalia', 'olga', 'elena', 'ekaterina', 'maria', 'anastasia', 'julia', 'yulia', 'ksenia']
    .forEach(function (n) { LAT_NAMES[n] = true; });
  var LAT_SURN = /^[A-Z][a-z]{2,}(?:ov|ev|yov|in|yn|ova|eva|ina|yna|sky|skiy|skii|skaya|skaia|tsky|tskiy|enko|uk|yuk|chuk|ich|vich|ovich|evich|ovna|evna|ichna|shvili|dze|yan|ian|ko)$/;
  var LAT_PAIR = /(?<![A-Za-z])([A-Z][a-z]+|[A-Z]\.)\s+([A-Z][a-z]+|[A-Z]\.)(?:\s+([A-Z][a-z]+(?:ovich|evich|ovna|evna|ichna)|[A-Z]\.))?(?![A-Za-z])/g;
  function findLatinPeople(text, out) {
    if (!/[A-Z][a-z]/.test(text)) return;
    LAT_PAIR.lastIndex = 0; var m;
    while ((m = LAT_PAIR.exec(text))) {
      var a = m[1], b = m[2], na = LAT_NAMES[a.toLowerCase()], nb = LAT_NAMES[b.toLowerCase()];
      var sa = LAT_SURN.test(a), sb = LAT_SURN.test(b), ia = /\.$/.test(a), ib = /\.$/.test(b);
      if ((sa && (nb || ib)) || (sb && (na || ia)) || (na && sb) || (m[3] && (na || nb))) {
        out.push({ s: m.index, e: m.index + m[0].length, type: 'ФИО', value: m[0],
          person: { s: (sa ? a : sb ? b : '').toLowerCase().replace(/a$/, '') || null, n: (na ? a : nb ? b : '').toLowerCase() || null, p: null, i: [] } });
      } else LAT_PAIR.lastIndex = m.index + a.length + 1;
    }
  }

  // Поиск людей.
  var WORD_RE = /[А-ЯЁ]\.|[А-ЯЁа-яё]+(?:-[А-ЯЁа-яё]+)?/g;

  var UI_NOUN_BEFORE = /(?:^|[^а-яё])(?:модул[ьяюе]|раздел[ауе]?|кнопк[аиуе]|вкладк[аиуе]|экран[ауе]?|пол[ея]|меню|справочник[ауе]?|сервис[ауе]?|подсистем[аыуе]|виджет[ауе]?|блок[ауе]?|страниц[аыуе]|отчёт[ауе]?|форм[аыуе]|шаблон[ауе]?|компонент[ауе]?|микросервис[ауе]?)\s*[«"„]?\s*$/;
  Session.prototype.findPeople = function (text, out) {
    var words = [], m;
    WORD_RE.lastIndex = 0;
    while ((m = WORD_RE.exec(text))) {
      var w = m[0];
      words.push({ w: w, s: m.index, e: m.index + w.length, k: classify(w), caps: w.length > 2 && /^[А-ЯЁ-]+$/.test(w) });
    }
    var known = this.knownSurnames || {};
    var i = 0;
    while (i < words.length) {
      var cur = words[i], next = words[i + 1];
      if (!cur.k) { i++; continue; }
      if (cur.k === 'C' && cur.caps) { i++; continue; }          // СНИЛС, ИНН, ОГРН — сокращения, не фамилии
      var nextJoined = next && next.k && joined(text, cur, next);
      if (cur.k === 'C' && !nextJoined && !cueBefore(text, cur.s) && !known[surnameKey(cur.w)]) { i++; continue; }
      var j = i, chain = [cur];
      while (j + 1 < words.length && chain.length < 4 && words[j + 1].k && joined(text, words[j], words[j + 1])) {
        chain.push(words[j + 1]); j++;
      }
      var len = this.judgeChain(text, chain, known);
      // «Раздел Кузнецов», «кнопка Морозов», «сервис «Петров»» — название части системы, а не человек.
      // Одна фамилия без имени и отчества сразу после такого слова; человек, уже встреченный в файле, — всё равно человек.
      if (len === 1 && /[Ss]/.test(chain[0].k) && UI_NOUN_BEFORE.test(ctx(text, chain[0].s, 30)) && !known[surnameKey(chain[0].w)]) len = 0;
      if (len) {
        var part = chain.slice(0, len);
        var ws = part.map(function (x) { return x.caps ? titleCase(x.w) : x.w; });
        if (!this.isAllowed(ws)) {
          out.push({ s: part[0].s, e: part[len - 1].e, type: 'ФИО', value: text.slice(part[0].s, part[len - 1].e),
                     person: parsePerson(ws, part.map(function (x) { return x.k; })) });
        }
        i += len;
      } else i++;
    }
  };

  function joined(text, a, b) {
    var gap = text.slice(a.e, b.s);
    return /^[  ]{1,2}$/.test(gap) || (a.k === 'I' && gap === '');
  }
  function cueBefore(text, start) { return PERSON_CUES.test(text.slice(Math.max(0, start - 40), start)); }
  // Слово в середине предложения: перед ним буква, цифра или запятая, а не точка или начало строки.
  function midSentence(text, start) {
    var before = text.slice(Math.max(0, start - 3), start).replace(/[  ]+$/, '');
    return before !== '' && !/[.!?:;\n\r"«(\[—–-]$/.test(before);
  }

  // Сколько слов цепочки — человек (0 — не человек).
  Session.prototype.judgeChain = function (text, chain, known) {
    var k = chain.map(function (x) { return x.k; });
    var cue = cueBefore(text, chain[0].s);
    for (var len = chain.length; len >= 1; len--) {
      var s = k.slice(0, len).join('');
      if (len >= 2) {
        if (/^S[Nn]P?$/.test(s) || /^s[Nn]P?$/.test(s) && k[1] === 'N') return len;                                   // Петров Иван (Иванович)
        if (/^[Cn][Nn]P$/.test(s) || /^C[N]P?$/.test(s) && cue) return len;      // Ким Анна Сергеевна
        if (/^[Nn]P[SsC]?$/.test(s)) return len;                                  // Иван Иванович (Петров)
        if (/^N[SsC]$/.test(s) || /^n[Ss]$/.test(s)) return len;                  // Анна Петрова
        if (/^[SsCNn]I{1,2}$/.test(s)) return len;                                // Петров И. И.
        if (/^I{1,2}[SsCNn]$/.test(s)) return len;                                // И. И. Петров
        if (/^[NnI]I?$/.test(s) && /I/.test(s) && s[0] !== 'I') return len;       // Иван П.
        if (cue && /^[SsCNnP]{2,3}$/.test(s)) return len;                         // ученик Тагир Ахмедов
      } else {
        var c = chain[0], lw = surnameKey(c.w);
        if (c.caps && s !== 'N') { if (cue) return 1; continue; }
        if (s === 'N' || s === 'P') return 1;
        // Со словарём обычные слова («Вопросов», «Корзина») уже отсеяны в classify, поэтому фамилия годится и в начале предложения.
        if (s === 'S' && (typeof Lexicon !== 'undefined' || midSentence(text, c.s) || cue || known[lw] || RE_SURN_FEM.test(c.w) && !COMMON_NOUNS[c.w.toLowerCase()])) return 1;
        if ((s === 's' || s === 'C') && known[lw]) return 1;
        if ((s === 'C' || s === 's' || s === 'n') && cue) return 1;
      }
    }
    return 0;
  };

  Session.prototype.isAllowed = function (ws) {
    var a = this.allow;
    if (a[ws.join(' ').toLowerCase()]) return true;
    return ws.length === 1 && !!a[ws[0].toLowerCase()];
  };

  // Все находки в тексте. hint — тип столбца таблицы (весь текст ячейки — этого типа).
  Session.prototype.detect = function (text, hint) {
    var found = [];
    if (!text) return found;
    if (hint && this.types[hint]) {
      var trimmed = text.trim();
      if (trimmed) {
        var parts = hint === 'ФИО' ? text.split(/([,;\n]+|\s+и\s+)/) : [text], pos = 0;
        for (var q = 0; q < parts.length; q++) {
          var piece = parts[q], tr = piece.trim();
          if (tr && !(q % 2) ) {
            var off = pos + piece.indexOf(tr);
            var f = { s: off, e: off + tr.length, type: hint, value: tr, whole: true };
            if (hint === 'ФИО') {
              var ws = tr.split(/\s+/).map(titleCase);
              f.person = parsePerson(ws, ws.map(function (w) { return classify(w) || 'C'; }));
            }
            found.push(f);
          }
          pos += piece.length;
        }
        return this.finish(found);
      }
    }
    var self = this;
    PATTERNS.forEach(function (p) {
      if (!self.types[p.type]) return;
      p.re.lastIndex = 0; var m;
      while ((m = p.re.exec(text))) {
        if (m[0].length === 0) { p.re.lastIndex++; continue; }
        if (p.check && !p.check(m[0], text, m.index)) continue;
        if (p.group) {                       // скрываем только значение, а не «userId=»
          var g = m[p.group]; if (!g) continue;
          var gs = m.index + m[0].length - g.length;
          found.push({ s: gs, e: gs + g.length, type: p.type, value: g, rank: p.rank });
          continue;
        }
        found.push({ s: m.index, e: m.index + m[0].length, type: p.type, value: m[0].trim(), rank: p.rank });
      }
    });
    if (this.types['СВОЁ'] || this.extra.length) {
      this.extra.forEach(function (r) {
        r.re.lastIndex = 0; var m;
        while ((m = r.re.exec(text))) {
          if (!m[0]) { r.re.lastIndex++; continue; }
          found.push({ s: m.index, e: m.index + m[0].length, type: r.type, value: m[0], prio: 1 });
        }
      });
    }
    if (this.types['ФИО']) {
      this.findPeople(text, found); findLatinPeople(text, found);
      if (this._aiRe) {
        this._aiRe.lastIndex = 0; var am;
        while ((am = this._aiRe.exec(text))) {
          var ws = am[0].split(/\s+/).map(titleCase);
          found.push({ s: am.index, e: am.index + am[0].length, type: 'ФИО', value: am[0], ai: true,
                       person: parsePerson(ws, ws.map(function (w) { return classify(w) || 'C'; })) });
        }
      }
    }
    if (this.loginRoots && this.types['НИК']) {
      if (!this._rootsRe) this._rootsRe = new RegExp(Object.keys(this.loginRoots).join('|'));
      var LOGIN = /(?<![\w@.-])[a-z][a-z0-9]*(?:[._-][a-z0-9]+)+(?![\w@-]|\.\w)|(?<![\w@.-])[a-z]+\d+(?![\w@-])/g, mm;
      while ((mm = LOGIN.exec(text))) {
        if (this._rootsRe.test(mm[0])) found.push({ s: mm.index, e: mm.index + mm[0].length, type: 'НИК', value: mm[0] });
      }
    }
    var lre = this.learned && this.learnedRe();
    if (lre) {
      lre.lastIndex = 0; var lm;
      while ((lm = lre.exec(text))) {
        var lt = this.learned[lm[0]] || 'НИК';
        if (this.types[lt]) found.push({ s: lm.index, e: lm.index + lm[0].length, type: lt, value: lm[0], prio: 1 });
      }
    }
    return this.finish(found);
  };

  var PRIORITY = { 'СВОЁ': 0, 'ТОКЕН': 0, 'ПОЧТА': 1, 'ХОСТ': 1.5, 'РЕКВИЗИТЫ': 2.5, 'ДОГОВОР': 2.5, 'ДЕНЬГИ': 3,
    'ОРГАНИЗАЦИЯ': 4.5, 'МЕТОД': 5.5, 'ВЫУЧЕНО': 6.5, 'АДРЕС': 2, 'КАРТА': 3, 'СЧЁТ': 3, 'ПАСПОРТ': 3, 'ПОЛИС': 3, 'СНИЛС': 3,
    'ИНН': 4, 'ТЕЛЕФОН': 4, 'ДАТА_РОЖДЕНИЯ': 5, 'ШКОЛА': 5, 'ГОСНОМЕР': 6, 'НИК': 6, 'IP': 6, 'ID': 6, 'ФИО': 7 };

  Session.prototype.finish = function (found) {
    var self = this;
    found.forEach(function (f) { f.key = normKey(f.type, f.value, f.person); });
    found = found.filter(function (f) { return !self.skip[f.key] && !self.skip['*' + f.value.toLowerCase()]; });
    // Перекрытия: свои правила и более «надёжные» типы важнее, при равенстве — длиннее.
    found.sort(function (a, b) {
      var ra = a.rank != null ? a.rank : PRIORITY[a.type], rb = b.rank != null ? b.rank : PRIORITY[b.type];
      return (ra - rb) || ((b.e - b.s) - (a.e - a.s)) || (a.s - b.s);
    });
    // Если одна находка целиком внутри другой (пароль внутри URL) — оставляем внешнюю.
    if (found.length > 1) {
      found = found.filter(function (f) {
        for (var i = 0; i < found.length; i++) {
          var g = found[i];
          if (g !== f && g.s <= f.s && g.e >= f.e && (g.e - g.s) > (f.e - f.s) && g.type !== 'ФИО' && !(f.rank != null && f.rank < 3.6)) return false;
        }
        return true;
      });
    }
    var taken = [], out = [];
    found.forEach(function (f) {
      for (var i = 0; i < taken.length; i++) if (f.s < taken[i].e && taken[i].s < f.e) return;
      taken.push(f); out.push(f);
    });
    out.sort(function (a, b) { return a.s - b.s; });
    return out;
  };

  // Запомнить упоминание человека (первый проход), чтобы потом склеить «Анна» с «Анной Петровой».
  // Выученное из этого файла: логины, названия организаций, секреты. Однажды найденное
  // по контексту скрывается и там, где контекста нет (вторая строка лога, сноска, таблица).
  var LEARN_TYPES = { 'НИК': 1, 'ОРГАНИЗАЦИЯ': 1, 'ТОКЕН': 1, 'ХОСТ': 1 };
  Session.prototype.learn = function (value, type) {
    value = String(value || '').trim();
    if (type === 'ОРГАНИЗАЦИЯ') {
      var inner = /[«"„]([^»"“]+)[»"“]/.exec(value);
      if (inner) value = inner[1].trim();
    }
    if (value.length < 4 || !/[A-Za-zА-Яа-яЁё]/.test(value) || this.allow[value.toLowerCase()]) return;
    this.learned = this.learned || Object.create(null);
    if (!this.learned[value]) { this.learned[value] = type; this._learnedRe = null; }
  };
  Session.prototype.learnedRe = function () {
    if (this._learnedRe !== null && this._learnedRe !== undefined) return this._learnedRe;
    var vals = Object.keys(this.learned || {}).sort(function (a, b) { return b.length - a.length; });
    this._learnedRe = vals.length ? new RegExp('(?<![\\wА-Яа-яЁё.@-])(?:' + vals.map(function (v) {
      return v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }).join('|') + ')(?![\\wА-Яа-яЁё@-])', 'g') : false;
    return this._learnedRe;
  };

  // Тексты для умной проверки: уникальные, с русскими словами, не больше ~3 МБ.
  Session.prototype.collect = function (text) {
    if (!this.segs) { this.segs = []; this.segSet = Object.create(null); this.segLen = 0; }
    if (!text || text.length < 5 || this.segLen > 3e6 || !/[А-ЯЁ][а-яё]/.test(text) || this.segSet[text]) return;
    this.segSet[text] = 1; this.segs.push(text); this.segLen += text.length;
  };

  // Люди, найденные нейросетью. Ищем их как обычных людей — с разбором на фамилию, имя,
  // отчество, чтобы «Петренко А. Н.» и «Андрей Николаевич Петренко» получили одну метку.
  Session.prototype.addPeople = function (values) {
    var uniq = Object.create(null);
    (values || []).forEach(function (v) { v = String(v).trim(); if (v.length >= 3) uniq[v] = true; });
    var list = Object.keys(uniq).sort(function (a, b) { return b.length - a.length; });
    this.aiPeople = list;
    this._aiRe = list.length ? new RegExp('(?<![А-Яа-яЁёA-Za-z])(?:' + list.map(function (v) {
      return v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
    }).join('|') + ')(?![А-Яа-яЁёA-Za-z])', 'g') : null;
  };

  Session.prototype.reserveId = function (value) {
    if (value != null && value !== '') this.idOriginals[String(value).trim()] = true;
  };

  Session.prototype.notePerson = function (f) {
    if (f.type === 'ID') this.reserveId(f.value);
    if (f.type === 'ФИО' && f.person && f.person.s) {
      var root = translit(f.person.s).replace(/[^a-z]/g, '');
      if (root.length >= 5) { (this.loginRoots = this.loginRoots || Object.create(null))[root] = true; this._rootsRe = null; }
    }
    if (LEARN_TYPES[f.type]) this.learn(f.value, f.type);
    if (!f.person) return;
    var k = personKey(f.person);
    if (this._seen && this._seen[k]) return;
    (this._seen = this._seen || Object.create(null))[k] = true;
    this.people.push(f.person);
    if (f.person.s && (f.person.n || f.person.p || f.person.i.length)) (this.knownSurnames = this.knownSurnames || Object.create(null))[f.person.s] = true;
  };

  // После первого прохода: короткие упоминания → полные, если подходит ровно одно.
  Session.prototype.linkPeople = function () {
    var ps = this.people, alias = this.personAlias;
    ps.forEach(function (a) {
      var cands = ps.filter(function (b) { return b !== a && compatible(a, b); });
      if (!cands.length) return;
      var top = Math.max.apply(null, cands.map(richness));
      var best = cands.filter(function (b) { return richness(b) === top; });
      var uniq = {}; best.forEach(function (b) { uniq[personKey(b)] = true; });
      if (Object.keys(uniq).length === 1) alias[personKey(a)] = personKey(best[0]);
    });
    // Цепочки: «А.» → «Анна Петрова» → «Анна Сергеевна Петрова»
    Object.keys(alias).forEach(function (k) {
      var seen = {}, t = alias[k];
      while (alias[t] && !seen[t]) { seen[t] = true; t = alias[t]; }
      alias[k] = t;
    });
  };

  // Метка для находки: одна и та же для одного значения/человека.
  Session.prototype.tokenFor = function (f) {
    var key = f.key;
    if (f.type === 'ФИО' && f.person) {
      var pk = personKey(f.person);
      if (this.personAlias[pk]) key = 'ФИО:' + this.personAlias[pk];
    }
    var idx = this.key.index, tok = idx[key];
    (this.used = this.used || Object.create(null));
    if (!tok && f.type === 'ID' && this.idMode === 'pseudo') {
      tok = this.pseudoId(f.value);
      idx[key] = tok;
      this.key.tokens[tok] = { type: 'ID', value: f.value, pseudo: true };
      this.key.counters.ID = (this.key.counters.ID || 0) + 1;
    }
    if (!tok) {
      var n = (this.key.counters[f.type] || 0) + 1;
      this.key.counters[f.type] = n;
      tok = '[' + f.type + '-' + n + ']';
      idx[key] = tok;
      this.key.tokens[tok] = { type: f.type, value: f.value };
    } else if (f.type === 'ФИО' && this.key.tokens[tok] && f.value.length > this.key.tokens[tok].value.length && f.whole !== false) {
      // Для возврата данных храним самое полное написание.
      this.key.tokens[tok].value = f.value;
    }
    this.used[tok] = key;
    return tok;
  };

  // ───────────────────────── Новые ID ─────────────────────────
  // ID заменяется на другой ID того же вида: число — числом, UUID — UUID, «AB-1234» — «KX-8302».
  // Каждый новый ID проверяется на уникальность: не совпадает ни с выданными раньше, ни с настоящими ID.

  function rnd(n) {
    if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
      var a = new Uint32Array(1); crypto.getRandomValues(a); return a[0] % n;
    }
    return Math.floor(Math.random() * n);
  }
  var LAT = 'abcdefghijklmnopqrstuvwxyz', CYR = 'абвгдежзиклмнопрстуфхцчшэюя', HEX = '0123456789abcdef';
  function pick(s) { return s[rnd(s.length)]; }

  function shapeLike(v, extra) {
    var s = String(v).trim(), out = '', i;
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)) {
      for (i = 0; i < 36; i++) out += [8, 13, 18, 23].indexOf(i) >= 0 ? '-' : i === 14 ? '4' : i === 19 ? pick('89ab') : pick(HEX);
      return s === s.toUpperCase() ? out.toUpperCase() : out;
    }
    if (/^\d+$/.test(s)) {
      var len = Math.max(s.length, 6) + extra;
      out = s.length > 1 && s[0] === '0' ? '0' : String(1 + rnd(9));
      for (i = 1; i < len; i++) out += rnd(10);
      return out;
    }
    var randomized = 0;
    for (i = 0; i < s.length; i++) {
      var c = s[i];
      if (/\d/.test(c)) { out += rnd(10); randomized++; }
      else if (/[a-z]/.test(c)) { out += pick(LAT); randomized++; }
      else if (/[A-Z]/.test(c)) { out += pick(LAT).toUpperCase(); randomized++; }
      else if (/[а-яё]/.test(c)) { out += pick(CYR); randomized++; }
      else if (/[А-ЯЁ]/.test(c)) { out += pick(CYR).toUpperCase(); randomized++; }
      else out += c;
    }
    for (i = randomized; i < 6 + extra; i++) out += rnd(10);
    return out;
  }

  Session.prototype.pseudoId = function (value) {
    var used = this.key.tokens, orig = this.idOriginals;
    for (var attempt = 0; attempt < 200; attempt++) {
      var p = shapeLike(value, attempt < 50 ? 0 : 1 + (attempt >> 6));
      if (!used[p] && !orig[p] && p !== String(value).trim()) return p;
    }
    throw new Error('Не удалось подобрать уникальный ID для «' + value + '»');
  };

  // Замаскировать строку целиком (для простых случаев и тестов).
  Session.prototype.maskText = function (text, hint) {
    var fs = this.detect(text, hint), out = '', pos = 0, self = this;
    fs.forEach(function (f) { out += text.slice(pos, f.s) + self.tokenFor(f); pos = f.e; });
    return out + text.slice(pos);
  };

  // Ключ для сохранения: только то, что нужно для возврата данных и продолжения нумерации.
  // onlyUsed — только метки, которые встретились в этом файле (для слияния с общим ключом).
  Session.prototype.exportKey = function (meta, onlyUsed) {
    var k = this.key, tokens = k.tokens, index = k.index;
    if (onlyUsed) {
      tokens = {}; index = {};
      var used = this.used || {};
      for (var tok in used) { tokens[tok] = k.tokens[tok]; }
      for (var key in k.index) if (used[k.index[key]]) index[key] = k.index[key];
    }
    return { format: 'obezlichivatel-key', version: 1, created: new Date().toISOString(), meta: meta || {},
      counters: k.counters, tokens: tokens, index: index };
  };

  // ───────────────────────── Возврат данных ─────────────────────────

  var TOKEN_RE = /\[(ФИО|ТЕЛЕФОН|ПОЧТА|СНИЛС|ИНН|ПАСПОРТ|ПОЛИС|КАРТА|СЧЁТ|ДАТА_РОЖДЕНИЯ|АДРЕС|ШКОЛА|ГОСНОМЕР|НИК|IP|ID|ТОКЕН|ДЕНЬГИ|РЕКВИЗИТЫ|ДОГОВОР|ОРГАНИЗАЦИЯ|ХОСТ|МЕТОД|СВОЁ)-(\d+)\]/g;

  var WORD_RE_ID = /[0-9A-Za-zА-Яа-яЁё][0-9A-Za-zА-Яа-яЁё_.-]*[0-9A-Za-zА-Яа-яЁё]|[0-9A-Za-zА-Яа-яЁё]/g;

  // Все подстановки в тексте: метки [ТИП-n] и новые ID (точное совпадение слова).
  function findRestorable(text, key) {
    var out = [], m, tokens = key.tokens || {};
    var re = new RegExp(TOKEN_RE.source, 'g');
    while ((m = re.exec(text))) out.push({ s: m.index, e: m.index + m[0].length, token: m[0], value: tokens[m[0]] ? tokens[m[0]].value : null });
    if (key._hasPseudo === undefined) {
      key._hasPseudo = false;
      for (var k in tokens) if (tokens[k].pseudo) { key._hasPseudo = true; break; }
    }
    if (key._hasPseudo) {
      WORD_RE_ID.lastIndex = 0;
      while ((m = WORD_RE_ID.exec(text))) {
        var t = tokens[m[0]];
        if (t && t.pseudo) out.push({ s: m.index, e: m.index + m[0].length, token: m[0], value: t.value });
      }
      out.sort(function (a, b) { return a.s - b.s; });
    }
    return out;
  }

  function unmaskText(text, key) {
    var n = 0, out = '', pos = 0;
    findRestorable(text, key).forEach(function (f) {
      if (f.s < pos) return;
      out += text.slice(pos, f.s) + (f.value != null ? (n++, f.value) : f.token); pos = f.e;
    });
    return { text: out + text.slice(pos), count: n };
  }

  // ───────────────────────── Столбцы таблиц ─────────────────────────

  var HEADER_RULES = [
    ['ДЕНЬГИ', /сумм[аы]|стоимост|^цена|цена,|бюджет|оплат[аы]|аванс|штраф|выручк|^доход|^расход|прибыл|затрат|себестоим|оклад|зарплат|выплат|руб\.?\)?$|, ?руб|₽|\(руб|тыс\.? ?руб|млн\.? ?руб/i],
    ['ПОЧТА', /e-?mail|эл\.?\s*почт|электронн\S*\s*(?:почт|адрес)|почта|адрес эл/i],
    ['ДАТА_РОЖДЕНИЯ', /дата\s*рожд|д\.\s?р\.|день\s*рожд|г\.\s?р\.|год\s*рожд/i],
    ['ТЕЛЕФОН', /телефон|тел\.|мобильн|сот\.|whatsapp|номер\s*тел/i],
    ['СНИЛС', /снилс/i],
    ['ИНН', /^инн\b|\bинн\b/i],
    ['ПАСПОРТ', /паспорт|серия\s*(?:и\s*)?номер|документ.*удостовер/i],
    ['ПОЛИС', /полис|омс/i],
    ['КАРТА', /номер\s*карты|банковск\S*\s*карт/i],
    ['СЧЁТ', /расч[её]тн\S*\s*сч|лицев\S*\s*сч|номер\s*сч[её]та|^сч[её]т$/i],
    ['АДРЕС', /адрес|место\s*жительства|прописк|регистрац\S*\s*по\s*мест/i],
    ['НИК', /логин|login|username|никнейм|\bник\b|telegram|телеграм|учётн\S* запис|учетн\S* запис/i],
    ['ТОКЕН', /пароль|password|token|токен|secret|api.?key/i],
    ['ID', /(?:^|[\s_.\-(])(?:id|ид|uid|uuid|guid|oid)(?:$|[\s_.\-)])|[a-z](?:Id|ID|Uuid|Guid)$|идентификатор|^код$|код\s*(?:ученик|учащ|обучающ|учител|сотрудник|пользовател|оо\b|школ|организац|ребён|ребен|родител|заявител)|номер\s*(?:ученик|учащ|обучающ|личного\s*дела|заявки|заявления|обращения|договора|пользовател)|esia|есиа/i],
    ['ФИО', /ф\.?\s?и\.?\s?о|фамилия|^имя\b|\bимя$|отчество|^ученик|^учитель|^родитель|законн\S*\s*представ|заявитель|получатель|исполнитель|ответственн|сотрудник|^педагог|^автор|^контактн\S*\s*лицо|^кто\b|^кл\.?\s*рук|классн\S*\s*руковод|^директор|^завуч/i],
    ['ШКОЛА', /^(?:оо|образовательн\S*\s*организац|школа|наименование\s*оо|учреждение)$/i]
  ];
  var HEADER_EXCLUDE = /имя\s*файл|название|наименование\s*(?:услуг|сервис|продукт|предмет)|количеств|кол-во|число|дата\s*(?!рожд)|статус|тип|^id$|итого|сумма|доля|%|предмет|класс$/i;

  function classifyHeader(h) {
    if (!h) return null;
    h = String(h).trim();
    if (h.length > 80) return null;
    for (var i = 0; i < HEADER_RULES.length; i++) {
      if (HEADER_RULES[i][1].test(h)) {
        if (HEADER_RULES[i][0] === 'ФИО' && HEADER_EXCLUDE.test(h) && !/фио|фамилия|отчество/i.test(h)) continue;
        if (HEADER_RULES[i][0] === 'АДРЕС' && /почт|e-?mail|ip|сайт|url|ссылк/i.test(h)) continue;
        return HEADER_RULES[i][0];
      }
    }
    return null;
  }

  // Классификация столбца по образцам значений: если большинство значений — один тип.
  Session.prototype.classifyValues = function (values) {
    var counts = {}, n = 0, self = this;
    values.forEach(function (v) {
      v = String(v || '').trim(); if (!v || v.length > 200) return; n++;
      var fs = self.detect(v);
      if (fs.length === 1 && fs[0].e - fs[0].s >= v.length * 0.8) counts[fs[0].type] = (counts[fs[0].type] || 0) + 1;
    });
    var best = null, top = 0;
    for (var t in counts) if (counts[t] > top) { top = counts[t]; best = t; }
    return n >= 3 && top >= n * 0.6 ? best : null;
  };

  // Таблицы с деньгами: подпись «…, тыс. руб.», в ячейках голые числа «21 400,0», «−15 050,0».
  var MONEY_UNIT = /(?:тыс\.?|млн\.?|млрд\.?)?\s*(?:руб(?:\.|л[а-я]*|\b)|₽|RUB|USD|EUR|долл)/i;
  var NUM_CELL = /^[−–-]?\s?\d{1,3}(?:[\s\u00a0\u202f]\d{3})*(?:[.,]\d+)?$|^[−–-]?\s?\d{4,}(?:[.,]\d+)?$/;
  function MoneyContext() { this.on = false; this.left = 0; }
  MoneyContext.prototype.cell = function (text) {
    var t = String(text || '').trim();
    if (!t) return false;
    if (NUM_CELL.test(t)) {
      if (!this.on) return false;
      this.left = 60;
      var whole = t.replace(/^[−–-]\s?/, '').split(/[.,]/)[0];
      return /\s/.test(whole) || whole.length >= 3;          // «0,12», «1,1200», номера периодов — не деньги
    }
    if (t.length < 250 && MONEY_UNIT.test(t)) { this.on = true; this.left = 60; return false; }
    if (t.length > 300 || --this.left <= 0) this.on = false;
    return false;
  };

  return {
    MoneyContext: MoneyContext,
    uiNameAt: function (text, s, value) { return !/\s/.test(value.trim()) && UI_NOUN_BEFORE.test(ctx(text, s, 30)); },
    TYPES: TYPES, Session: Session, unmaskText: unmaskText, TOKEN_RE: TOKEN_RE,
    classifyHeader: classifyHeader, classify: classify, findRestorable: findRestorable, shapeLike: shapeLike, snilsOk: snilsOk, innOk: innOk, luhnOk: luhnOk
  };
})();

if (typeof module !== 'undefined') module.exports = Engine;
