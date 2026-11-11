#!/usr/bin/env python3
"""
Обезличиватель — поиск людей по смыслу (Natasha, локально, без интернета).

Запускается сервером один раз и живёт рядом с ним: читает JSON-строки из stdin,
отвечает JSON-строками в stdout.

    → {"id": 1, "texts": ["Согласовано с Петренко А. Н.", ...]}
    ← {"id": 1, "results": [[{"s": 13, "e": 26, "text": "Петренко А. Н.", "type": "ФИО"}], ...]}

Natasha (slovnet NER) обучена на новостях: людей находит хорошо, а «организации» в логах
и ТЗ путает с аббревиатурами (INFO, ЧТЗ, ЦОД). Поэтому берём только людей и отсекаем
одиночные служебные слова вроде «Исполнителя».
"""
import json
import re
import sys

from natasha import Doc, NewsEmbedding, NewsNERTagger, Segmenter

try:   # словарь OpenCorpora: отличить «Корзину» от «Корзинкиной»
    import inspect
    if not hasattr(inspect, 'getargspec'):
        inspect.getargspec = lambda f: inspect.getfullargspec(f)[:4]   # pymorphy2 0.9 на Python 3.11+
    import pymorphy2
    import pymorphy2_dicts_ru
    MORPH = pymorphy2.MorphAnalyzer(path=pymorphy2_dicts_ru.get_path())
except Exception:  # noqa: BLE001 — без словаря работаем как раньше
    MORPH = None


def personish(word):
    """Может ли слово быть частью ФИО: инициал, имя, фамилия, отчество или незнакомое словарю слово."""
    if MORPH is None or re.fullmatch(r'[А-ЯЁA-Z]\.', word) or not re.search('[а-яё]', word.lower()):
        return True
    parses = MORPH.parse(word.lower())
    if any(('Name' in p.tag or 'Surn' in p.tag or 'Patr' in p.tag) for p in parses):
        return True
    return all(not p.is_known for p in parses)

SEGMENTER = Segmenter()
TAGGER = NewsNERTagger(NewsEmbedding())

# Слова, которые Natasha иногда принимает за людей: роли из договоров и ТЗ.
NOT_PEOPLE = {
    'исполнитель', 'исполнителя', 'исполнителю', 'исполнителем', 'заказчик', 'заказчика', 'заказчику', 'заказчиком',
    'подрядчик', 'подрядчика', 'субподрядчик', 'поставщик', 'поставщика', 'покупатель', 'продавец', 'арендатор',
    'пользователь', 'пользователя', 'администратор', 'оператор', 'учитель', 'ученик', 'родитель', 'директор',
    'испытатель', 'председатель', 'комиссия', 'сторона', 'стороны', 'участник', 'получатель', 'отправитель',
    'бог', 'господь', 'вы', 'ты', 'он', 'она',
}
ROLES = {
    'директор', 'завуч', 'учитель', 'учительница', 'педагог', 'классный', 'руководитель', 'ученик', 'ученица', 'родитель',
    'мама', 'папа', 'сын', 'дочь', 'заявитель', 'гражданин', 'гражданка', 'специалист', 'сотрудник', 'инженер', 'аналитик',
    'менеджер', 'начальник', 'заместитель', 'председатель', 'секретарь', 'член', 'эксперт', 'испытатель', 'тестировщик',
    'уважаемый', 'уважаемая', 'господин', 'госпожа', 'коллега', 'товарищ',
}
WORD = re.compile(r'[А-ЯЁA-Z][а-яёa-z]+|[А-ЯЁA-Z]\.')


def keep(span_text):
    words = WORD.findall(span_text)
    if not words:
        return False
    if len(words) == 1:
        w = words[0].lower()
        if w in NOT_PEOPLE or len(w) < 3:
            return False
    if all(w.lower() in NOT_PEOPLE for w in words):
        return False
    return any(personish(w) for w in words)


def find(text):
    if not text or not re.search(r'[А-ЯЁ][а-яё]', text):
        return []
    doc = Doc(text)
    doc.segment(SEGMENTER)
    doc.tag_ner(TAGGER)
    out = []
    for span in doc.spans:
        if span.type != 'PER':
            continue
        s, e = trim(text, span.start, span.stop)
        if TERM_BEFORE.search(text[max(0, s - 40):s]):
            continue
        if e - s >= 3 and keep(text[s:e]):
            out.append({'s': s, 'e': e, 'text': text[s:e], 'type': 'ФИО'})
    return out


# Фамилия внутри термина: «диаграмма Ганта», «закон Парето», «критерий Пирсона», «по методу Монте-Карло».
TERM_BEFORE = re.compile(r'(?:диаграмм|график|закон|метод|критери|формул|теорем|принцип|тест|шкал|модел|распределени|коэффициент|'
                         r'эффект|правил|уравнени|цикл|матриц|индекс|алгоритм|схем|принцип|парадокс|постулат|число|числа|'
                         r'преобразовани|ряд|ряда|кривая|кривой|кривую|пирамид|окружност|спектр|фильтр)[а-яё]*\s+(?:по\s+)?$', re.I)
ROLE = re.compile(r'^(?:[А-ЯЁ][а-яё]+\s+)', re.U)


def trim(text, s, e):
    """Срезать должность в начале («Директор Королёв…») и лишние знаки в конце («Белов А. А..»)."""
    while True:
        m = ROLE.match(text[s:e])
        if not m or m.group(0).strip().lower() not in NOT_PEOPLE | ROLES:
            break
        s += len(m.group(0))
    while e > s and text[e - 1] in '.,;:)»"\'' and not re.search(r'(?:^|\s)[А-ЯЁA-Z]\.$', text[s:e]):
        e -= 1
    while e - 1 > s and text[e - 1] == '.' and text[e - 2] == '.':
        e -= 1
    return s, e


def main():
    for stream in (sys.stdin, sys.stdout):          # Windows по умолчанию читает каналы в cp1251
        stream.reconfigure(encoding='utf-8')
    sys.stdout.write(json.dumps({'ready': True}) + '\n')
    sys.stdout.flush()
    for line in sys.stdin:
        try:
            msg = json.loads(line)
            results = [find(t) for t in msg.get('texts') or []]
            reply = {'id': msg.get('id'), 'results': results}
        except Exception as e:  # noqa: BLE001 — ошибку отдаём серверу, процесс живёт дальше
            reply = {'id': None, 'error': str(e)}
        sys.stdout.write(json.dumps(reply, ensure_ascii=False) + '\n')
        sys.stdout.flush()


if __name__ == '__main__':
    main()
