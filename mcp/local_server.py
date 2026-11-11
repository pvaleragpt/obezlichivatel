#!/usr/bin/env python3
"""
Обезличиватель — локальная редакция (без Claude). Только стандартная библиотека Python 3.8+.

Показывает страницу «Обезличиватель.html» из этой же папки по адресу http://127.0.0.1:47640/ и помогает ей:
  • глубокая проверка — ищет уже установленную Ollama на этом компьютере, запускает её и передаёт ей текст;
  • распознавание сканов и картинок — Apple Vision (только macOS, программа ocr-macos рядом).
Ничего не устанавливает, ничего не скачивает, никуда не отправляет данные, файлов и ключей не хранит.
Сервер слушает только 127.0.0.1 и сам закрывается через 2 часа без обращений.

    python3 local_server.py          — открыть страницу (уже запущен — просто открыть)
"""
import http.server
import json
import os
import subprocess
import sys
import tempfile
import threading
import time
import urllib.parse
import urllib.request
import webbrowser
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import llm as LLM  # noqa: E402

PORTS = [47640] + list(range(47641, 47650))
IDLE = 2 * 3600
LAST_SEEN = [time.time()]
PAGE_NAMES = ['Обезличиватель.html', 'obezlichivatel.html']


def page_path():
    for name in PAGE_NAMES:
        if (HERE / name).is_file():
            return HERE / name
    for p in HERE.glob('*.html'):
        return p
    return None


def ocr_binary():
    if sys.platform != 'darwin':
        return None
    p = HERE / 'ocr-macos'
    if not p.is_file():
        return None
    try:   # файл из скачанного архива помечен «из интернета» — macOS не даст его запустить
        subprocess.run(['xattr', '-d', 'com.apple.quarantine', str(p)], capture_output=True, timeout=10)
        os.chmod(p, 0o755)
    except Exception:  # noqa: BLE001
        pass
    return p if os.access(p, os.X_OK) else None


OCR = None


def ocr_image(data):
    if not OCR:
        raise RuntimeError('Распознавание доступно только на Mac')
    fd, path = tempfile.mkstemp(prefix='obezl-ocr-', suffix='.img')
    try:
        os.chmod(path, 0o600)
        with os.fdopen(fd, 'wb') as f:
            f.write(data)
        out = subprocess.run([str(OCR), path], capture_output=True, timeout=180)
        if out.returncode != 0:
            raise RuntimeError(out.stderr.decode('utf-8', 'replace').strip() or 'распознавание не удалось')
        return json.loads(out.stdout.decode('utf-8'))
    finally:
        try:
            os.unlink(path)
        except OSError:
            pass


class Handler(http.server.BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def log_message(self, *a):
        pass

    def _send(self, code, body=b'', ctype='text/plain; charset=utf-8'):
        self.send_response(code)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.end_headers()
        self.wfile.write(body)

    def _json(self, obj, code=200):
        return self._send(code, json.dumps(obj, ensure_ascii=False).encode('utf-8'), 'application/json; charset=utf-8')

    def do_GET(self):
        LAST_SEEN[0] = time.time()
        u = urllib.parse.urlparse(self.path)
        if u.path in ('/', '/index.html'):
            p = page_path()
            if not p:
                return self._send(404, 'Не найдена страница Обезличиватель.html рядом с local_server.py'.encode('utf-8'))
            return self._send(200, p.read_bytes(), 'text/html; charset=utf-8')
        if u.path == '/api/ping':
            return self._send(200, b'obezlichivatel-local')
        if u.path == '/api/ai/status':
            return self._json({'ner': False, 'llm': LLM.SETUP.status(), 'ocr': bool(OCR), 'edition': 'local'})
        return self._send(404)

    def do_POST(self):
        LAST_SEEN[0] = time.time()
        u = urllib.parse.urlparse(self.path)
        length = int(self.headers.get('Content-Length') or 0)
        # Свой заголовок: чужой сайт в браузере не сможет его поставить без разрешения.
        if self.headers.get('X-Obezl') != '1':
            return self._send(403)
        try:
            if u.path == '/api/ai/ollama/start':          # только запустить уже установленную Ollama
                LLM.SETUP.start(serve_only=True)
                return self._json(LLM.SETUP.status())
            if u.path == '/api/ai/llm':
                texts = json.loads(self.rfile.read(length).decode('utf-8')).get('texts') or []
                results, skipped = [], 0
                for t in texts:
                    try:
                        results += LLM.detect([str(t)])
                    except (TimeoutError, OSError) as e:
                        if 'timed out' not in str(e) and not isinstance(e, TimeoutError):
                            raise
                        results.append([])
                        skipped += 1
                return self._json({'results': results, 'skipped': skipped})
            if u.path == '/api/ai/review':
                items = json.loads(self.rfile.read(length).decode('utf-8')).get('items') or []
                try:
                    return self._json({'remove': LLM.review(items), 'skipped': 0})
                except (TimeoutError, OSError) as e:
                    if 'timed out' not in str(e) and not isinstance(e, TimeoutError):
                        raise
                    return self._json({'remove': [], 'skipped': 1})
            if u.path == '/api/ai/ocr':
                data = self.rfile.read(length) if 0 < length <= 80 * 1024 * 1024 else b''
                if not data:
                    return self._send(400, 'пустая или слишком большая картинка'.encode('utf-8'))
                return self._json(ocr_image(data))
        except Exception as e:  # noqa: BLE001
            return self._json({'error': str(e)}, 500)
        return self._send(404)


def main():
    global OCR
    if sys.stdout is None or sys.stderr is None:          # Windows: запуск через pythonw без консоли
        sys.stdout = sys.stderr = open(os.devnull, 'w', encoding='utf-8')
    for port in PORTS:                                      # уже запущен — просто открыть страницу
        try:
            if urllib.request.urlopen('http://127.0.0.1:%d/api/ping' % port, timeout=1).read() == b'obezlichivatel-local':
                webbrowser.open('http://127.0.0.1:%d/' % port)
                return
        except Exception:  # noqa: BLE001
            pass
    OCR = ocr_binary()
    srv = None
    for port in PORTS:
        try:
            srv = http.server.ThreadingHTTPServer(('127.0.0.1', port), Handler)
            break
        except OSError:
            continue
    if not srv:
        print('Не удалось занять порт 47640–47649')
        return
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    url = 'http://127.0.0.1:%d/' % srv.server_address[1]
    print('Обезличиватель: %s — окно можно закрыть, сервер закроется сам через 2 часа без работы' % url)
    if not os.environ.get('OBEZL_NO_BROWSER'):
        webbrowser.open(url)
    while time.time() - LAST_SEEN[0] < IDLE:
        time.sleep(30)


if __name__ == '__main__':
    main()
