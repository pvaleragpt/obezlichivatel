#!/usr/bin/env python3
"""Синтетические файлы для проверки: все люди и номера выдуманы.

    python3 tests/make_samples.py <папка> [строк в Excel]

Создаёт:
  обращения.xlsx — выгрузка обращений: заголовок над таблицей, ФИО, телефоны (часть — числами),
                   почта, СНИЛС, дата рождения (числом Excel), школа, свободный текст с именами;
  справка.docx   — документ: имя разрезано между прогонами, таблица, колонтитул, комментарий,
                   исправление с автором, автор в свойствах файла;
  встреча.txt    — кусок расшифровки.
"""
import random
import sys
import zipfile
from pathlib import Path
from xml.sax.saxutils import escape

random.seed(7)
SURN_M = "Иванов Петров Сидоров Смирнов Кузнецов Попов Васильев Соколов Михайлов Новиков Фёдоров Морозов Волков Алексеев Лебедев Семёнов Егоров Павлов Козлов Степанов Николаев Орлов Андреев Макаров Никитин Захаров Зайцев Соловьёв Борисов Яковлев Григорьев Романов Воробьёв Сергеев Фролов Александров Дмитриев Королёв Гусев Киселёв Ильин Максимов Поляков Сорокин Виноградов Ковалёв Белов Медведев Антонов Тарасов Жуков Баранов Филиппов Комаров Давыдов Беляев Герасимов Богданов Осипов Сидоренко Ковальчук Шевчук Гогиашвили Петросян Ахмедов Галиев Ким".split()
NAMES_M = "Александр Алексей Андрей Артём Владимир Дмитрий Евгений Иван Игорь Илья Кирилл Максим Михаил Никита Николай Олег Павел Роман Сергей Тимур Рустам Ильдар".split()
NAMES_F = "Анна Анастасия Валентина Виктория Дарья Екатерина Елена Ирина Ксения Мария Наталья Ольга Полина Светлана Татьяна Юлия Алсу Гульнара".split()
PATR = "Александров Алексеев Андреев Викторов Дмитриев Иванов Игорев Михайлов Николаев Олегов Петров Сергеев Юрьев".split()


def person():
    s = random.choice(SURN_M)
    female = random.random() < 0.6
    n = random.choice(NAMES_F if female else NAMES_M)
    p = random.choice(PATR)
    if s.endswith(("ов", "ев", "ёв", "ин")) and female:
        s += "а"
    return s, n, p + ("на" if female else "ич"), female


def fio():
    s, n, p, _ = person()
    return f"{s} {n} {p}"


def snils():
    while True:
        d = [random.randint(0, 9) for _ in range(9)]
        total = sum(x * (9 - i) for i, x in enumerate(d))
        c = total if total < 100 else (0 if total in (100, 101) else total % 101)
        if c == 100:
            c = 0
        if c < 100:
            s = "".join(map(str, d))
            return f"{s[:3]}-{s[3:6]}-{s[6:9]} {c:02d}"


def phone():
    return f"+7 (9{random.randint(10, 99)}) {random.randint(100, 999)}-{random.randint(10, 99)}-{random.randint(10, 99)}"


TEXTS = [
    "Прошу разобраться: учитель {t} не выставила оценки за четверть. Мой сын {c} учится в 7Б.",
    "Добрый день! Ребёнок {c} не видит домашние задания в дневнике. Связаться можно по номеру {ph}.",
    "Классный руководитель {t} не отвечает на сообщения уже неделю.",
    "Не приходят уведомления. Проверьте, пожалуйста. С уважением, {p}.",
    "Вопрос по записи в кружок. Пишите на {mail}.",
    "Оценки появились, вопрос решён, спасибо!",
    "Директор {t} просит добавить второго родителя в доступ к дневнику.",
]


def cell_ref(col, row):
    s, c = "", col + 1
    while c:
        c, r = divmod(c - 1, 26)
        s = chr(65 + r) + s
    return f"{s}{row}"


