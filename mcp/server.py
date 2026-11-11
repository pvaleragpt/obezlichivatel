#!/usr/bin/env python3
"""
Обезличиватель — локальный MCP-сервер для Claude.

Claude не читает исходный файл. Сервер открывает в браузере страницу проверки
(ту же, что «Обезличиватель.html»), пользователь смотрит, что будет скрыто,
и нажимает «Скрыть и отдать Claude». Страница присылает обратно обезличенный файл
и ключ; Claude получает только обезличенный файл.

    Claude --stdio--> server.py --http 127.0.0.1--> страница в браузере

Папки (по умолчанию ~/Обезличиватель, можно задать OBEZL_HOME):
    Сырые/          — исходные файлы с персональными данными (Claude их не читает)
    Обезличенные/   — результат, его Claude читает свободно
    С данными/      — файлы, в которые возвращены настоящие данные (Claude их не читает)
    .ключи/         — ключ «метка → значение» (Claude его не читает)

Только стандартная библиотека Python 3.8+.
"""

import http.server
import json
import os
import re
import secrets
import shutil
import socket
import subprocess
import sys
import threading
import time
import traceback
import urllib.parse
import zipfile
from pathlib import Path

SERVER_NAME = 'obezlichivatel'
VERSION = '2.7.0'
PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05']
PORTS = range(47631, 47651)
APP_PORT = int(os.environ.get('OBEZL_APP_PORT') or 47630)   # постоянный адрес страницы для ярлыка; другой — только для тестов
APP_IDLE = 2 * 3600       # ярлык: сервер выключается, если страницей не пользуются 2 часа
LAST_SEEN = [time.time()]
KEY_SEND_LIMIT = 40 * 1024 * 1024

HOME = Path(os.environ.get('OBEZL_HOME') or Path.home() / 'Обезличиватель').expanduser()
RAW = HOME / 'Сырые'
MASKED = HOME / 'Обезличенные'
RESTORED = HOME / 'С данными'
KEYS = HOME / '.ключи'
GLOBAL_KEY = KEYS / 'ключ.json'
RULES_FILE = HOME / 'правила.txt'
ALLOW_FILE = HOME / 'не скрывать.txt'

HERE = Path(__file__).resolve().parent
PAGE_CANDIDATES = [HERE / 'Обезличиватель.html', HERE.parent / 'dist' / 'Обезличиватель.html']

TOKEN_RE = re.compile(r'\[(ФИО|ТЕЛЕФОН|ПОЧТА|СНИЛС|ИНН|ПАСПОРТ|ПОЛИС|КАРТА|СЧЁТ|ДАТА_РОЖДЕНИЯ|АДРЕС|ШКОЛА|ГОСНОМЕР|НИК|IP|ID|ТОКЕН|СВОЁ)-(\d+)\]')
# Новые ID (замена ID на ID того же вида) ищутся как целые слова.
WORD_RE = re.compile(r'[0-9A-Za-zА-Яа-яЁё][0-9A-Za-zА-Яа-яЁё_.-]*[0-9A-Za-zА-Яа-яЁё]|[0-9A-Za-zА-Яа-яЁё]')
SUPPORTED = {'.xlsx', '.xlsm', '.docx', '.docm', '.pptx', '.pptm', '.pdf', '.png', '.jpg', '.jpeg', '.heic', '.heif', '.tif', '.tiff', '.webp', '.csv', '.tsv', '.txt', '.md', '.json', '.jsonl', '.ndjson', '.log', '.vtt', '.srt', '.xml', '.html'}

INSTRUCTIONS = """Обезличиватель скрывает персональные данные до того, как их увидит Claude.

Правила:
1. Файлы с персональными данными пользователя (выгрузки, обращения, анкеты, расшифровки, списки учеников)
   НИКОГДА не читай напрямую — ни Read, ни Bash, ни Grep. Сначала obezl_mask_file.
   Папки «Сырые», «С данными» и «.ключи» в ~/Обезличиватель закрыты для чтения.
2. obezl_mask_file открывает пользователю страницу проверки в браузере. Скажи пользователю проверить
   и нажать «Скрыть и отдать Claude», затем вызови obezl_result.
3. С результатом из папки «Обезличенные» работай как обычно: obezl_read или свои скрипты.
   Если пользователь говорит «я передал файл со страницы» — вызови obezl_masked, возьми самый свежий.
4. Метки вида [ФИО-1], [ТЕЛЕФОН-3] — это настоящие люди и номера. Не придумывай им имена,
   не меняй и не объединяй метки — сохраняй их в выводах как есть.
   ID (номера учеников, пользователей, UUID, id в логах) заменены на другие ID того же вида: число — числом.
   Они уникальны и одинаковы для одного и того же исходного ID, поэтому связи между таблицами и подсчёты верны.
   Не меняй их и не называй их настоящими.
5. Чтобы пользователь получил документ с настоящими данными, сохрани результат с метками в файл
   (.docx, .xlsx, .pptx, .md, .txt, .csv) и вызови obezl_unmask. Содержимое восстановленного файла ты не увидишь —
   это нормально, сообщи пользователю путь.
"""


def log(*args):
    print('[obezlichivatel]', *args, file=sys.stderr, flush=True)


def ensure_dirs():
    for d in (RAW, MASKED, RESTORED, KEYS):
        d.mkdir(parents=True, exist_ok=True)
    try:
        os.chmod(KEYS, 0o700)
    except OSError:
        pass


def page_path():
    for p in PAGE_CANDIDATES:
        if p.exists():
            return p
    raise FileNotFoundError('Не найдена страница Обезличиватель.html рядом с сервером. Переустановите: bash install.sh')


def read_lines(path):
    try:
        return [x.strip() for x in path.read_text(encoding='utf-8').splitlines() if x.strip() and not x.startswith('#')]
    except FileNotFoundError:
        return []


