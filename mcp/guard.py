#!/usr/bin/env python3
"""
Обезличиватель — защитный хук Claude Code (PreToolUse).

Не даёт Claude прочитать папки с настоящими данными никаким способом, кроме
инструментов Обезличивателя: ни Read, ни Bash (cat, python, grep), ни Glob.

Код выхода 2 — вызов отклоняется, текст из stderr уходит Claude объяснением.
"""
import json
import os
import re
import sys
import unicodedata
from pathlib import Path

HOME = Path(os.environ.get('OBEZL_HOME') or Path.home() / 'Обезличиватель').expanduser()
PROTECTED = ['Сырые', 'С данными', '.ключи']
# Поля вызова, где бывают пути и команды. Содержимое записываемых файлов не проверяем.
FIELDS = {'file_path', 'path', 'paths', 'notebook_path', 'command', 'pattern', 'glob', 'cwd', 'directory',
          'dir', 'source', 'target', 'filename', 'file', 'files', 'url', 'app_path', 'out_dir', 'root'}


def norm(s):
    return unicodedata.normalize('NFC', s).casefold()


def slashes(s):
    """«С\\ данными» (экранированный пробел) → «С данными»; путь Windows C:\\Users\\… → C:/Users/…."""
    return s.replace('\\ ', ' ').replace('\\', '/')


def strings(obj, key=None):
    if isinstance(obj, str):
        if key in FIELDS:
            yield obj
    elif isinstance(obj, dict):
        for k, v in obj.items():
            yield from strings(v, k)
    elif isinstance(obj, list):
        for v in obj:
            yield from strings(v, key)


def main():
    try:
        data = json.load(sys.stdin)
    except Exception:  # noqa: BLE001 — непонятный вход не блокируем
        return 0
    tool = data.get('tool_name') or ''
    if tool.startswith('mcp__obezlichivatel__'):
        return 0
    cwd = slashes(norm(data.get('cwd') or ''))
    home = slashes(norm(str(HOME)))
    home_tilde = norm('~/' + HOME.name) if HOME.parent == Path.home() else None
    in_home = cwd.startswith(home)
    name = norm(HOME.name)
    for s in strings(data.get('tool_input') or {}):
        # Кавычки и экранирование пробелов не должны прятать путь: "С\ данными", '…/Сырые'.
        t = slashes(norm(s)).replace('"', '').replace("'", '')
        for folder in PROTECTED:
            f = norm(folder)
            # Папка как часть пути («Сырые/файл» или «…/Сырые»), а не просто слова в тексте команды.
            segment = re.search(r'(?:^|[\s=])' + re.escape(f) + r'/|/' + re.escape(f) + r'(?:/|\s|$)', t)
            # Изнутри рабочей папки хватает и голого имени: «ls Сырые».
            bare = in_home and re.search(r'(?:^|[\s=])' + re.escape(f) + r'(?:/|\s|$)', t)
            hits = (home + '/' + f) in t or (home_tilde and (home_tilde + '/' + f) in t) \
                or (name + '/' + f) in t or (segment and (name in t or in_home)) or bare
            if hits:
                sys.stderr.write(
                    'Обезличиватель: папка «%s» содержит настоящие персональные данные, читать её напрямую нельзя. '
                    'Используйте obezl_mask_file (обезличить файл) или obezl_unmask (вернуть данные). '
                    'С файлами из «Обезличенные» можно работать как обычно.' % folder)
                return 2
    return 0


if __name__ == '__main__':
    sys.exit(main())
