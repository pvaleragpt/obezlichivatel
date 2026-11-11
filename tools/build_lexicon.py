#!/usr/bin/env python3
"""Собирает src/lexicon.js из словаря OpenCorpora (pymorphy2): какие слова, похожие на фамилии, — обычные.

    ~/obezlichivatel-mcp/.venv/bin/python tools/build_lexicon.py

1. Основы, которые никогда не бывают фамилией или именем: «корзин», «логин», «причин», «магазин».
2. Формы-омонимы, где обычное слово встречается чаще фамилии: «машина» (а не «Машина»).
   Притяжательные прилагательные («Иванова книга») обычными словами не считаются — иначе
   пропали бы фамилии Иванова и Петров.
"""
import collections
import inspect
import json
import re
from pathlib import Path

inspect.getargspec = lambda f: inspect.getfullargspec(f)[:4]   # pymorphy2 0.9 на Python 3.12
import pymorphy2                                                # noqa: E402
import pymorphy2_dicts_ru                                       # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
STRONG = re.compile(r'^[а-яе]{3,}(?:(?:ов|ев|ин|ын)(?:а|у|ым|ом|е|ой|ою|ых|ыми|ы)?|енко|(?:чук|щук|ук|юк)(?:а|у|ом|е)?|швили|дзе|(?:ян|янц)(?:а|у|ом|е)?)$')
# Частые слова интерфейсов и документов, где словарь считает фамилию более вероятной.
EXTRA = ['ширин', 'высотин', 'длин', 'сложн']


def skey(w):
    for rx in (r'^(.+?(?:ов|ев|ин|ын))(?:а|у|ым|ом|е|ой|ою|ых|ыми|ы)?$', r'^(.+?(?:ук|юк|ян|янц))(?:а|у|ом|е)?$'):
        m = re.match(rx, w)
        if m:
            return m.group(1)
    return w


def kind(t):
    if 'Surn' in t:
        return 'surn'
    if 'Name' in t:
        return 'name'
    if 'Patr' in t:
        return 'patr'
    if 'Geox' in t or 'Orgn' in t or 'Trad' in t:
        return 'geo'
    if 'Poss' in t:
        return 'poss'
    return 'common'


def main():
    m = pymorphy2.MorphAnalyzer(path=pymorphy2_dicts_ru.get_path())
    kinds = collections.defaultdict(set)
    for word, tag, *_ in m.dictionary.iter_known_words():
        w = word.replace('ё', 'е')
        if STRONG.match(w):
            kinds[w].add(kind(tag))
    stems = collections.defaultdict(list)
    for w in kinds:
        stems[skey(w)].append(w)
    pure = sorted(set(s for s, fs in stems.items()
                      if all('common' in kinds[f] and not ({'surn', 'name', 'patr'} & kinds[f]) for f in fs)) | set(EXTRA))
    homo = sorted(w for w, k in kinds.items() if 'common' in k and ({'surn', 'name'} & k) and kind(m.parse(w)[0].tag) == 'common')
    out = ROOT / 'src' / 'lexicon.js'
    out.write_text(
        '/* Создан tools/build_lexicon.py из словаря OpenCorpora. Не править вручную. */\n'
        'var Lexicon = {\n'
        '  commonStems: new Set(' + json.dumps('|'.join(pure), ensure_ascii=False) + '.split("|")),\n'
        '  commonForms: new Set(' + json.dumps('|'.join(homo), ensure_ascii=False) + '.split("|"))\n'
        '};\n', encoding='utf-8')
    print('%s: основ %d, омонимов %d, %d КБ' % (out, len(pure), len(homo), out.stat().st_size // 1024))


if __name__ == '__main__':
    main()