def human_size(n):
    return '%.1f МБ' % (n / 1048576) if n > 1048576 else '%d КБ' % max(1, n // 1024)


def unique_path(folder, name):
    p = folder / name
    stem, suf, i = p.stem, p.suffix, 2
    while p.exists():
        p = folder / ('%s (%d)%s' % (stem, i, suf))
        i += 1
    return p


# ───────────────────────── Ключ ─────────────────────────

_key_lock = threading.Lock()


def load_key():
    try:
        return json.loads(GLOBAL_KEY.read_text(encoding='utf-8'))
    except (FileNotFoundError, json.JSONDecodeError):
        return {'format': 'obezlichivatel-key', 'version': 1, 'counters': {}, 'tokens': {}, 'index': {}}


def merge_key(new):
    """Страница начинала с общего ключа, поэтому новый — его надмножество. Сливаем на случай параллельных заданий."""
    with _key_lock:
        old = load_key()
        conflicts = 0
        for tok, val in (new.get('tokens') or {}).items():
            if tok in old['tokens'] and old['tokens'][tok].get('value') != val.get('value'):
                conflicts += 1
                continue
            old['tokens'][tok] = val
        for k, tok in (new.get('index') or {}).items():
            old['index'].setdefault(k, tok)
        for t, n in (new.get('counters') or {}).items():
            old['counters'][t] = max(old['counters'].get(t, 0), n)
        old['updated'] = time.strftime('%Y-%m-%dT%H:%M:%S')
        tmp = GLOBAL_KEY.with_suffix('.tmp')
        tmp.write_text(json.dumps(old, ensure_ascii=False, indent=1), encoding='utf-8')
        os.chmod(tmp, 0o600)
        tmp.replace(GLOBAL_KEY)
        return conflicts


# ───────────────────────── Умная проверка: Natasha ─────────────────────────

NER_SCRIPT = HERE / 'ner_worker.py'


class Ner:
    """Natasha в отдельном процессе: ей нужен Python с пакетом natasha, а сервер работает на любом python3."""

    def __init__(self):
        self.proc, self.python, self.checked = None, None, False
        self.lock = threading.Lock()

    def candidates(self):
        home = Path.home()
        if os.name == 'nt':
            return [os.environ.get('OBEZL_NER_PYTHON'), HERE / '.venv' / 'Scripts' / 'python.exe',
                    home / 'obezlichivatel-mcp' / '.venv' / 'Scripts' / 'python.exe']
        return [os.environ.get('OBEZL_NER_PYTHON'), HERE / '.venv' / 'bin' / 'python',
                home / 'obezlichivatel-mcp' / '.venv' / 'bin' / 'python',
                home / 'Library' / 'Application Support' / 'Славатор 2' / 'env' / 'bin' / 'python',
                home / 'Library' / 'Application Support' / 'Славатор' / 'env' / 'bin' / 'python']

    def find_python(self):
        if self.checked:
            return self.python
        self.checked = True
        for c in self.candidates():
            if not c or not Path(c).exists():
                continue
            try:
                ok = subprocess.run([str(c), '-c', 'import natasha'], capture_output=True, timeout=30).returncode == 0
            except Exception:  # noqa: BLE001
                ok = False
            if ok:
                self.python = str(c)
                break
        return self.python

    def available(self):
        return NER_SCRIPT.exists() and self.find_python() is not None

    def _start(self):
        self.proc = subprocess.Popen([self.find_python(), '-u', str(NER_SCRIPT)], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                     stderr=subprocess.DEVNULL, text=True, encoding='utf-8',
                                     **({'creationflags': 0x08000000} if os.name == 'nt' else {}))   # без окна консоли
        ready = self.proc.stdout.readline()
        if 'ready' not in ready:
            raise RuntimeError('Natasha не запустилась')

    def run(self, texts):
        with self.lock:
            if not self.available():
                raise RuntimeError('Natasha не установлена')
            if self.proc is None or self.proc.poll() is not None:
                self._start()
            self.proc.stdin.write(json.dumps({'id': 1, 'texts': texts}, ensure_ascii=False) + '\n')
            self.proc.stdin.flush()
            reply = json.loads(self.proc.stdout.readline() or '{}')
            if 'error' in reply:
                raise RuntimeError(reply['error'])
            return reply.get('results') or []


NER = Ner()


def ocr_binary():
    """Распознавание текста на картинках — Apple Vision через маленькую программу (см. ocr.swift). Только macOS."""
    if sys.platform != 'darwin':
        return None
    for name in ('ocr', 'ocr-macos'):
        p = HERE / name
        if p.is_file() and os.access(p, os.X_OK):
            return p
    return None


def ocr_image(data):
    """Байты картинки → строки текста с координатами. Картинка живёт только во временном файле и сразу удаляется."""
    binary = ocr_binary()
    if not binary:
        raise RuntimeError('Распознавание доступно только на Mac')
    import tempfile
    fd, path = tempfile.mkstemp(prefix='obezl-ocr-', suffix='.img')
    try:
        os.chmod(path, 0o600)
        with os.fdopen(fd, 'wb') as f:
            f.write(data)
        out = subprocess.run([str(binary), path], capture_output=True, timeout=180)
        if out.returncode != 0:
            raise RuntimeError(out.stderr.decode('utf-8', 'replace').strip() or 'распознавание не удалось')
        return json.loads(out.stdout.decode('utf-8'))
    finally:
        try:
            os.unlink(path)
        except OSError:
            pass

sys.path.insert(0, str(HERE))
try:
    import llm as LLM          # глубокая проверка локальной моделью (Ollama)
except Exception as _e:        # noqa: BLE001 — без модуля работает всё остальное
    LLM = None


# ───────────────────────── Задания и HTTP ─────────────────────────

JOBS = {}
_jobs_lock = threading.Lock()
PORT = None


class Handler(http.server.BaseHTTPRequestHandler):
    server_version = 'Obezlichivatel'

    def log_message(self, fmt, *args):
        pass

    def _host_ok(self):
        host = (self.headers.get('Host') or '').split(':')[0]
        return host in ('127.0.0.1', 'localhost')

    def _send(self, code, body=b'', ctype='text/plain; charset=utf-8', extra=None):
        self.send_response(code)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Referrer-Policy', 'no-referrer')
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if body:
            self.wfile.write(body)

    def _job(self, q):
        job_id, token = (q.get('job') or [''])[0], (q.get('t') or [''])[0]
        with _jobs_lock:
            job = JOBS.get(job_id)
        if not job or not secrets.compare_digest(job['token'], token):
            return None
        return job

    def do_GET(self):
        if not self._host_ok():
            return self._send(403)
        u = urllib.parse.urlparse(self.path)
        q = urllib.parse.parse_qs(u.query)
        LAST_SEEN[0] = time.time()
        if u.path == '/':
            return self._send(200, page_path().read_bytes(), 'text/html; charset=utf-8')
        if u.path == '/api/app/key':
            if self.headers.get('X-Obezl') != '1':
                return self._send(403)
            key = load_key()
            if GLOBAL_KEY.exists() and GLOBAL_KEY.stat().st_size > KEY_SEND_LIMIT:
                key = {'counters': key.get('counters') or {}, 'tokens': {}, 'index': {}}
            key['format'] = 'obezlichivatel-key'
            return self._send(200, json.dumps(key, ensure_ascii=False).encode('utf-8'), 'application/json; charset=utf-8')
        if u.path == '/api/ping':
            return self._send(200, b'obezlichivatel')
        if u.path == '/api/ai/status':
            body = {'ner': NER.available(), 'llm': LLM.SETUP.status() if LLM else None, 'ocr': bool(ocr_binary())}
            return self._send(200, json.dumps(body).encode(), 'application/json; charset=utf-8')
        job = self._job(q)
        if not job:
            return self._send(404, 'Задание не найдено'.encode())
        if u.path == '/api/job':
            key = load_key()
            if GLOBAL_KEY.exists() and GLOBAL_KEY.stat().st_size > KEY_SEND_LIMIT:
                # Ключ разросся: передаём только счётчики. Метки останутся уникальными,
                # но один и тот же человек в новом файле получит новую метку.
                key = {'counters': key.get('counters') or {}, 'tokens': {}, 'index': {}}
            body = {'name': job['name'], 'size': job['size'], 'rules': read_lines(RULES_FILE),
                    'allow': read_lines(ALLOW_FILE), 'key': key}
            return self._send(200, json.dumps(body, ensure_ascii=False).encode(), 'application/json; charset=utf-8')
        if u.path == '/api/file':
            size = job['path'].stat().st_size
            self.send_response(200)
            self.send_header('Content-Type', 'application/octet-stream')
            self.send_header('Content-Length', str(size))
            self.send_header('Cache-Control', 'no-store')
            self.end_headers()
            with open(job['path'], 'rb') as f:
                shutil.copyfileobj(f, self.wfile, 1024 * 1024)
            return
        return self._send(404)

    def do_POST(self):
        if not self._host_ok():
            return self._send(403)
        u = urllib.parse.urlparse(self.path)
        q = urllib.parse.parse_qs(u.query)
        LAST_SEEN[0] = time.time()
        length = int(self.headers.get('Content-Length') or 0)
        # Запросы страницы, которые что-то меняют, — только со своим заголовком: чужой сайт его не пошлёт без разрешения.
        if (u.path.startswith('/api/app/') or u.path.startswith('/api/ai/')) and self.headers.get('X-Obezl') != '1':
            return self._send(403)
        if u.path in ('/api/ai/ollama/setup', '/api/ai/ollama/start'):
            if not LLM:
                return self._send(500, 'модуль llm не найден'.encode('utf-8'))
            LLM.SETUP.start(serve_only=u.path.endswith('/start'))
            return self._send(200, json.dumps(LLM.SETUP.status(), ensure_ascii=False).encode('utf-8'), 'application/json; charset=utf-8')
        if u.path == '/api/ai/llm':
            try:
                texts = json.loads(self.rfile.read(length).decode('utf-8')).get('texts') or []
                results, skipped = [], 0
                for t in texts:
                    try:
                        results += LLM.detect([str(t)])
                    except (TimeoutError, OSError) as e:   # модель не ответила вовремя — кусок пропускаем, проверка идёт дальше
                        if 'timed out' not in str(e) and not isinstance(e, TimeoutError):
                            raise
                        results.append([])
                        skipped += 1
                body = {'results': results, 'skipped': skipped}
                return self._send(200, json.dumps(body, ensure_ascii=False).encode('utf-8'), 'application/json; charset=utf-8')
            except Exception as e:  # noqa: BLE001
                return self._send(500, json.dumps({'error': str(e)}, ensure_ascii=False).encode('utf-8'), 'application/json; charset=utf-8')
        if u.path == '/api/ai/review':
            try:
                items = json.loads(self.rfile.read(length).decode('utf-8')).get('items') or []
                try:
                    body = {'remove': LLM.review(items), 'skipped': 0}
                except (TimeoutError, OSError) as e:
                    if 'timed out' not in str(e) and not isinstance(e, TimeoutError):
                        raise
                    body = {'remove': [], 'skipped': 1}
                return self._send(200, json.dumps(body, ensure_ascii=False).encode('utf-8'), 'application/json; charset=utf-8')
            except Exception as e:  # noqa: BLE001
                return self._send(500, json.dumps({'error': str(e)}, ensure_ascii=False).encode('utf-8'), 'application/json; charset=utf-8')
        if u.path == '/api/app/save':
            ensure_dirs()
            name = Path((q.get('name') or ['результат'])[0]).name
            out = unique_path(MASKED, name)
            tmp = out.with_name(out.name + '.part')
            with open(tmp, 'wb') as f:
                left = length
                while left > 0:
                    chunk = self.rfile.read(min(left, 1024 * 1024))
                    if not chunk:
                        break
                    f.write(chunk)
                    left -= len(chunk)
            tmp.replace(out)
            return self._send(200, json.dumps({'path': str(out), 'name': out.name}, ensure_ascii=False).encode('utf-8'), 'application/json; charset=utf-8')
        if u.path == '/api/app/key':
            data = json.loads(self.rfile.read(length).decode('utf-8'))
            conflicts = merge_key(data.get('key') or {})
            stem = Path(str(data.get('name') or 'файл')).stem
            per = KEYS / (stem + '.ключ.json')
            per.write_text(json.dumps(data.get('key') or {}, ensure_ascii=False, indent=1), encoding='utf-8')
            os.chmod(per, 0o600)
            return self._send(200, json.dumps({'conflicts': conflicts}).encode(), 'application/json; charset=utf-8')
        if u.path == '/api/ai/ocr':
            try:
                data = self.rfile.read(length) if length <= 80 * 1024 * 1024 else b''
                if not data:
                    return self._send(400, 'пустая или слишком большая картинка'.encode('utf-8'))
                return self._send(200, json.dumps(ocr_image(data), ensure_ascii=False).encode('utf-8'), 'application/json; charset=utf-8')
            except Exception as e:  # noqa: BLE001
                return self._send(500, json.dumps({'error': str(e)}, ensure_ascii=False).encode('utf-8'), 'application/json; charset=utf-8')
        if u.path == '/api/ai/ner':
            if length > 64 * 1024 * 1024:
                return self._send(413)
            try:
                texts = json.loads(self.rfile.read(length).decode('utf-8')).get('texts') or []
                body = {'results': NER.run([str(t) for t in texts])}
                return self._send(200, json.dumps(body, ensure_ascii=False).encode('utf-8'), 'application/json; charset=utf-8')
            except Exception as e:  # noqa: BLE001
                return self._send(500, json.dumps({'error': str(e)}, ensure_ascii=False).encode('utf-8'), 'application/json; charset=utf-8')
        job = self._job(q)
        if not job:
            return self._send(404)
        if u.path == '/api/result':
            name = Path((q.get('name') or ['результат'])[0]).name
            out = unique_path(MASKED, name)
            tmp = out.with_name(out.name + '.part')
            with open(tmp, 'wb') as f:
                left = length
                while left > 0:
                    chunk = self.rfile.read(min(left, 1024 * 1024))
                    if not chunk:
                        break
                    f.write(chunk)
                    left -= len(chunk)
            tmp.replace(out)
            job['result'] = out
            return self._send(200, b'ok')
        if u.path == '/api/key':
            data = json.loads(self.rfile.read(length).decode('utf-8'))
            job['conflicts'] = merge_key(data.get('key') or {})
            job['counts'] = data.get('counts') or {}
            job['report'] = data.get('report') or {}
            if job.get('result'):
                per_job = KEYS / (job['result'].stem + '.ключ.json')
                per_job.write_text(json.dumps(data.get('key') or {}, ensure_ascii=False, indent=1), encoding='utf-8')
                os.chmod(per_job, 0o600)
            job['status'] = 'done'
            job['done_at'] = time.time()
            return self._send(200, b'ok')
        return self._send(404)


def start_http(ports=None):
    global PORT
    for port in ports or PORTS:
        try:
            srv = http.server.ThreadingHTTPServer(('127.0.0.1', port), Handler)
        except OSError:
            continue
        PORT = port
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        log('страница проверки: http://127.0.0.1:%d/' % port)
        return
    raise OSError('Нет свободного порта для страницы')


def run_app():
    """Ярлык: страница по постоянному адресу. Уже запущена — просто открыть, иначе запустить и ждать."""
    url = 'http://127.0.0.1:%d/' % APP_PORT
    try:
        import urllib.request
        if urllib.request.urlopen(url + 'api/ping', timeout=1).read() == b'obezlichivatel':
            open_browser(url)
            return
    except Exception:  # noqa: BLE001
        pass
    ensure_dirs()
    start_http([APP_PORT] + list(PORTS))
    open_browser('http://127.0.0.1:%d/' % PORT)
    threading.Thread(target=NER.available, daemon=True).start()   # заранее найти Natasha
    while time.time() - LAST_SEEN[0] < APP_IDLE:
        time.sleep(60)


def open_browser(url):
    if os.environ.get('OBEZL_NO_BROWSER'):
        return False
    try:
        if sys.platform == 'darwin':
            subprocess.Popen(['open', url])
        elif os.name == 'nt':
            os.startfile(url)  # noqa
        else:
            subprocess.Popen(['xdg-open', url], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        return True
    except Exception:  # noqa: BLE001
        return False


# ───────────────────────── Чтение обезличенных файлов ─────────────────────────

def _unesc(s):
    return (s.replace('&lt;', '<').replace('&gt;', '>').replace('&quot;', '"').replace('&apos;', "'").replace('&amp;', '&'))


def docx_paragraphs(path):
    with zipfile.ZipFile(path) as z:
        xml = z.read('word/document.xml').decode('utf-8')
    for m in re.finditer(r'<w:p[\s>/][\s\S]*?</w:p>|<w:p/>', xml):
        para = re.sub(r'<w:(?:br|cr)\b[^>]*/>', '<w:t>\n</w:t>', m.group(0))   # переносы строк внутри абзаца
        texts = re.findall(r'<w:(?:t|delText)(?:\s[^>]*)?>([^<]*)</w:(?:t|delText)>', para)
        tabs = m.group(0)
        if texts:
            yield _unesc(''.join(texts))
        elif '<w:tbl' not in tabs:
            yield ''


def pptx_slides(path):
    """Текст презентации по слайдам: абзацы слайда, затем заметки докладчика."""
    with zipfile.ZipFile(path) as z:
        names = z.namelist()

        def num(n):
            m = re.search(r'(\d+)\.xml$', n)
            return int(m.group(1)) if m else 0
        slides = sorted((n for n in names if re.match(r'ppt/slides/slide\d+\.xml$', n)), key=num)
        notes = {num(n): n for n in names if re.match(r'ppt/notesSlides/notesSlide\d+\.xml$', n)}

        def paras(name):
            xml = z.read(name).decode('utf-8')
            for m in re.finditer(r'<a:p[\s>][\s\S]*?</a:p>', xml):
                para = re.sub(r'<a:br\b[^>]*/>', '<a:t>\n</a:t>', m.group(0))
                t = _unesc(''.join(re.findall(r'<a:t(?:\s[^>]*)?>([^<]*)</a:t>', para)))
                if t.strip():
                    yield t
        out = []
        for i, name in enumerate(slides, 1):
            out.append('── Слайд %d ──' % i)
            out.extend(paras(name))
            # Заметки к слайду связаны через _rels; номер заметок обычно совпадает с номером слайда.
            rel = 'ppt/slides/_rels/%s.rels' % name.split('/')[-1]
            note = None
            if rel in names:
                m = re.search(r'Target="\.\./notesSlides/(notesSlide\d+\.xml)"', z.read(rel).decode('utf-8'))
                note = 'ppt/notesSlides/' + m.group(1) if m else None
            note = note or notes.get(num(name))
            if note and note in names:
                lines = [t for t in paras(note) if not re.fullmatch(r'\d+', t.strip())]
                if lines:
                    out.append('Заметки: ' + ' / '.join(lines))
    return out


def xlsx_sheets(path):
    with zipfile.ZipFile(path) as z:
        wb = z.read('xl/workbook.xml').decode('utf-8')
        rels = z.read('xl/_rels/workbook.xml.rels').decode('utf-8') if 'xl/_rels/workbook.xml.rels' in z.namelist() else ''
    targets = {}
    for m in re.finditer(r'<Relationship\b([^>]*)/?>', rels):
        a = m.group(1)
        rid = re.search(r'Id="([^"]+)"', a)
        tgt = re.search(r'Target="([^"]+)"', a)
        if rid and tgt:
            t = tgt.group(1)
            targets[rid.group(1)] = t.lstrip('/') if t.startswith('/') else 'xl/' + t
    out = []
    for m in re.finditer(r'<sheet\b([^>]*)/?>', wb):
        name = re.search(r'name="([^"]*)"', m.group(1))
        rid = re.search(r'\b\w+:id="([^"]+)"', m.group(1))
        if rid and rid.group(1) in targets:
            out.append((_unesc(name.group(1)) if name else '?', targets[rid.group(1)]))
    return out


def xlsx_rows(path, sheet_path):
    with zipfile.ZipFile(path) as z:
        names = z.namelist()
        sst = []
        if 'xl/sharedStrings.xml' in names:
            data = z.read('xl/sharedStrings.xml').decode('utf-8')
            for m in re.finditer(r'<si>([\s\S]*?)</si>|<si/>', data):
                inner = re.sub(r'<rPh\b[\s\S]*?</rPh>', '', m.group(1) or '')
                sst.append(_unesc(''.join(re.findall(r'<t(?:\s[^>]*)?>([^<]*)</t>', inner))))
        with z.open(sheet_path) as f:
            buf = ''
            while True:
                chunk = f.read(4 * 1024 * 1024)
                text = chunk.decode('utf-8', errors='ignore') if chunk else ''
                buf += text
                cut = buf.rfind('</row>') + 6 if chunk else len(buf)
                part, buf = buf[:cut], buf[cut:]
                for rm in re.finditer(r'<row\b[^>]*?(?:/>|>([\s\S]*?)</row>)', part):
                    cells, ci = {}, -1
                    for cm in re.finditer(r'<c\b([^>]*?)(?:/>|>([\s\S]*?)</c>)', rm.group(1) or ''):
                        a, body = cm.group(1), cm.group(2) or ''
                        r = re.search(r'\br="([A-Z]+)\d+"', a)
                        if r:
                            ci = 0
                            for ch in r.group(1):
                                ci = ci * 26 + ord(ch) - 64
                            ci -= 1
                        else:
                            ci += 1
                        t = re.search(r'\bt="(\w+)"', a)
                        t = t.group(1) if t else 'n'
                        v = re.search(r'<v>([^<]*)</v>', body)
                        if t == 's' and v:
                            val = sst[int(v.group(1))] if int(v.group(1)) < len(sst) else ''
                        elif t == 'inlineStr':
                            val = _unesc(''.join(re.findall(r'<t(?:\s[^>]*)?>([^<]*)</t>', body)))
                        else:
                            val = _unesc(v.group(1)) if v else ''
                        cells[ci] = val.replace('\t', ' ').replace('\n', ' ')
                    if cells:
                        yield [cells.get(i, '') for i in range(max(cells) + 1)]
                if not chunk:
                    break


def read_masked(path, sheet=None, offset=0, limit=200):
    path = Path(path)
    ext = path.suffix.lower()
    if ext in ('.docx', '.docm'):
        paras = list(docx_paragraphs(path))
        part = paras[offset:offset + limit]
        return {'type': 'docx', 'paragraphs_total': len(paras), 'offset': offset, 'text': '\n'.join(part)}
    if ext in ('.pptx', '.pptm'):
        lines = pptx_slides(path)
        part = lines[offset:offset + limit]
        return {'type': 'pptx', 'lines_total': len(lines), 'offset': offset, 'text': '\n'.join(part)}
    if ext in ('.xlsx', '.xlsm'):
        sheets = xlsx_sheets(path)
        if not sheets:
            return {'type': 'xlsx', 'error': 'листов не найдено'}
        names = [s[0] for s in sheets]
        chosen = sheets[0]
        if sheet is not None:
            for s in sheets:
                if s[0] == sheet or str(sheet) == str(names.index(s[0]) + 1):
                    chosen = s
        rows, total = [], 0
        for i, row in enumerate(xlsx_rows(path, chosen[1])):
            total = i + 1
            if offset <= i < offset + limit:
                rows.append('\t'.join(row))
        return {'type': 'xlsx', 'sheets': names, 'sheet': chosen[0], 'rows_total': total, 'offset': offset, 'tsv': '\n'.join(rows)}
    text = path.read_text(encoding='utf-8', errors='replace').lstrip('﻿').splitlines()
    return {'type': 'text', 'lines_total': len(text), 'offset': offset, 'text': '\n'.join(text[offset:offset + limit])}


# ───────────────────────── Возврат данных ─────────────────────────

def _xml_esc(s):
    return s.replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;').replace('"', '&quot;')


def unmask_file(src, key):
    src = Path(src)
    tokens = key.get('tokens') or {}
    has_pseudo = any(v.get('pseudo') for v in tokens.values())
    stats = {'count': 0, 'missing': set()}

    def restore(text, xml):
        def tok(m):
            t = tokens.get(m.group(0))
            if not t:
                stats['missing'].add(m.group(0))
                return m.group(0)
            stats['count'] += 1
            return _xml_esc(t['value']) if xml else t['value']

        def word(m):
            t = tokens.get(m.group(0))
            if t and t.get('pseudo'):
                stats['count'] += 1
                return _xml_esc(t['value']) if xml else t['value']
            return m.group(0)

        text = TOKEN_RE.sub(tok, text)
        return WORD_RE.sub(word, text) if has_pseudo else text

    def xml_part(name, data):
        if re.match(r'xl/worksheets/[^/]+\.xml$', name):
            # В ячейках со ссылкой на общую строку число — номер строки, его не трогаем.
            def cell(m):
                attrs, body = m.group(1), m.group(2)
                if body is None or re.search(r'\bt="s"', attrs):
                    return m.group(0)
                # Ячейка — ровно одна метка, а была числом или датой: возвращаем число с прежним форматом.
                if re.search(r'\bt="inlineStr"', attrs):
                    only = _unesc(''.join(re.findall(r'<t(?:\s[^>]*)?>([^<]*)</t>', body))).strip()
                    t = tokens.get(only)
                    if t and t.get('num') is not None:
                        stats['count'] += 1
                        return '<c%s><v>%s</v></c>' % (re.sub(r'\s+t="[^"]*"', '', attrs), _xml_esc(str(t['num'])))
                return re.sub(r'(<v>|<t(?:\s[^>]*)?>)([^<]+)', lambda x: x.group(1) + restore(_unesc(x.group(2)), True), m.group(0))
            return re.sub(r'<c\b([^>]*?)(?:/>|>([\s\S]*?)</c>)', cell, data)
        data = re.sub(r'(^|>)([^<]+)(?=<|$)', lambda x: x.group(1) + restore(_unesc(x.group(2)), True), data)
        return re.sub(r'="([^"]*\[[^"]*)"', lambda x: '="' + restore(_unesc(x.group(1)), True) + '"', data)

    name = src.stem.replace(' (обезличено)', '') + ' (с данными)' + src.suffix
    out = unique_path(RESTORED, name)
    if zipfile.is_zipfile(src):
        with zipfile.ZipFile(src) as zin, zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as zout:
            for info in zin.infolist():
                data = zin.read(info.filename)
                if info.filename.endswith(('.xml', '.rels')):
                    data = xml_part(info.filename, data.decode('utf-8')).encode('utf-8')
                zout.writestr(info, data)
    else:
        raw = src.read_bytes()
        bom = raw.startswith(b'\xef\xbb\xbf')
        text = raw.decode('utf-8-sig', errors='replace')
        out.write_bytes((b'\xef\xbb\xbf' if bom else b'') + restore(text, False).encode('utf-8'))
    try:
        os.chmod(out, 0o600)
    except OSError:
        pass
    return out, stats['count'], sorted(stats['missing'])


# ───────────────────────── Инструменты ─────────────────────────

def raw_files():
    files = [p for p in RAW.iterdir() if p.is_file() and not p.name.startswith('.') and p.suffix.lower() in SUPPORTED]
    return sorted(files, key=lambda p: p.stat().st_mtime, reverse=True)


def tool_files(args):
    ensure_dirs()
    files = raw_files()
    if not files:
        return ('Папка «Сырые» пуста: %s\nПопросите пользователя положить туда файл (Excel, Word, PowerPoint, PDF, CSV, текст) '
                'или передайте путь к файлу в obezl_mask_file.' % RAW)
    lines = ['Файлы в «Сырые» (имена скрыты — в них бывают фамилии). №1 — самый свежий:']
    for i, p in enumerate(files[:30], 1):
        st = p.stat()
        lines.append('%d. %s, %s, изменён %s' % (i, p.suffix.lower().lstrip('.'), human_size(st.st_size),
                                                time.strftime('%d.%m %H:%M', time.localtime(st.st_mtime))))
    return '\n'.join(lines)


def _new_job(path, display_name):
    ensure_dirs()
    if PORT is None:
        start_http()
    job_id, token = secrets.token_hex(6), secrets.token_urlsafe(24)
    job = {'id': job_id, 'token': token, 'path': path, 'name': display_name, 'size': path.stat().st_size,
           'status': 'review', 'created': time.time()}
    with _jobs_lock:
        JOBS[job_id] = job
    url = 'http://127.0.0.1:%d/?job=%s&t=%s' % (PORT, job_id, token)
    opened = open_browser(url)
    return job, url, opened


def tool_mask_file(args):
    ensure_dirs()
    f = args.get('file')
    if f in (None, '', 0):
        f = 1
    if isinstance(f, int) or (isinstance(f, str) and f.strip().isdigit()):
        files = raw_files()
        n = int(f)
        if not files:
            raise ValueError('Папка «Сырые» пуста: %s. Попросите пользователя положить туда файл.' % RAW)
        if not 1 <= n <= len(files):
            raise ValueError('В «Сырые» %d файл(ов), номер %d не подходит.' % (len(files), n))
        path = files[n - 1]
    else:
        path = Path(str(f)).expanduser()
        if not path.is_file():
            raise ValueError('Файл не найден: %s' % path)
    if path.suffix.lower() in ('.doc', '.xls', '.ppt'):
        raise ValueError('Старый формат %s. Попросите пользователя пересохранить файл как .docx, .xlsx или .pptx.' % path.suffix)
    job, url, opened = _new_job(path, path.name)
    return ('Задание %s: %s страницу проверки в браузере (%s, %s).\n'
            'Скажите пользователю: «Проверьте, что будет скрыто, и нажмите „Скрыть и отдать Claude“». '
            'Если страница не открылась, пусть откроет ссылку:\n%s\n'
            'Затем вызовите obezl_result с job="%s" (можно с wait_seconds до 120).'
            % (job['id'], 'открыл' if opened else 'не удалось открыть', path.suffix.lstrip('.'), human_size(job['size']), url, job['id']))


def tool_mask_clipboard(args):
    ensure_dirs()
    try:
        if sys.platform == 'darwin':
            text = subprocess.run(['pbpaste'], capture_output=True, timeout=5).stdout.decode('utf-8', errors='replace')
        elif os.name == 'nt':
            text = subprocess.run(['powershell', '-NoProfile', '-Command', 'Get-Clipboard -Raw'], capture_output=True, timeout=10).stdout.decode('utf-8', errors='replace')
        else:
            text = subprocess.run(['xclip', '-selection', 'clipboard', '-o'], capture_output=True, timeout=5).stdout.decode('utf-8', errors='replace')
    except Exception as e:  # noqa: BLE001
        raise ValueError('Не удалось прочитать буфер обмена: %s' % e)
    if not text.strip():
        raise ValueError('Буфер обмена пуст. Пусть пользователь скопирует текст и попросит снова.')
    path = unique_path(RAW, 'буфер %s.txt' % time.strftime('%Y-%m-%d %H-%M'))
    path.write_text(text, encoding='utf-8')
    job, url, opened = _new_job(path, path.name)
    return ('Задание %s: текст из буфера (%d символов) открыт на странице проверки. '
            'Когда пользователь нажмёт «Скрыть и отдать Claude», вызовите obezl_result с job="%s".\nСсылка: %s'
            % (job['id'], len(text), job['id'], url))


def tool_result(args):
    job_id = str(args.get('job') or '')
    wait = max(0, min(int(args.get('wait_seconds') or 0), 120))
    with _jobs_lock:
        job = JOBS.get(job_id) or (sorted(JOBS.values(), key=lambda j: j['created'])[-1] if JOBS and not job_id else None)
    if not job:
        raise ValueError('Задание не найдено. Задания живут, пока работает сервер; начните заново с obezl_mask_file.')
    deadline = time.time() + wait
    while job['status'] != 'done' and time.time() < deadline:
        time.sleep(1)
    if job['status'] != 'done':
        return 'Задание %s ещё на проверке у пользователя. Подождите, пока он нажмёт «Скрыть и отдать Claude», и вызовите снова.' % job['id']
    res = job['result']
    rep = job.get('report') or {}
    lines = ['Готово. Обезличенный файл: %s (%s)' % (res, human_size(res.stat().st_size))]
    counts = job.get('counts') or {}
    if counts:
        lines.append('Заменено: ' + ', '.join('%s — %d' % (k, v) for k, v in sorted(counts.items(), key=lambda x: -x[1])))
    cols = [c for c in rep.get('columns') or [] if c.get('hidden')]
    if cols:
        lines.append('Столбцы, скрытые целиком: ' + ', '.join('%s «%s» → %s' % (c['letter'], c['header'], c['hidden']) for c in cols))
    for w in rep.get('warnings') or []:
        lines.append('Внимание: ' + w)
    if job.get('conflicts'):
        lines.append('Внимание: %d меток пересеклись с параллельным заданием — проверьте ключ.' % job['conflicts'])
    preview = read_masked(res, limit=40)
    lines.append('\nНачало файла (дальше — obezl_read):')
    lines.append(preview.get('tsv') or preview.get('text') or '')
    return '\n'.join(lines)


def _inside(path, folder):
    try:
        Path(path).resolve().relative_to(folder.resolve())
        return True
    except ValueError:
        return False


def tool_masked(args):
    ensure_dirs()
    files = sorted([p for p in MASKED.iterdir() if p.is_file() and not p.name.startswith('.') and not p.name.endswith('.part')],
                   key=lambda p: p.stat().st_mtime, reverse=True)
    if not files:
        return 'В «Обезличенные» пока пусто: %s' % MASKED
    lines = ['Обезличенные файлы (свежие сверху). Читать — obezl_read с этим путём:']
    for p in files[:30]:
        lines.append('- %s · %s · %s' % (p, human_size(p.stat().st_size), time.strftime('%d.%m %H:%M', time.localtime(p.stat().st_mtime))))
    return '\n'.join(lines)


def tool_read(args):
    path = Path(str(args.get('path') or '')).expanduser()
    if not path.is_absolute():
        path = MASKED / path
    if not _inside(path, MASKED):
        raise ValueError('obezl_read читает только обезличенные файлы из %s.' % MASKED)
    if not path.is_file():
        raise ValueError('Файл не найден: %s' % path)
    return read_masked(path, args.get('sheet'), int(args.get('offset') or 0), max(1, min(int(args.get('limit') or 200), 2000)))


def tool_unmask(args):
    ensure_dirs()
    src = Path(str(args.get('path') or '')).expanduser()
    if not src.is_file():
        raise ValueError('Файл не найден: %s' % src)
    if _inside(src, RAW) or _inside(src, RESTORED):
        raise ValueError('Это файл с настоящими данными — восстанавливать в нём нечего.')
    key = load_key()
    if not key.get('tokens'):
        raise ValueError('Ключ пуст: файлы ещё не обезличивались через этот сервер.')
    out, count, missing = unmask_file(src, key)
    msg = 'Готово: возвращено значений — %d. Файл с настоящими данными: %s\n' % (count, out)
    msg += 'Его содержимое скрыто от Claude: откройте файл сами.'
    if missing:
        msg += '\nНет в ключе (оставлены как есть): ' + ', '.join(missing[:20])
    return msg


def tool_status(args):
    ensure_dirs()
    key = load_key()
    by = {}
    for v in (key.get('tokens') or {}).values():
        by[v.get('type')] = by.get(v.get('type'), 0) + 1
    guard = False
    try:
        guard = 'guard.py' in (Path.home() / '.claude' / 'settings.json').read_text(encoding='utf-8')
    except FileNotFoundError:
        pass
    return {
        'version': VERSION,
        'folders': {'сырые': str(RAW), 'обезличенные': str(MASKED), 'с данными': str(RESTORED)},
        'page': 'http://127.0.0.1:%d/' % PORT if PORT else 'запустится при первом задании',
        'key_tokens': by,
        'guard_hook': 'защита включена' if guard else 'защита не установлена (запустите install.sh)',
        'raw_files': len(raw_files()),
        'own_rules': len(read_lines(RULES_FILE)),
    }


def tool_open_page(args):
    ensure_dirs()
    if PORT is None:
        start_http()
    url = 'http://127.0.0.1:%d/' % PORT
    open_browser(url)
    return 'Открыл страницу Обезличивателя: %s. На ней можно обезличить файл или текст вручную и вернуть данные по ключу.' % url


TOOLS = [
    {'name': 'obezl_files', 'handler': tool_files,
     'description': 'Список файлов в папке «Сырые» (~/Обезличиватель/Сырые): номер, тип, размер, время. Имена скрыты.',
     'inputSchema': {'type': 'object', 'properties': {}}},
    {'name': 'obezl_mask_file', 'handler': tool_mask_file,
     'description': 'Обезличить файл (Excel, Word, PowerPoint, PDF, CSV, текст): открывает пользователю страницу проверки. '
                    'file — номер из obezl_files (1 — самый свежий, по умолчанию) или полный путь к файлу. '
                    'Используйте ВМЕСТО чтения файла с персональными данными.',
     'inputSchema': {'type': 'object', 'properties': {'file': {'type': ['string', 'integer'], 'description': 'Номер или путь'}}}},
    {'name': 'obezl_mask_clipboard', 'handler': tool_mask_clipboard,
     'description': 'Обезличить текст из буфера обмена пользователя (письмо, переписка, кусок документа) — через ту же страницу проверки.',
     'inputSchema': {'type': 'object', 'properties': {}}},
    {'name': 'obezl_result', 'handler': tool_result,
     'description': 'Результат обезличивания: путь к обезличенному файлу, что скрыто, начало файла. wait_seconds — сколько ждать нажатия кнопки (до 120).',
     'inputSchema': {'type': 'object', 'properties': {'job': {'type': 'string'}, 'wait_seconds': {'type': 'integer'}}}},
    {'name': 'obezl_masked', 'handler': tool_masked,
     'description': 'Список обезличенных файлов в «Обезличенные» (свежие сверху) — в том числе переданных со страницы кнопкой «Передать в Claude».',
     'inputSchema': {'type': 'object', 'properties': {}}},
    {'name': 'obezl_read', 'handler': tool_read,
     'description': 'Прочитать обезличенный файл из «Обезличенные» постранично: Word — абзацы, Excel — строки в TSV (sheet — имя или номер листа), текст — строки.',
     'inputSchema': {'type': 'object', 'properties': {'path': {'type': 'string'}, 'sheet': {'type': ['string', 'integer']},
                                                      'offset': {'type': 'integer'}, 'limit': {'type': 'integer'}}, 'required': ['path']}},
    {'name': 'obezl_unmask', 'handler': tool_unmask,
     'description': 'Вернуть настоящие данные вместо меток [ФИО-1] в файл, который вы подготовили (.docx, .xlsx, .pptx, .md, .txt, .csv). '
                    'Результат кладётся в «С данными»; его содержимое вам не показывается.',
     'inputSchema': {'type': 'object', 'properties': {'path': {'type': 'string'}}, 'required': ['path']}},
    {'name': 'obezl_open_page', 'handler': tool_open_page,
     'description': 'Открыть страницу Обезличивателя для ручной работы (файл, текст, возврат данных по ключу).',
     'inputSchema': {'type': 'object', 'properties': {}}},
    {'name': 'obezl_status', 'handler': tool_status,
     'description': 'Состояние: папки, защита, сколько меток в ключе (без значений).',
     'inputSchema': {'type': 'object', 'properties': {}}},
]
TOOLS_BY_NAME = {t['name']: t for t in TOOLS}

# ───────────────────────── JSON-RPC по stdio ─────────────────────────

_out_lock = threading.Lock()
_running = []


def send(msg):
    data = json.dumps(msg, ensure_ascii=False)
    with _out_lock:
        sys.stdout.buffer.write((data + '\n').encode('utf-8'))   # байтами: на Windows консоль по умолчанию не UTF-8
        sys.stdout.buffer.flush()


def reply(req_id, result=None, error=None):
    msg = {'jsonrpc': '2.0', 'id': req_id}
    if error is not None:
        msg['error'] = error
    else:
        msg['result'] = result
    send(msg)


def run_tool(req_id, params):
    name = params.get('name')
    tool = TOOLS_BY_NAME.get(name)
    if not tool:
        reply(req_id, error={'code': -32602, 'message': 'Неизвестный инструмент: %s' % name})
        return
    try:
        result = tool['handler'](params.get('arguments') or {})
        text = result if isinstance(result, str) else json.dumps(result, ensure_ascii=False, indent=2)
        is_error = False
    except (ValueError, OSError) as e:
        text, is_error = str(e), True
    except Exception as e:  # noqa: BLE001
        log(traceback.format_exc())
        text, is_error = 'Внутренняя ошибка: %s' % e, True
    reply(req_id, {'content': [{'type': 'text', 'text': text}], 'isError': is_error})


def handle(msg):
    method, req_id = msg.get('method'), msg.get('id')
    if method is None or req_id is None:
        return
    params = msg.get('params') or {}
    if method == 'initialize':
        requested = params.get('protocolVersion')
        reply(req_id, {
            'protocolVersion': requested if requested in PROTOCOL_VERSIONS else PROTOCOL_VERSIONS[0],
            'capabilities': {'tools': {'listChanged': False}},
            'serverInfo': {'name': SERVER_NAME, 'version': VERSION},
            'instructions': INSTRUCTIONS,
        })
    elif method == 'ping':
        reply(req_id, {})
    elif method == 'tools/list':
        reply(req_id, {'tools': [{k: v for k, v in t.items() if k != 'handler'} for t in TOOLS]})
    elif method == 'tools/call':
        th = threading.Thread(target=run_tool, args=(req_id, params), daemon=True)
        _running.append(th)
        th.start()
    else:
        reply(req_id, error={'code': -32601, 'message': 'Method not found: %s' % method})


def serve_stdio():
    ensure_dirs()
    for raw in iter(sys.stdin.buffer.readline, b''):
        line = raw.decode('utf-8', errors='replace').strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except json.JSONDecodeError:
            send({'jsonrpc': '2.0', 'id': None, 'error': {'code': -32700, 'message': 'Parse error'}})
            continue
        for m in msg if isinstance(msg, list) else [msg]:
            if isinstance(m, dict):
                handle(m)
    # stdin закрыт: даём начатым инструментам ответить.
    for th in _running:
        th.join(timeout=30)


if __name__ == '__main__':
    # Ярлык на Windows запускает pythonw — без консоли, где stdout и stderr равны None.
    if sys.stdout is None or sys.stderr is None:
        sys.stdout = sys.stderr = open(os.devnull, 'w', encoding='utf-8')
    if '--app' in sys.argv:
        run_app()
    elif '--page' in sys.argv:
        # Открыть страницу без Claude: python3 server.py --page
        ensure_dirs()
        start_http()
        open_browser('http://127.0.0.1:%d/' % PORT)
        print('Страница: http://127.0.0.1:%d/ — Ctrl+C, чтобы остановить' % PORT)
        try:
            while True:
                time.sleep(3600)
        except KeyboardInterrupt:
            pass
    else:
        serve_stdio()
