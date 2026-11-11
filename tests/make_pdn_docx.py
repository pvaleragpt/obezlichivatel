#!/usr/bin/env python3
"""Тестовый Word с ПДн в разных форматах (как в реальных выгрузках) и список того, что обязано скрыться.

    python3 tests/make_pdn_docx.py <файл.docx> <ожидания.json> [строк лога]

Разделы: журнал приложения одним абзацем с мягкими переносами, JSON Lines, access log + key=value,
реестр сотрудников таблицей Word. Все данные выдуманы, контрольные суммы СНИЛС, ИНН, карт корректны.
"""
import json
import random
import sys
import zipfile
from xml.sax.saxutils import escape

random.seed(42)
SURN = 'Иванов Петров Сидоров Кузнецов Смирнов Попов Морозов Волков Соловьёв Лебедев Козлов Новиков Орлов Белов Тарасов Шевчук Бондаренко Ким Цой Гусейнов'.split()
NAMES_M = 'Иван Пётр Алексей Дмитрий Сергей Андрей Олег Тимур Рустам Вано'.split()
NAMES_F = 'Анна Мария Елена Ольга Наталья Ирина Дарья Алсу Лейла Ксения'.split()
PATR = 'Иванов Петров Сергеев Алексеев Олегов Андреев'.split()
CITIES = ['Москва', 'Казань', 'Самара', 'Воронеж', 'Екатеринбург', 'Краснодар', 'Нижний Новгород', 'Санкт-Петербург']
MONTHS = 'января февраля марта апреля мая июня июля августа сентября октября ноября декабря'.split()
must = set()


def keep(v):
    must.add(v)
    return v


def fio(fmt=None):
    female = random.random() < .5
    s = random.choice(SURN)
    if female and s.endswith(('ов', 'ев', 'ёв', 'ин')):
        s += 'а'
    n = random.choice(NAMES_F if female else NAMES_M)
    p = random.choice(PATR) + ('на' if female else 'ич')
    f = fmt or random.choice(['full', 'short', 'two'])
    return {'full': f'{s} {n} {p}', 'short': f'{s} {n[0]}. {p[0]}.', 'two': f'{n} {s}'}[f]


def snils():
    while True:
        d = [random.randint(0, 9) for _ in range(9)]
        sm = sum(x * (9 - i) for i, x in enumerate(d))
        c = sm if sm < 100 else (0 if sm in (100, 101) else sm % 101)
        if c < 100:
            s = ''.join(map(str, d))
            return random.choice([f'{s[:3]}-{s[3:6]}-{s[6:]} {c:02d}', f'{s}{c:02d}'])


def inn():
    if random.random() < .5:
        d = [random.randint(0, 9) for _ in range(9)]
        k = sum(w * x for w, x in zip([2, 4, 10, 3, 5, 9, 4, 6, 8], d)) % 11 % 10
        return ''.join(map(str, d + [k]))
    d = [random.randint(0, 9) for _ in range(10)]
    k1 = sum(w * x for w, x in zip([7, 2, 4, 10, 3, 5, 9, 4, 6, 8], d)) % 11 % 10
    d.append(k1)
    k2 = sum(w * x for w, x in zip([3, 7, 2, 4, 10, 3, 5, 9, 4, 6, 8], d)) % 11 % 10
    return ''.join(map(str, d + [k2]))


def phone():
    a, b, c, e = random.randint(900, 999), random.randint(100, 999), random.randint(10, 99), random.randint(10, 99)
    return random.choice([f'+7 ({a}) {b}-{c}-{e}', f'8 {a} {b} {c} {e}', f'({a}){b}-{c}{e}', f'+7{a}{b}{c}{e}', f'8-{a}-{b}-{c}-{e}'])


def passport():
    s, n = random.randint(1000, 9999), random.randint(100000, 999999)
    return random.choice([f'{str(s)[:2]} {str(s)[2:]} №{n}', f'{s} {n}', f'{s}{n}'])


def dob():
    y, m, d = random.randint(1950, 2012), random.randint(1, 12), random.randint(1, 28)
    return random.choice([f'{d:02d}.{m:02d}.{y}', f'{d:02d}/{m:02d}/{y}', f'{y}-{m:02d}-{d:02d}', f'{d} {MONTHS[m - 1]} {y} г.'])


def address():
    city, h, f = random.choice(CITIES), random.randint(1, 120), random.randint(1, 250)
    street = random.choice(['ул. Ленина', 'Садовая ул.', 'Цветной б-р', 'пр-т Мира', 'Лесной пер.'])
    return random.choice([f'г. {city}, {street}, д. {h}, кв. {f}', f'{random.randint(100000, 999999)}, {city}, {street} {h}-{f}',
                          f'{city}, {street}, д. {h}'])


def card():
    d = [4] + [random.randint(0, 9) for _ in range(14)]
    for k in range(10):
        s = d + [k]
        t = sum((x * 2 - 9 if x * 2 > 9 else x * 2) if i % 2 == len(s) % 2 else x for i, x in enumerate(s))
        if t % 10 == 0:
            n = ''.join(map(str, s))
            return f'{n[:4]} {n[4:8]} {n[8:12]} {n[12:]}'


def email():
    return f'{random.choice(["user", "ivan", "a.petrova", "test"])}{random.randint(1, 9999)}@{random.choice(["mail.ru", "yandex.ru", "gmail.com"])}'


