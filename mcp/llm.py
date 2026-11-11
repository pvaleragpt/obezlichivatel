"""
Обезличиватель — глубокая проверка локальной моделью (Ollama). Без интернета: модель работает на этом Mac.

Подключение (по кнопке на странице):
  1. Ollama: уже стоит — берём; нет — ставим из Ollama.dmg из комплекта Славатора, нет комплекта — качаем с ollama.com.
  2. Модель: уже есть qwen3 — берём; нет — переносим qwen3:8b из комплекта Славатора (5 ГБ, без скачивания),
     нет комплекта — `ollama pull qwen3:4b` (2,6 ГБ).

Проверка: модель получает текст, где правила уже заменили найденное на [ТИП], и возвращает то, что
пропущено. Каждое найденное значение проверяется: оно обязано дословно встречаться в тексте.
"""
import json
import re
import os
import shutil
import subprocess
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

API = os.environ.get('OBEZL_OLLAMA_URL') or 'http://127.0.0.1:11434'   # другой адрес — только для тестов
PREFERRED = ['qwen3:8b', 'qwen3:4b', 'qwen2.5:7b', 'qwen2.5:7b-instruct', 'qwen3:14b', 'llama3.1:8b']
HOME = Path.home()
VIBE = HOME / 'Desktop' / 'Вайбкодинг'
DMG_CANDIDATES = [os.environ.get('OBEZL_OLLAMA_DMG'),
                  VIBE / 'транскрибатор' / 'packaging' / 'payload' / 'Ollama.dmg',
                  VIBE / 'словатор кодекс' / 'packaging' / 'payload' / 'Ollama.dmg',
                  HOME / 'Downloads' / 'Ollama.dmg']
MODEL_DIRS = [os.environ.get('OBEZL_OLLAMA_MODELS'),
              VIBE / 'транскрибатор' / 'transfer' / 'Meeting_Transcriber_FULL_TRANSFER_20260828_192521' / 'ollama' / 'models',
              VIBE / 'словатор кодекс' / 'transfer' / 'Meeting_Transcriber_FULL_TRANSFER_20260828_192521' / 'ollama' / 'models']
for vol in Path('/Volumes').glob('*/ресурсы/ollama-models'):
    MODEL_DIRS.append(vol)

TYPES = ['ФИО', 'ТЕЛЕФОН', 'ПОЧТА', 'АДРЕС', 'ДАТА_РОЖДЕНИЯ', 'ПАСПОРТ', 'СНИЛС', 'ИНН', 'КАРТА', 'СЧЁТ', 'ДЕНЬГИ',
         'ОРГАНИЗАЦИЯ', 'НИК', 'ТОКЕН', 'ХОСТ', 'IP', 'ID', 'ДОГОВОР']
