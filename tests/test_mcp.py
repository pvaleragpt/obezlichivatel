"""Тесты MCP-сервера и защитного хука: python3 -m unittest discover -s tests -v"""
import json
import os
import subprocess
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SERVER = ROOT / 'mcp' / 'server.py'
GUARD = ROOT / 'mcp' / 'guard.py'


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.home = Path(self.tmp.name) / 'Обезличиватель'
        for d in ('Сырые', 'Обезличенные', 'С данными', '.ключи'):
            (self.home / d).mkdir(parents=True)
        key = {'format': 'obezlichivatel-key', 'counters': {'ФИО': 1, 'ТЕЛЕФОН': 1},
               'tokens': {'[ФИО-1]': {'type': 'ФИО', 'value': 'Петрова Анна Сергеевна'},
                          '[ТЕЛЕФОН-1]': {'type': 'ТЕЛЕФОН', 'value': '8 916 555-12-34'},
                          '583091': {'type': 'ID', 'value': '17', 'pseudo': True}}, 'index': {}}
        (self.home / '.ключи' / 'ключ.json').write_text(json.dumps(key, ensure_ascii=False), encoding='utf-8')

    def tearDown(self):
        self.tmp.cleanup()


class GuardTest(Base):
    def run_guard(self, tool, inp, cwd='/tmp'):
        p = subprocess.run([sys.executable, str(GUARD)], input=json.dumps({'tool_name': tool, 'tool_input': inp, 'cwd': cwd}),
                           capture_output=True, text=True, env=dict(os.environ, OBEZL_HOME=str(self.home)))
        return p.returncode

    def test_blocks_raw(self):
        self.assertEqual(self.run_guard('Read', {'file_path': str(self.home / 'Сырые' / 'a.xlsx')}), 2)
        self.assertEqual(self.run_guard('Bash', {'command': 'cat "%s"' % (self.home / 'С данными' / 'x.md')}), 2)
        self.assertEqual(self.run_guard('Bash', {'command': 'ls .ключи'}, cwd=str(self.home)), 2)

    def test_path_tricks(self):
        name = self.home.name
        self.assertEqual(self.run_guard('Bash', {'command': 'cd ~/%s && cat Сырые/a.txt' % name}), 2)
        self.assertEqual(self.run_guard('Bash', {'command': 'ls "%s"/С\\ данными' % self.home}), 2)

    def test_windows_paths(self):
        name = self.home.name
        self.assertEqual(self.run_guard('Bash', {'command': 'type C:\\Users\\v\\%s\\Сырые\\a.docx' % name}), 2)
        self.assertEqual(self.run_guard('Bash', {'command': 'Get-Content "C:\\Users\\v\\%s\\.ключи\\k.json"' % name}), 2)
        self.assertEqual(self.run_guard('Bash', {'command': 'type C:\\Users\\v\\%s\\Обезличенные\\a.txt' % name}), 0)

    def test_text_mentions_allowed(self):
        cmd = "python3 - <<'EOF'\nprint('Обезличиватель не даёт читать «Сырые» и «С данными»: файлы с данными кладите в Сырые')\nEOF"
        self.assertEqual(self.run_guard('Bash', {'command': cmd}), 0)

    def test_allows_masked_and_own_tools(self):
        self.assertEqual(self.run_guard('Read', {'file_path': str(self.home / 'Обезличенные' / 'a.xlsx')}), 0)
        self.assertEqual(self.run_guard('Write', {'file_path': '/tmp/a.md', 'content': 'папка Сырые'}), 0)
        self.assertEqual(self.run_guard('mcp__obezlichivatel__obezl_mask_file', {'file': str(self.home / 'Сырые' / 'a')}), 0)


