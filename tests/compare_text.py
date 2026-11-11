#!/usr/bin/env python3
"""Текст исходного и восстановленного файла совпадает? Word, Excel, PowerPoint, текст.

    python3 tests/compare_text.py <исходный> <восстановленный>
Сравнивает видимый текст (абзацы, ячейки, слайды и заметки). Свойства файла (автор) при обезличивании
удаляются намеренно — их не сравниваем. Формы одного человека («Петрова А. С.», «Анна Петрова») получают одну
метку и возвращаются полным ФИО — так задумано, поэтому имена при сравнении сводятся к одному знаку.
"""
import html
import re
import sys
import zipfile

PARTS = re.compile(r'^(?:word/(?:document|header\d*|footer\d*|footnotes|endnotes|comments)\.xml|'
                   r'xl/(?:sharedStrings|worksheets/sheet\d+)\.xml|'
                   r'ppt/(?:slides/slide\d+|notesSlides/notesSlide\d+)\.xml)$')


NAME = re.compile(r'[А-ЯЁ][а-яё]+(?:-[А-ЯЁ][а-яё]+)?(?:(?:\s+[А-ЯЁ]\.){1,2}|(?:\s+[А-ЯЁ][а-яё]+(?:-[А-ЯЁ][а-яё]+)?){1,3})|(?:[А-ЯЁ]\.\s?){1,2}[А-ЯЁ][а-яё]+')


def norm(t):
    return re.sub(r'\.{2,}', '.', NAME.sub('Ф', t))


def texts(path):
    if not zipfile.is_zipfile(path):
        return open(path, encoding='utf-8-sig').read().splitlines()
    out = []
    with zipfile.ZipFile(path) as z:
        for name in sorted(n for n in z.namelist() if PARTS.match(n)):
            xml = z.read(name).decode('utf-8')
            for para in re.split(r'</(?:w:p|a:p|si|c)>', xml):
                t = ''.join(html.unescape(x) for x in re.findall(r'<(?:w:t|a:t|t)(?:\s[^>]*)?>([^<]*)</(?:w:t|a:t|t)>', para))
                t += ''.join(html.unescape(x) for x in re.findall(r'<v>([^<]*)</v>', para))
                if t.strip():
                    out.append(name + ': ' + t)
    return out


def main():
    a, b = [norm(x) for x in texts(sys.argv[1])], [norm(x) for x in texts(sys.argv[2])]
    diff = [(x, y) for x, y in zip(a, b) if x != y]
    if len(a) != len(b):
        print('Разное число абзацев: %d и %d' % (len(a), len(b)))
    for x, y in diff[:10]:
        print('было:  ', x[:160]); print('стало: ', y[:160])
    ok = not diff and len(a) == len(b)
    print('Текст совпадает: %d абзацев' % len(a) if ok else 'Расхождений: %d' % len(diff))
    sys.exit(0 if ok else 1)


if __name__ == '__main__':
    main()
