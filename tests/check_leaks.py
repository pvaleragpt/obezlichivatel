#!/usr/bin/env python3
"""Проверка обезличенного файла: какие значения из списка ожиданий остались видны.

    python3 tests/check_leaks.py <обезличенный.docx|xlsx|txt> <ожидания.json>
"""
import json
import re
import sys
import zipfile
from collections import Counter

KEEP = ['[INFO]', '[ERROR]', 'Healthcheck OK latency=12ms', 'Cache miss key=session', '2026-10-01 00:', 'HTTP/1.1', 'Конец набора',
        'Журнал в JSON Lines', 'Реестр сотрудников', 'Дата рождения', 'Паспорт', 'Телефон']


def text_of(path):
    if path.endswith('.docx'):
        xml = zipfile.ZipFile(path).read('word/document.xml').decode('utf-8')
        xml = re.sub(r'<w:(?:br|cr)\b[^>]*/>', '\n', xml)
        xml = re.sub(r'</w:p>', '\n', xml)
        t = re.sub(r'<[^>]+>', '', xml)
        return t.replace('&lt;', '<').replace('&gt;', '>').replace('&quot;', '"').replace('&amp;', '&')
    return open(path, encoding='utf-8', errors='replace').read()


def kind(v):
    if re.fullmatch(r'[\d\s()+\-№]+', v):
        return 'номер'
    if '@' in v:
        return 'почта'
    if re.search(r'\d', v) and re.search(r'[А-Яа-я]', v):
        return 'адрес/дата/госномер'
    return 'ФИО/текст'


def main():
    text = text_of(sys.argv[1])
    must = json.load(open(sys.argv[2]))
    leaks = [v for v in must if v in text]
    print(f'Скрыто {len(must) - len(leaks)} из {len(must)} ({100 * (len(must) - len(leaks)) // len(must)}%)')
    for k, n in Counter(kind(v) for v in leaks).most_common():
        print(f'  утекло {k}: {n}')
    for v in leaks[:40]:
        i = text.find(v)
        line = text[max(0, text.rfind('\n', 0, i) + 1): text.find('\n', i)]
        print(f'  «{v}»  ←  {line[:150]}')
    lost = [k for k in KEEP if k not in text]
    print('Лишнее скрыто: ' + (', '.join(lost) if lost else 'нет'))
    sys.exit(1 if leaks or lost else 0)


if __name__ == '__main__':
    main()