PROMPT = """Ты обезличиваешь рабочие документы и логи перед отправкой во внешнюю нейросеть. Правила уже заменили часть данных на метки [ФИО], [ТЕЛЕФОН] и т. п. — их пропускай.
Найди ВСЁ, что ещё осталось открытым. Лучше найти лишнее, чем пропустить.
Ищи:
- ФИО — фамилии, имена, отчества, уменьшительные и разговорные формы (Петя, Колян, Марьванна), в любом падеже, латиницей тоже;
- ДЕНЬГИ — любые суммы и цены: цифрами («180 тыс.») и словами («двенадцать миллионов рублей», «полтора миллиона»);
- ОРГАНИЗАЦИЯ — компании, подрядчики, клиенты, в том числе без «ООО» и в кавычках («Ромашка-Софт», Альфа-Трейдинг);
- ТЕЛЕФОН (и прописью), ПОЧТА, АДРЕС (улица и дом, даже словами), ДАТА_РОЖДЕНИЯ, ПАСПОРТ, СНИЛС, ИНН, КАРТА, СЧЁТ, ДОГОВОР;
- НИК — логины; ТОКЕН — пароли, ключи, токены; ХОСТ — серверы, домены, URL; IP; ID — номера клиентов, заказов, учётных записей.
Не ищи: термины с фамилиями («диаграмма Ганта», «закон Парето»), должности, названия разделов интерфейса и модулей, министерства, Госуслуги, даты событий, проценты, номера кабинетов и пунктов, количества, версии, отделы («из бухгалтерии»),
в логах — метки времени, уровни (INFO, ERROR), имена потоков (worker-1, main), коды ответа.
"text" — точная подстрока из текста, без изменений. Ответ — JSON {"items": [{"text": "...", "type": "..."}]}."""
EXAMPLES = [
    ('Встречу вела [ФИО], смету на три миллиона согласовал Вова из «Техно-Сервиса», доступ к стенду dev-app-01 — логин qa_admin.',
     '{"items": [{"text": "три миллиона", "type": "ДЕНЬГИ"}, {"text": "Вова", "type": "ФИО"}, {"text": "Техно-Сервиса", "type": "ОРГАНИЗАЦИЯ"}, '
     '{"text": "dev-app-01", "type": "ХОСТ"}, {"text": "qa_admin", "type": "НИК"}]}'),
    ('Раздел «Оценки» по методу Монте-Карло проверен, кабинет 305, обновлено 40% записей.', '{"items": []}'),
    ('2026-10-20 10:01:01 INFO [worker-1] заявка [ID] обработана, ответственный [ФИО] из бухгалтерии, оплата полмиллиона, контакт Серёга, сессия a81f3c9e.',
     '{"items": [{"text": "полмиллиона", "type": "ДЕНЬГИ"}, {"text": "Серёга", "type": "ФИО"}, {"text": "a81f3c9e", "type": "ТОКЕН"}]}'),
]
# Ответ модели — короткий список. Предел длины не даёт ей зациклиться, предел времени — повиснуть.
MAX_ANSWER_TOKENS = 700
CHUNK_TIMEOUT = 120
CONTEXT = 4096                 # подсказка ~1 100 токенов + кусок текста ~500 + ответ; меньше контекст — меньше памяти

SCHEMA = {'type': 'object', 'properties': {'items': {'type': 'array', 'items': {'type': 'object', 'properties': {
    'text': {'type': 'string'}, 'type': {'type': 'string', 'enum': TYPES}}, 'required': ['text', 'type']}}}, 'required': ['items']}


def _get(path, timeout=3):
    with urllib.request.urlopen(API + path, timeout=timeout) as r:
        return json.loads(r.read().decode('utf-8'))


def _post(path, body, timeout=300):
    req = urllib.request.Request(API + path, data=json.dumps(body).encode('utf-8'), headers={'Content-Type': 'application/json'})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode('utf-8'))


WINDOWS = os.name == 'nt'


def find_binary():
    if os.environ.get('OBEZL_OLLAMA_BIN') == 'none':     # для тестов: «на компьютере нет Ollama»
        return None
    cands = ['/Applications/Ollama.app/Contents/Resources/ollama', str(HOME / 'Applications/Ollama.app/Contents/Resources/ollama'),
             '/opt/homebrew/bin/ollama', '/usr/local/bin/ollama']
    if WINDOWS:
        cands = [str(Path(os.environ.get('LOCALAPPDATA') or HOME / 'AppData' / 'Local') / 'Programs' / 'Ollama' / 'ollama.exe'),
                 str(Path(os.environ.get('ProgramFiles') or 'C:/Program Files') / 'Ollama' / 'ollama.exe')]
    for c in cands:
        if os.path.isfile(c) and (WINDOWS or os.access(c, os.X_OK)):
            return c
    return shutil.which('ollama')


def running():
    try:
        _get('/api/version', 2)
        return True
    except Exception:  # noqa: BLE001
        return False


def models():
    try:
        return [m['name'] for m in _get('/api/tags', 4).get('models', [])]
    except Exception:  # noqa: BLE001
        return []


def pick_model(names=None):
    names = names if names is not None else models()
    for p in PREFERRED:
        if p in names:
            return p
    for n in names:
        if n.startswith('qwen'):
            return n
    # Другая уже скачанная модель тоже подойдёт (кроме моделей для эмбеддингов — они не отвечают текстом).
    for n in names:
        if 'embed' not in n and 'bge' not in n and 'minilm' not in n:
            return n
    return None