class ServerTest(Base):
    def call(self, *calls):
        msgs = [{'jsonrpc': '2.0', 'id': 0, 'method': 'initialize', 'params': {'protocolVersion': '2025-06-18'}}]
        for i, (name, args) in enumerate(calls, 1):
            msgs.append({'jsonrpc': '2.0', 'id': i, 'method': 'tools/call', 'params': {'name': name, 'arguments': args}})
        p = subprocess.run([sys.executable, str(SERVER)], input='\n'.join(json.dumps(m) for m in msgs) + '\n',
                           capture_output=True, text=True, timeout=30,
                           env=dict(os.environ, OBEZL_HOME=str(self.home), OBEZL_NO_BROWSER='1'))
        out = {}
        for line in p.stdout.splitlines():
            m = json.loads(line)
            out[m['id']] = m
        return out

    def test_tools_list_and_instructions(self):
        p = subprocess.run([sys.executable, str(SERVER)], capture_output=True, text=True, timeout=10,
                           input=json.dumps({'jsonrpc': '2.0', 'id': 1, 'method': 'initialize', 'params': {}}) + '\n' +
                           json.dumps({'jsonrpc': '2.0', 'id': 2, 'method': 'tools/list'}) + '\n',
                           env=dict(os.environ, OBEZL_HOME=str(self.home)))
        lines = [json.loads(x) for x in p.stdout.splitlines()]
        self.assertIn('НИКОГДА не читай', lines[0]['result']['instructions'])
        names = {t['name'] for t in lines[1]['result']['tools']}
        self.assertTrue({'obezl_mask_file', 'obezl_result', 'obezl_unmask', 'obezl_read'} <= names)

    def test_unmask_text_and_docx(self):
        src = Path(self.tmp.name) / 'отчёт.md'
        src.write_text('[ФИО-1] звонила с [ТЕЛЕФОН-1]; [ФИО-7] нет в ключе.', encoding='utf-8')
        docx = Path(self.tmp.name) / 'письмо.docx'
        with zipfile.ZipFile(docx, 'w') as z:
            z.writestr('word/document.xml', '<w:document><w:t>Уважаемая [ФИО-1]!</w:t></w:document>')
        out = self.call(('obezl_unmask', {'path': str(src)}), ('obezl_unmask', {'path': str(docx)}))
        self.assertIn('возвращено значений — 2', out[1]['result']['content'][0]['text'])
        self.assertNotIn('Петрова', out[1]['result']['content'][0]['text'])
        restored = (self.home / 'С данными' / 'отчёт (с данными).md').read_text(encoding='utf-8')
        self.assertEqual(restored, 'Петрова Анна Сергеевна звонила с 8 916 555-12-34; [ФИО-7] нет в ключе.')
        with zipfile.ZipFile(self.home / 'С данными' / 'письмо (с данными).docx') as z:
            self.assertIn('Уважаемая Петрова Анна Сергеевна!', z.read('word/document.xml').decode('utf-8'))

    def test_unmask_pseudo_ids(self):
        src = Path(self.tmp.name) / 'итог.csv'
        src.write_text('id;ученик\n583091;[ФИО-1]\n5830911;другой\n', encoding='utf-8')
        xlsx = Path(self.tmp.name) / 'итог.xlsx'
        with zipfile.ZipFile(xlsx, 'w') as z:
            z.writestr('xl/worksheets/sheet1.xml', '<sheetData><row r="1"><c r="A1"><v>583091</v></c><c r="B1" t="s"><v>583091</v></c></row></sheetData>')
            z.writestr('xl/sharedStrings.xml', '<sst><si><t>ID 583091</t></si></sst>')
        self.call(('obezl_unmask', {'path': str(src)}), ('obezl_unmask', {'path': str(xlsx)}))
        self.assertEqual((self.home / 'С данными' / 'итог (с данными).csv').read_text(encoding='utf-8'),
                         'id;ученик\n17;Петрова Анна Сергеевна\n5830911;другой\n')
        with zipfile.ZipFile(self.home / 'С данными' / 'итог (с данными).xlsx') as z:
            sheet = z.read('xl/worksheets/sheet1.xml').decode('utf-8')
            self.assertIn('<c r="A1"><v>17</v>', sheet)
            self.assertIn('t="s"><v>583091</v>', sheet)      # ссылка на общую строку не тронута
            self.assertIn('ID 17', z.read('xl/sharedStrings.xml').decode('utf-8'))

    def test_read_only_masked_folder(self):
        (self.home / 'Обезличенные' / 'a.txt').write_text('строка 1\n[ФИО-1]\n', encoding='utf-8')
        out = self.call(('obezl_read', {'path': 'a.txt'}), ('obezl_read', {'path': str(self.home / 'Сырые' / 'a.txt')}))
        self.assertIn('[ФИО-1]', out[1]['result']['content'][0]['text'])
        self.assertTrue(out[2]['result']['isError'])

    def test_mask_file_creates_job(self):
        (self.home / 'Сырые' / 'список.txt').write_text('Петрова Анна, 8 916 555-12-34', encoding='utf-8')
        out = self.call(('obezl_files', {}), ('obezl_mask_file', {'file': 1}))
        self.assertNotIn('список', out[1]['result']['content'][0]['text'])
        self.assertIn('http://127.0.0.1:', out[2]['result']['content'][0]['text'])


if __name__ == '__main__':
    unittest.main()