def make_xlsx(path: Path, rows: int):
    sst, sst_idx = [], {}

    def si(text):
        if text not in sst_idx:
            sst_idx[text] = len(sst)
            sst.append(text)
        return sst_idx[text]

    header = ["№", "Дата обращения", "ФИО заявителя", "Телефон", "Электронная почта", "СНИЛС", "Дата рождения ребёнка",
              "Регион", "Образовательная организация", "Текст обращения", "Статус", "ID ученика", "Логин"]
    regions = ["Краснодарский край", "Челябинская область", "Ростовская область", "Свердловская область"]
    schools = ["МБОУ «СОШ № 5»", "МАОУ «Лицей № 12»", "МБОУ «Гимназия № 3»", "МБОУ «ООШ № 41»"]
    out_rows = []
    out_rows.append(f'<row r="1"><c r="A1" t="s"><v>{si("Выгрузка обращений из ПОС за сентябрь 2026")}</v></c></row>')
    out_rows.append('<row r="2">' + "".join(f'<c r="{cell_ref(i, 2)}" t="s" s="1"><v>{si(h)}</v></c>' for i, h in enumerate(header)) + "</row>")
    for k in range(rows):
        r = k + 3
        s, n, p, fem = person()
        ph = phone()
        mail = f"user{random.randint(1000, 99999)}@mail.ru"
        t = fio()
        child = random.choice(NAMES_F + NAMES_M) + " " + random.choice(SURN_M)
        text = random.choice(TEXTS).format(t=t, c=child, ph=phone(), p=f"{s} {n[0]}. {p[0]}.", mail=f"parent{k}@yandex.ru")
        cells = [
            f'<c r="{cell_ref(0, r)}"><v>{k + 1}</v></c>',
            f'<c r="{cell_ref(1, r)}" s="2"><v>{46270 + k % 30}</v></c>',
            f'<c r="{cell_ref(2, r)}" t="s"><v>{si(f"{s} {n} {p}")}</v></c>',
            (f'<c r="{cell_ref(3, r)}"><v>7{ph[4:7]}{ph[9:12]}{ph[13:15]}{ph[16:18]}</v></c>' if k % 3 == 0
             else f'<c r="{cell_ref(3, r)}" t="s"><v>{si(ph)}</v></c>'),
            f'<c r="{cell_ref(4, r)}" t="s"><v>{si(mail)}</v></c>',
            f'<c r="{cell_ref(5, r)}" t="inlineStr"><is><t>{snils()}</t></is></c>',
            f'<c r="{cell_ref(6, r)}" s="2"><v>{40000 + random.randint(0, 3000)}</v></c>',
            f'<c r="{cell_ref(7, r)}" t="s"><v>{si(random.choice(regions))}</v></c>',
            f'<c r="{cell_ref(8, r)}" t="s"><v>{si(random.choice(schools))}</v></c>',
            f'<c r="{cell_ref(9, r)}" t="s"><v>{si(text)}</v></c>',
            f'<c r="{cell_ref(10, r)}" t="s"><v>{si(random.choice(["Решено", "В работе", "Новое"]))}</v></c>',
            f'<c r="{cell_ref(11, r)}"><v>{k % 500 + 1}</v></c>',
            f'<c r="{cell_ref(12, r)}" t="s"><v>{si(f"user_{k % 500 + 1:04d}")}</v></c>',
        ]
        out_rows.append(f'<row r="{r}">' + "".join(cells) + "</row>")
    sheet = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
             '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
             'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
             '<cols><col min="3" max="3" width="34" customWidth="1"/><col min="10" max="10" width="60" customWidth="1"/></cols>'
             '<sheetData>' + "".join(out_rows) + '</sheetData><mergeCells count="1"><mergeCell ref="A1:K1"/></mergeCells></worksheet>')
    sst_xml = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
               f'<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="{len(sst)}" uniqueCount="{len(sst)}">'
               + "".join(f'<si><t xml:space="preserve">{escape(x)}</t></si>' for x in sst) + "</sst>")
    styles = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
              '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
              '<numFmts count="1"><numFmt numFmtId="164" formatCode="dd.mm.yyyy"/></numFmts>'
              '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>'
              '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>'
              '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>'
              '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
              '<cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'
              '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>'
              '<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs></styleSheet>')
    files = {
        "[Content_Types].xml": '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
            '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>'
            '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
            '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
            '<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>'
            '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
            '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>',
        "_rels/.rels": '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>'
            '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>',
        "docProps/core.xml": '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" '
            'xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:creator>Морозова Ирина Викторовна</dc:creator><cp:lastModifiedBy>Морозова Ирина Викторовна</cp:lastModifiedBy></cp:coreProperties>',
        "xl/workbook.xml": '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
            'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Обращения" sheetId="1" r:id="rId1"/></sheets></workbook>',
        "xl/_rels/workbook.xml.rels": '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>'
            '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>'
            '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>',
        "xl/worksheets/sheet1.xml": sheet,
        "xl/sharedStrings.xml": sst_xml,
        "xl/styles.xml": styles,
    }
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        for name, data in files.items():
            z.writestr(name, data)