class Setup:
    """Подключение в фоне: страница опрашивает состояние."""

    def __init__(self):
        self.lock = threading.Lock()
        self.state = {'state': 'idle', 'message': '', 'progress': 0}

    def status(self):
        names = models() if running() else []
        return {'installed': bool(find_binary()), 'running': running(), 'model': pick_model(names), 'models': names, 'setup': dict(self.state)}

    def _say(self, state, message, progress=None):
        self.state = {'state': state, 'message': message, 'progress': self.state.get('progress', 0) if progress is None else progress}

    def start(self, serve_only=False):
        with self.lock:
            if self.state['state'] == 'working':
                return
            self._say('working', 'Запускаю модель' if serve_only else 'Начинаю', 0)
            threading.Thread(target=self._run, args=(serve_only,), daemon=True).start()

    def _run(self, serve_only=False):
        try:
            if serve_only:                 # после перезагрузки: Ollama есть, но не запущена — только запускаем
                self._serve()
                self._say('done', 'Модель запущена', 100)
                return
            self._install()
            self._serve()
            self._model()
            self._say('done', 'Локальная модель подключена', 100)
        except Exception as e:  # noqa: BLE001
            self._say('error', str(e))

    def _install(self):
        if find_binary():
            return
        if WINDOWS:
            return self._install_windows()
        dmg = next((Path(c) for c in DMG_CANDIDATES if c and Path(c).exists()), None)
        tmp = None
        if dmg is None:
            self._say('working', 'Скачиваю Ollama с ollama.com (около 200 МБ)', 5)
            tmp = Path('/tmp') / 'obezl-Ollama.dmg'
            urllib.request.urlretrieve('https://ollama.com/download/Ollama.dmg', tmp)
            dmg = tmp
        self._say('working', 'Устанавливаю Ollama', 10)
        out = subprocess.run(['hdiutil', 'attach', '-nobrowse', '-quiet', str(dmg)], capture_output=True, text=True, timeout=120)
        mount = None
        for line in (out.stdout or '').splitlines()[::-1]:
            part = line.split('\t')[-1].strip()
            if part.startswith('/Volumes/'):
                mount = part
                break
        if not mount:
            vols = sorted(Path('/Volumes').glob('Ollama*'))
            mount = str(vols[-1]) if vols else None
        if not mount or not (Path(mount) / 'Ollama.app').exists():
            raise RuntimeError('Не удалось открыть установщик Ollama')
        target = Path('/Applications') if os.access('/Applications', os.W_OK) else HOME / 'Applications'
        target.mkdir(exist_ok=True)
        subprocess.run(['cp', '-R', str(Path(mount) / 'Ollama.app'), str(target) + '/'], check=True, timeout=300)
        subprocess.run(['xattr', '-cr', str(target / 'Ollama.app')], timeout=60)
        subprocess.run(['hdiutil', 'detach', mount, '-quiet'], timeout=60)
        if tmp:
            tmp.unlink(missing_ok=True)

    def _install_windows(self):
        import tempfile
        exe = Path(os.environ.get('OBEZL_OLLAMA_EXE') or '')
        if not exe.is_file():
            exe = HOME / 'Downloads' / 'OllamaSetup.exe'
        if not exe.is_file():
            self._say('working', 'Скачиваю Ollama с ollama.com (около 1 ГБ)', 5)
            exe = Path(tempfile.gettempdir()) / 'obezl-OllamaSetup.exe'
            urllib.request.urlretrieve('https://ollama.com/download/OllamaSetup.exe', exe)
        self._say('working', 'Устанавливаю Ollama', 12)
        subprocess.run([str(exe), '/VERYSILENT', '/NORESTART', '/SUPPRESSMSGBOXES'], timeout=900)
        for _ in range(30):
            if find_binary():
                return
            time.sleep(1)
        raise RuntimeError('Ollama не установилась. Установите её вручную с ollama.com и нажмите «Подключить» ещё раз.')

    def _serve(self):
        if running():
            return
        self._say('working', 'Запускаю Ollama', 20)
        binary = find_binary()
        if not binary:
            raise RuntimeError('Ollama не установилась')
        app = Path(binary).parents[2] if '/Ollama.app/' in binary else None
        if app:
            subprocess.Popen(['open', '-ga', str(app)])
        elif WINDOWS:
            subprocess.Popen([binary, 'serve'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                             creationflags=0x08000000 | 0x00000200)   # без окна консоли, отдельно от сервера
        else:
            subprocess.Popen([binary, 'serve'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
        for _ in range(40):
            if running():
                return
            time.sleep(1)
        raise RuntimeError('Ollama не запустилась')

    def _model(self):
        if pick_model():
            return
        src = next((Path(c) for c in MODEL_DIRS if c and (Path(c) / 'manifests').exists()), None)
        dest = HOME / '.ollama' / 'models'
        if src:
            files = [p for p in src.rglob('*') if p.is_file()]
            total = sum(p.stat().st_size for p in files) or 1
            done = 0
            for p in files:
                out = dest / p.relative_to(src)
                out.parent.mkdir(parents=True, exist_ok=True)
                if not out.exists() or out.stat().st_size != p.stat().st_size:
                    shutil.copyfile(p, out)
                done += p.stat().st_size
                self._say('working', 'Переношу модель из комплекта Славатора (%d из %d МБ)' % (done >> 20, total >> 20), 25 + int(70 * done / total))
            for _ in range(20):
                if pick_model():
                    return
                time.sleep(1)
        self._say('working', 'Скачиваю модель qwen3:4b (около 2,6 ГБ)', 30)
        proc = subprocess.Popen([find_binary(), 'pull', 'qwen3:4b'], stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
                                encoding='utf-8', errors='replace', **({'creationflags': 0x08000000} if WINDOWS else {}))
        for line in proc.stdout:
            if '%' in line:
                self._say('working', 'Скачиваю модель qwen3:4b: ' + line.strip()[-40:], None)
        if proc.wait() != 0 or not pick_model():
            raise RuntimeError('Модель не скачалась')


SETUP = Setup()


# Названия частей системы, а не данные: «модуль «Корзина»», «раздел Расписание», «кнопка Отправить».
UI_BEFORE = re.compile(r'(?:модул[ьяюе]|раздел[ауе]?|вкладк[аиуе]|кнопк[аиуе]|экран[ауе]?|форм[аыуе]|пол[ея]|меню|страниц[аыуе]|'
                       r'сервис[ауе]?|подсистем[аыуе]|блок[ауе]?|виджет[ауе]?|справочник[ауе]?|статус[ауе]?|этап[ауе]?|пункт[ауе]?)'
                       r'\s*[«"„]?\s*$', re.I)
# Логины, токены, хосты, адреса и номера без латиницы и цифр — это обычные русские слова.
TECH = {'НИК', 'ТОКЕН', 'ХОСТ', 'IP', 'ID', 'ПОЧТА', 'МЕТОД', 'КАРТА', 'СЧЁТ', 'СНИЛС', 'ИНН', 'ПАСПОРТ', 'ПОЛИС', 'ГОСНОМЕР'}


BIRTH = re.compile(r'рожд|г\.\s?р|д\.\s?р|birth|dob|возраст', re.I)
STAMP = re.compile(r'^\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}.*)?$|^\d{1,2}:\d{2}(?::\d{2})?(?:[.,]\d+)?$')
THREAD = re.compile(r'^(?:worker|thread|pool|main|exec|scheduler|http-nio|task|kafka|grpc)[\w-]*?-?\d{0,3}$', re.I)


NUM_WORD = re.compile(r'(?:один|одна|два|две|три|четыр|пят|шест|сем|восем|девят|десят|сорок|сто|двести|триста|ста\b|сот|тысяч|миллион|миллиард|полтор|пол(?:миллиона|тысячи|ляма)|лям|косар|ноль|нул)', re.I)
MIN_DIGITS = {'КАРТА': 13, 'СЧЁТ': 10, 'СНИЛС': 11, 'ИНН': 10, 'ПАСПОРТ': 6, 'ПОЛИС': 9}
UNIT_AFTER = re.compile(r'\s?(?:ms|мс|s\b|сек|с\b|мин|kb|mb|gb|кб|мб|гб|%|px|шт|rps|rpm|ед)', re.I)
MONEY_NEAR = re.compile(r'руб|₽|\$|usd|eur|€|сумм|цен|стоим|оплат|бюджет|тыс|млн|млрд|зарплат|оклад|преми|amount|price|sum|cost|total', re.I)


def trim(v, t):
    """«заявка 10000» → «10000», «договор № 15/2» → «15/2»: слово перед номером — не данные."""
    if t in TECH or t == 'ДОГОВОР':
        m = re.match(r'^(?:[а-яёА-ЯЁ]+\.?\s+(?:№\s*)?)+(?=\S*[\dA-Za-z])', v)
        if m:
            v = v[m.end():]
    return v


def plausible(v, t, text):
    if re.search(r'\[[А-ЯЁA-Z_]+(?:-\d+)?\]', v):          # в ответе уже скрытое — «ответственный [ФИО]»
        return False
    if STAMP.match(v) and t != 'ДАТА_РОЖДЕНИЯ':                # метки времени в логах
        return False
    if t == 'ДАТА_РОЖДЕНИЯ':
        if re.search(r'\d{1,2}:\d{2}', v):
            return False
        starts = [m.start() for m in re.finditer(re.escape(v), text)]
        if not any(BIRTH.search(text[max(0, i - 40):i + len(v) + 15]) for i in starts):
            return False
    if t == 'ID' and (THREAD.match(v) or len(re.findall(r'\d', v)) < 3 and not re.search(r'[A-Za-z]{2,}\d|\d[A-Za-z]{2,}', v)):
        return False                                            # имена потоков и короткие номера
    if t in ('ФИО', 'ОРГАНИЗАЦИЯ') and re.match(r'^[а-яё]', v):   # «бухгалтерии», «отдела качества» — не имя и не компания
        return False
    if t in TECH and not re.search(r'[A-Za-z0-9@._/\\:-]', v):
        return False
    occ = [m.start() for m in re.finditer(re.escape(v), text)]
    if occ and all(re.match(r'\s*[:=—–-]?\s*\[[А-ЯЁA-Z_]+(?:-\d+)?\]', text[i + len(v):i + len(v) + 30]) for i in occ):
        return False                                            # «Подрядчик [ОРГАНИЗАЦИЯ]», «телефон: [ТЕЛЕФОН]» — название поля
    if t in ('ДЕНЬГИ', 'ТЕЛЕФОН') and not re.search(r'\d', v) and not NUM_WORD.search(v):
        return False                                            # «бюджет», «телефон» без цифр и числительных
    digits = len(re.findall(r'\d', v))
    if digits < MIN_DIGITS.get(t, 0) or (t == 'ТЕЛЕФОН' and 0 < digits < 7):
        return False                                            # «504» — не карта, «2 of 5» — не телефон
    starts = [m.start() for m in re.finditer(re.escape(v), text)]
    if re.fullmatch(r'[\d\s.,]+', v):
        if all(UNIT_AFTER.match(text[i + len(v):i + len(v) + 8]) for i in starts):
            return False                                        # 30000 ms, 40 %, 12 МБ
        if t == 'ДЕНЬГИ' and not any(MONEY_NEAR.search(text[max(0, i - 30):i + len(v) + 12]) for i in starts):
            return False                                        # голое число — деньги только рядом с «руб», «сумма»…
    if t not in ('ДЕНЬГИ', 'АДРЕС'):
        starts = [m.start() for m in re.finditer(re.escape(v), text)]
        if starts and all(UI_BEFORE.search(text[max(0, i - 25):i]) for i in starts):
            return False
    return True


ITEM = re.compile(r'\{\s*"text"\s*:\s*"((?:[^"\\]|\\.)*)"\s*,\s*"type"\s*:\s*"([^"]+)"\s*\}')


def parse_items(content):
    """Список из ответа. Если модель упёрлась в предел длины и JSON оборвался — берём целые записи до обрыва."""
    try:
        return json.loads(content or '{}').get('items') or []
    except json.JSONDecodeError:
        out = []
        for m in ITEM.finditer(content):
            try:
                out.append({'text': json.loads('"%s"' % m.group(1)), 'type': m.group(2)})
            except json.JSONDecodeError:
                pass
        return out


def detect(texts, model=None):
    """Найти пропущенное в каждом тексте. Возвращает [[{"text", "type"}], ...] — только то, что дословно есть в тексте."""
    model = model or pick_model()
    if not model:
        raise RuntimeError('Локальная модель не подключена')
    results = []
    for text in texts:
        if not text.strip():
            results.append([])
            continue
        body = {'model': model, 'stream': False, 'think': False, 'format': SCHEMA,
                'options': {'temperature': 0, 'num_ctx': CONTEXT, 'num_predict': MAX_ANSWER_TOKENS},
                'messages': [{'role': 'system', 'content': PROMPT}] +
                            [m for q, a in EXAMPLES for m in ({'role': 'user', 'content': q}, {'role': 'assistant', 'content': a})] +
                            [{'role': 'user', 'content': text}]}
        try:
            reply = _post('/api/chat', body, CHUNK_TIMEOUT)
        except urllib.error.HTTPError:  # старые Ollama не знают параметр think
            body.pop('think', None)
            reply = _post('/api/chat', body, CHUNK_TIMEOUT)
        items = parse_items(reply.get('message', {}).get('content') or '')
        seen, out = set(), []
        for it in items:
            t = it.get('type')
            v = trim(str(it.get('text') or '').strip().strip('.,;:«»"\''), t)
            if len(v) < 2 or t not in TYPES or v in seen or v not in text or v.startswith('[') or not plausible(v, t, text):
                continue
            seen.add(v)
            out.append({'text': v, 'type': t})
        results.append(out)
    return results


# ───────── Перепроверка найденного быстрой проверкой ─────────
# Модель смотрит на каждую находку в её окружении и выносит вердикт: «данные» или «не данные».
# Перепроверяются только типы, где правила ошибаются на обычных словах. Телефоны, документы, деньги, ID,
# пароли, школы, номера договоров найдены по строгому формату — их модель не снимает.
# Пропущенные данные хуже лишней метки, поэтому на каждое «не данные» есть ещё проверки в коде (keep_anyway).
REVIEWABLE = {'ФИО', 'ОРГАНИЗАЦИЯ', 'АДРЕС', 'ДАТА_РОЖДЕНИЯ', 'НИК'}
REVIEW_BATCH = 20
REVIEW_PROMPT = """Автоматическая проверка скрыла в рабочем документе слова, приняв их за персональные данные. Проверь каждую находку.
Находка: номер, тип, значение и текст вокруг, где значение выделено ⟦…⟧.
Вердикт «не данные» — только если по окружению ТОЧНО видно, что это не человек, не компания и не адрес:
- название части системы или обычное слово: модуль «Корзина», раздел Расписание, кнопка, статус, «Машина состояний»;
- термин с фамилией: диаграмма Ганта, принцип Парето, метод Монте-Карло;
- роль или права в системе: admin, guest, «Учитель»; должность, отдел;
- город без улицы и дома; государственный орган (министерство, ведомство).
Вердикт «данные» — во всех остальных случаях. Фамилия или имя человека, который что-то делает (согласовала, ответственный,
позвонил), — это данные, даже одно слово. Компания-подрядчик, клиент — данные. Логин пользователя — данные.
Если сомневаешься — «данные».
Ответ — JSON {"items": [{"n": номер, "value": "значение", "verdict": "данные" или "не данные"}]} для КАЖДОЙ находки."""
REVIEW_EXAMPLE = (
    '1. ФИО «Корзина» — …пользователь открыл модуль «⟦Корзина⟧» и оформил заказ…\n'
    '2. ФИО «Петрова» — …заявку согласовала ⟦Петрова⟧ из отдела продаж…\n'
    '3. ФИО «Ганта» — …сроки показаны на диаграмме ⟦Ганта⟧ в приложении 2…\n'
    '4. ОРГАНИЗАЦИЯ «Ромашка» — …подрядчик ⟦Ромашка⟧ сдал этап…\n'
    '5. НИК «admin» — …роль ⟦admin⟧ видит все разделы…\n'
    '6. НИК «ivanova_e» — …в систему вошёл ⟦ivanova_e⟧…',
    '{"items": [{"n": 1, "value": "Корзина", "verdict": "не данные"}, {"n": 2, "value": "Петрова", "verdict": "данные"}, '
    '{"n": 3, "value": "Ганта", "verdict": "не данные"}, {"n": 4, "value": "Ромашка", "verdict": "данные"}, '
    '{"n": 5, "value": "admin", "verdict": "не данные"}, {"n": 6, "value": "ivanova_e", "verdict": "данные"}]}')
REVIEW_SCHEMA = {'type': 'object', 'properties': {'items': {'type': 'array', 'items': {'type': 'object', 'properties': {
    'n': {'type': 'integer'}, 'value': {'type': 'string'}, 'verdict': {'type': 'string', 'enum': ['данные', 'не данные']}},
    'required': ['n', 'value', 'verdict']}}}, 'required': ['items']}
PERSON_SURE = re.compile(r'(?:вич|вна|вны|вне|вной|вну|вичу|вичем|вича|ична|ичны|ичне|ичной)\b|\b[А-ЯЁ]\.\s?[А-ЯЁ]\.|[А-ЯЁ][а-яё]+\s+[А-ЯЁ][а-яё]+\s+[А-ЯЁ][а-яё]+')
ACTOR_NEAR = re.compile(r'(?:согласова|ответствен|исполнител|позвонил|написал|сообщил|подписал|утвердил|автор|заявител|контакт|от кого|кому|сотрудник|клиент|подрядчик|поставщик|заказчик|контрагент)', re.I)
STREET = re.compile(r'(?:ул\.|улиц|пр-т|просп|пер\.|переул|ш\.|шоссе|д\.\s?\d|дом\s?\d|кв\.|бульв|наб\.)', re.I)


def keep_anyway(it):
    """Проверки в коде поверх модели: это точно данные, что бы она ни сказала."""
    t, v, ctx = it['type'], str(it['value']), str(it.get('snippet') or '')
    if t == 'ФИО' and PERSON_SURE.search(v):
        return True                                   # отчество, инициалы, полное ФИО
    if t == 'НИК' and re.search(r'[\d_.@]', v):
        return True                                   # ivanov_aa, petrov77 — логин человека
    if t == 'ДАТА_РОЖДЕНИЯ' and BIRTH.search(ctx):
        return True
    if t == 'АДРЕС' and STREET.search(v):
        return True
    m = re.search(r'⟦', ctx)
    if t in ('ФИО', 'ОРГАНИЗАЦИЯ') and m and ACTOR_NEAR.search(ctx[max(0, m.start() - 30):m.start()]):
        return True                                   # «согласовала ⟦Петрова⟧», «подрядчик ⟦Ромашка-Софт⟧»
    return False


def review(items, model=None):
    """items: [{"id", "type", "value", "snippet"}]. Возвращает id находок, которые скрыты зря."""
    model = model or pick_model()
    if not model:
        raise RuntimeError('Локальная модель не подключена')
    items = [it for it in items if it.get('type') in REVIEWABLE and not keep_anyway(it)]
    remove = []
    for k in range(0, len(items), REVIEW_BATCH):
        batch = items[k:k + REVIEW_BATCH]
        text = '\n'.join('%d. %s «%s» — %s' % (i + 1, it['type'], str(it['value'])[:80], str(it.get('snippet') or '')[:220].replace('\n', ' '))
                          for i, it in enumerate(batch))
        body = {'model': model, 'stream': False, 'think': False, 'format': REVIEW_SCHEMA,
                'options': {'temperature': 0, 'num_ctx': CONTEXT, 'num_predict': 60 + 30 * len(batch)},
                'messages': [{'role': 'system', 'content': REVIEW_PROMPT},
                             {'role': 'user', 'content': REVIEW_EXAMPLE[0]}, {'role': 'assistant', 'content': REVIEW_EXAMPLE[1]},
                             {'role': 'user', 'content': text}]}
        reply = _post('/api/chat', body, CHUNK_TIMEOUT)
        try:
            verdicts = json.loads(reply.get('message', {}).get('content') or '{}').get('items') or []
        except json.JSONDecodeError:
            verdicts = []
        for vd in verdicts:
            n = vd.get('n')
            if vd.get('verdict') != 'не данные' or not isinstance(n, int) or not 1 <= n <= len(batch):
                continue
            it = batch[n - 1]
            if str(vd.get('value') or '').strip() != str(it['value']).strip()[:80].strip():
                continue                                  # номер и значение не сходятся — не рискуем
            remove.append(it['id'])
    return remove
