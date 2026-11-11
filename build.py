#!/usr/bin/env python3
"""Собирает страницу в один файл (без внешних ссылок).

    python3 build.py                 → dist/Обезличиватель.html         — редакция для Claude (MCP, «Передать в Claude»)
    python3 build.py --edition local → dist/local/Обезличиватель.html   — только обезличивание, без Claude
"""
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
SRC = ROOT / "src"


def read(name: str) -> str:
    text = (SRC / name).read_text(encoding="utf-8")
    if "</script" in text.lower():
        raise SystemExit(f"{name}: в коде есть '</script' — сломает встраивание")
    return text


def vendor(name: str) -> str:
    text = (ROOT / "vendor" / "pdfjs" / name).read_text(encoding="utf-8")
    if "</script" in text.lower() or "<!--" in text:
        raise SystemExit(f"{name}: нельзя встроить в <script>")
    return text


def classic_worker(text: str) -> str:
    """Воркер pdf.js как обычный скрипт: модульные воркеры из blob: Safari не запускает на странице из файла.
    Из модульного в нём только import.meta.url (в декодерах картинок) и export в конце."""
    text = text.replace("import.meta.url", "self.location.href")
    text, n = re.subn(r"export\{[^}]*\};?\s*$", "", text)
    if n != 1 or re.search(r"(?:^|[;}])\s*(?:import\s*[{*\"']|export\s*[{*]|export\s+(?:const|let|var|function|class|default)\b)", text):
        raise SystemExit("pdf.worker.min.mjs: неожиданная структура модуля — проверьте classic_worker()")
    return text


# Редакция «без Claude»: тексты страницы, где упоминается Claude, — на нейтральные. Каждая замена обязана найтись.
LOCAL_TEXT = [
    ("Скрывает персональные данные перед отправкой в Claude", "Скрывает персональные данные в документах — прямо на этом компьютере"),
    (">Как увидит Claude<", ">Результат<"),
    ("Метки вроде [ФИО-1] в ответе Claude заменятся на настоящие значения.", "Метки вроде [ФИО-1] в тексте заменятся на настоящие значения."),
    ("<b>Ответ Claude</b>", "<b>Текст с метками</b>"),
    ("сама картинка в Claude не уходит", "сама картинка никуда не уходит"),
    ("'Скопируйте текст и отправьте в Claude.'", "'Скопируйте обезличенный текст.'"),
    ("(appMode ? 'Передайте файл в Claude или скачайте его. ' : 'Отправьте этот файл в Claude. ')", "'Скачайте обезличенный файл. '"),
]


def build(edition: str = "claude") -> Path:
    html = (SRC / "index.html").read_text(encoding="utf-8")
    worker = "\n".join(read(n) for n in ("lexicon.js", "engine.js", "zip.js", "office.js", "worker.js"))
    ui = read("engine.js") + "\n" + read("ui.js")   # словарь нужен только воркеру
    html = html.replace("/*CSS*/", read("styles.css")).replace("/*WORKER*/", worker).replace("/*UI*/", ui)
    # pdf.js (Mozilla, Apache-2.0) — только для текста из PDF; см. vendor/pdfjs/README.txt
    html = html.replace("/*PDFJS*/", vendor("pdf.min.mjs")).replace("/*PDFJS_WORKER*/", classic_worker(vendor("pdf.worker.min.mjs")))
    html = html.replace("/*EDITION*/", edition)
    if edition == "local":
        # Всё, что только для Claude (кнопка «Передать в Claude», режим Claude Code, общий ключ), вырезается целиком.
        html, n1 = re.subn(r"/\*CLAUDE\{\*/[\s\S]*?/\*\}CLAUDE\*/", "", html)
        html, n2 = re.subn(r"<!--CLAUDE\{-->[\s\S]*?<!--\}CLAUDE-->", "", html)
        if not n1 or not n2:
            raise SystemExit("редакция local: не нашлись метки CLAUDE")
        for old, new in LOCAL_TEXT:
            if old not in html:
                raise SystemExit(f"редакция local: не найдено «{old}»")
            html = html.replace(old, new)
    out = ROOT / "dist" / ("local" if edition == "local" else "") / "Обезличиватель.html"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(html, encoding="utf-8")
    return out


if __name__ == "__main__":
    path = build("local" if "--edition" in sys.argv and sys.argv[sys.argv.index("--edition") + 1] == "local" else "claude")
    print(f"{path} — {path.stat().st_size // 1024} КБ")