def make_docx(path: Path):
    W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"'

    def p(*runs):
        return "<w:p>" + "".join(runs) + "</w:p>"

    def r(text, bold=False):
        rpr = "<w:rPr><w:b/></w:rPr>" if bold else ""
        return f'<w:r>{rpr}<w:t xml:space="preserve">{escape(text)}</w:t></w:r>'

    paras = [
        p(r("Справка по обращению", True)),
        # Имя разрезано на два прогона — так бывает после правок и проверки орфографии.
        p(r("Заявитель: Пет"), r("рова Анна Серге", True), r("евна, тел. 8 916 555-12-34.")),
        p(r("Учитель Тагир Рустамович Ахмедов сообщил, что Петрова А. С. обращалась ранее. Адрес: г. Тула, ул. Ленина, д. 5, кв. 12.")),
        p(r("СНИЛС ребёнка 112-233-445 95, дата рождения 12.03.2014. Ребёнок учится в МБОУ «СОШ № 5»."),
          '<w:commentRangeStart w:id="0"/>', r(" Проверено."), '<w:commentRangeEnd w:id="0"/>',
          '<w:r><w:commentReference w:id="0"/></w:r>'),
        p('<w:ins w:id="1" w:author="Сидоров Олег Николаевич" w:date="2026-10-10T10:00:00Z">', r("Повторно позвонила Анна в 15:30."), '</w:ins>'),
        p(r("Вопросов больше нет. Машина для выезда не нужна. Срок ответа — 25.10.2026.")),
        "<w:tbl><w:tr><w:tc>" + p(r("Ответственный")) + "</w:tc><w:tc>" + p(r("Кузнецова Мария Олеговна")) + "</w:tc></w:tr>"
        "<w:tr><w:tc>" + p(r("Почта")) + "</w:tc><w:tc>" + p(r("m.kuznetsova@school5.ru")) + "</w:tc></w:tr></w:tbl>",
    ]
    for k in range(200):
        s, n, pt, _ = person()
        paras.append(p(r(f"{k + 1}. {s} {n} {pt} — телефон {phone()}, ученик {random.choice(NAMES_M)} {random.choice(SURN_M)}.")))
    doc = f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:document {W}><w:body>' + "".join(paras) + '<w:sectPr><w:headerReference w:type="default" r:id="rId2"/></w:sectPr></w:body></w:document>'
    files = {
        "[Content_Types].xml": '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
            '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>'
            '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
            '<Override PartName="/word/comments.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml"/>'
            '<Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/>'
            '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>',
        "_rels/.rels": '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>'
            '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>',
        "word/_rels/document.xml.rels": '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments" Target="comments.xml"/>'
            '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/>'
            '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="mailto:m.kuznetsova@school5.ru" TargetMode="External"/></Relationships>',
        "word/document.xml": doc,
        "word/comments.xml": f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:comments {W}><w:comment w:id="0" w:author="Морозова Ирина" w:initials="МИ">'
            + p(r("Уточнить у Петровой номер СНИЛС")) + "</w:comment></w:comments>",
        "word/header1.xml": f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:hdr {W}>' + p(r("Исполнитель: Морозова И. В., тел. 8 (4872) 55-12-34")) + "</w:hdr>",
        "docProps/core.xml": '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" '
            'xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:creator>Морозова Ирина Викторовна</dc:creator><cp:lastModifiedBy>Сидоров О. Н.</cp:lastModifiedBy></cp:coreProperties>',
    }
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        for name, data in files.items():
            z.writestr(name, data)


def make_log(path: Path):
    lines = []
    for k in range(50):
        sid = k % 7 + 1
        lines.append(f'2026-10-17T10:{k:02d}:00Z INFO api request userId={1000023336100 + sid} studentId={sid} '
                     f'login=user_{sid:04d} ip=10.0.{sid}.{k} token=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ7c2lkfSJ9.sig{k:05d}abc')
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def make_txt(path: Path):
    path.write_text(
        "[00:00] Морозова Ирина: Коллеги, по обращению Петровой Анны Сергеевны — она звонила снова.\n"
        "[00:12] Олег: Да, я видел. Её телефон 8 916 555-12-34, СНИЛС ребёнка у меня есть.\n"
        "[00:25] Морозова Ирина: Пусть Тагир Рустамович ей перезвонит до пятницы.\n", encoding="utf-8")


if __name__ == "__main__":
    out = Path(sys.argv[1] if len(sys.argv) > 1 else "samples")
    rows = int(sys.argv[2]) if len(sys.argv) > 2 else 2000
    out.mkdir(parents=True, exist_ok=True)
    make_xlsx(out / "обращения.xlsx", rows)
    make_docx(out / "справка.docx")
    make_txt(out / "встреча.txt")
    make_log(out / "api.log")
    for f in sorted(out.iterdir()):
        print(f"{f.name}: {f.stat().st_size // 1024} КБ")