def ip():
    return f'{random.randint(11, 220)}.{random.randint(0, 255)}.{random.randint(0, 255)}.{random.randint(1, 254)}'


def log_line(i):
    ts = f'2026-10-01 {i // 3600 % 24:02d}:{i // 60 % 60:02d}:{i % 60:02d},{random.randint(0, 999):03d}'
    lvl, mod = random.choice(['INFO', 'WARN', 'ERROR', 'DEBUG']), random.choice(['auth', 'sms', 'pay', 'orders', 'profile'])
    kind = random.randrange(12)
    if kind == 0:
        msg = f'SMS отправлено на {keep(phone())}'
    elif kind == 1:
        msg = f"User login ok: fio='{keep(fio())}' phone={keep(phone())} ip={keep(ip())}"
    elif kind == 2:
        msg = f'Validation failed: snils={keep(snils())} inn={keep(inn())}'
    elif kind == 3:
        msg = f'Доставка по адресу: {keep(address())}; получатель {keep(fio())}'
    elif kind == 4:
        msg = f'Polis OMS {keep(str(random.randint(10 ** 15, 10 ** 16 - 1)))} verified'
    elif kind == 5:
        msg = f'Перевод на счёт {keep("40817810" + str(random.randint(10 ** 11, 10 ** 12 - 1)))} от {keep(fio())}'
    elif kind == 6:
        msg = f'Создан заказ для {keep(fio())}, СНИЛС {keep(snils())}'
    elif kind == 7:
        msg = f'Payment card={keep(card())} status=DECLINED email={keep(email())}'
    elif kind == 8:
        msg = f'Обновлён профиль: паспорт {keep(passport())}, д.р. {keep(dob())}'
    elif kind == 9:
        plate = random.choice('АВЕКМНОРСТУХ') + str(random.randint(100, 999)) + random.choice('АВЕКМНОРСТУХ') + random.choice('АВЕКМНОРСТУХ') + str(random.randint(10, 199))
        msg = f'Пропуск авто {keep(plate)} владелец тел.{keep(phone())}'
    elif kind == 10:
        msg = 'Cache miss key=session:8f3a21'
    else:
        msg = 'Healthcheck OK latency=12ms'
    return f'{ts} [{lvl}] [{mod}] {msg}'


def json_line(i):
    return json.dumps({'ts': f'2026-10-01T00:{i % 60:02d}:00Z', 'level': random.choice(['info', 'error']),
                       'user': {'name': keep(fio('full')), 'phone': keep(phone()), 'email': keep(email())},
                       'doc': {'snils': keep(snils()), 'inn': keep(inn())}, 'client_ip': keep(ip())}, ensure_ascii=False)


def access_line(i):
    ph = keep(phone())
    q = ph.replace(' ', '%20').replace('(', '%28').replace(')', '%29').replace('+', '%2B')
    return (f'{keep(ip())} - - [01/Oct/2026:00:{i % 60:02d}:11 +0300] "GET /api/v1/register?phone={q}&snils={keep(snils())} HTTP/1.1" 200 {random.randint(100, 9999)}'
            f'event=register fio="{keep(fio())}" email={keep(email())} passport="{keep(passport())}" dob="{keep(dob())}"')


def main():
    out, exp = sys.argv[1], sys.argv[2]
    n = int(sys.argv[3]) if len(sys.argv) > 3 else 300
    W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'

    def p(text):
        return '<w:p><w:r><w:t xml:space="preserve">%s</w:t></w:r></w:p>' % escape(text)

    def p_lines(lines):   # одним абзацем с мягкими переносами, как при вставке лога в Word
        runs = '<w:r><w:br w:type="textWrapping"/></w:r>'.join('<w:r><w:t xml:space="preserve">%s</w:t></w:r>' % escape(l) for l in lines)
        return '<w:p>' + runs + '</w:p>'

    def row(cells):
        return '<w:tr>' + ''.join('<w:tc><w:tcPr><w:tcW w:w="1200" w:type="dxa"/></w:tcPr>' + p(c) + '</w:tc>' for c in cells) + '</w:tr>'

    body = [p('Тестовый набор для проверки обезличивания ПДн'), p('1. Журнал приложения (text log)'),
            p_lines([log_line(i) for i in range(n)]), p('2. Журнал в JSON Lines'), p_lines([json_line(i) for i in range(n // 3)]),
            p('3. Access log и key=value'), p_lines([access_line(i) for i in range(n // 3)]), p('4. Реестр сотрудников (таблица Word)')]
    rows = [row(['№', 'ФИО', 'Дата рождения', 'СНИЛС', 'ИНН', 'Паспорт', 'Телефон', 'E-mail', 'Адрес'])]
    for i in range(1, 41):
        rows.append(row([str(i), keep(fio('full')), keep(dob()), keep(snils()), keep(inn()), keep(passport()), keep(phone()), keep(email()), keep(address())]))
    body.append('<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/></w:tblPr>' + ''.join(rows) + '</w:tbl>')
    body.append(p('Конец набора.'))
    doc = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document %s><w:body>%s</w:body></w:document>' % (W, ''.join(body))
    with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as z:
        z.writestr('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>')
        z.writestr('_rels/.rels', '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>')
        z.writestr('word/document.xml', doc)
    json.dump(sorted(must), open(exp, 'w'), ensure_ascii=False, indent=0)
    print(f'{out}: значений, которые обязаны скрыться: {len(must)}')


if __name__ == '__main__':
    main()
