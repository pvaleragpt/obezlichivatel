#!/usr/bin/env python3
"""Собирает два архива для раздачи.

    python3 tools/package.py
    → dist/Обезличиватель для Claude.zip   — коллегам: MCP для Claude Code, скилл, «Передать в Claude», установщики
    → dist/Обезличиватель без Claude.zip   — для рабочего компьютера: только обезличивание, без установки,
                                             глубокая проверка через уже установленную Ollama
Имена файлов в архиве — в UTF-8 с флагом (Windows распакует кириллицу правильно), у запускалок — право на запуск.
"""
import subprocess
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DIST = ROOT / 'dist'
STAMP = (2026, 11, 11, 12, 0, 0)

CLAUDE = {
    'README.md': 'docs/README-claude.md',
    'Техническое описание.md': 'README.md',
    'install.sh': 'install.sh',
    'install.cmd': 'install.cmd',
    'install.ps1': 'install.ps1',
    'Обезличиватель.html': 'dist/Обезличиватель.html',
    'mcp/server.py': 'mcp/server.py',
    'mcp/guard.py': 'mcp/guard.py',
    'mcp/ner_worker.py': 'mcp/ner_worker.py',
    'mcp/llm.py': 'mcp/llm.py',
    'mcp/install_hook.py': 'mcp/install_hook.py',
    'mcp/ocr.swift': 'mcp/ocr.swift',
    'mcp/ocr-macos': 'mcp/ocr-macos',
    'skill/obezlichivatel/SKILL.md': 'skill/obezlichivatel/SKILL.md',
    'launcher/icon.svg': 'launcher/icon.svg',
    'launcher/icon.ico': 'launcher/icon.ico',
    'launcher/make_launcher.sh': 'launcher/make_launcher.sh',
    'licenses/pdf.js — LICENSE.txt': 'vendor/pdfjs/LICENSE',
    'licenses/pdf.js — источник.txt': 'vendor/pdfjs/README.txt',
    'licenses/Сторонние компоненты.md': 'THIRD_PARTY_NOTICES.md',
}
LOCAL = {
    'README.md': 'docs/README-local.md',
    'Обезличиватель.html': 'dist/local/Обезличиватель.html',
    'Запустить на Mac.command': 'local/Запустить на Mac.command',
    'Запустить на Windows.cmd': 'local/Запустить на Windows.cmd',
    'local_server.py': 'mcp/local_server.py',
    'llm.py': 'mcp/llm.py',
    'ocr-macos': 'mcp/ocr-macos',
    'licenses/pdf.js — LICENSE.txt': 'vendor/pdfjs/LICENSE',
    'licenses/pdf.js — источник.txt': 'vendor/pdfjs/README.txt',
    'licenses/Сторонние компоненты.md': 'THIRD_PARTY_NOTICES.md',
}
EXECUTABLE = ('.sh', '.command', 'ocr-macos')


def pack(name, folder, files):
    out = DIST / name
    out.unlink(missing_ok=True)
    with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as z:
        for arc, src in files.items():
            data = (ROOT / src).read_bytes()
            zi = zipfile.ZipInfo(folder + '/' + arc, date_time=STAMP)
            zi.external_attr = (0o100755 if arc.endswith(EXECUTABLE) else 0o100644) << 16   # обычный файл + права
            zi.compress_type = zipfile.ZIP_DEFLATED
            z.writestr(zi, data)
    print('%s — %d файлов, %d КБ' % (out.relative_to(ROOT), len(files), out.stat().st_size // 1024))
    return out


def main():
    for args in ([], ['--edition', 'local']):
        subprocess.run([sys.executable, str(ROOT / 'build.py')] + args, check=True, stdout=subprocess.DEVNULL)
    local_page = (ROOT / 'dist/local/Обезличиватель.html').read_text(encoding='utf-8')
    if 'btnToClaude' in local_page or 'obezl_masked' in local_page:
        raise SystemExit('в редакции без Claude остались функции для Claude')
    pack('Обезличиватель для Claude.zip', 'Обезличиватель для Claude', CLAUDE)
    pack('Обезличиватель без Claude.zip', 'Обезличиватель без Claude', LOCAL)


if __name__ == '__main__':
    main()
