"""Добавляет защитный хук Обезличивателя в ~/.claude/settings.json (для установщика Windows).

    python install_hook.py <путь к python> <путь к guard.py>
Прежние настройки сохраняются в settings.json.bak.
"""
import json
import sys
from pathlib import Path


def main():
    py, guard = sys.argv[1].replace('\\', '/'), sys.argv[2].replace('\\', '/')
    path = Path.home() / '.claude' / 'settings.json'
    path.parent.mkdir(exist_ok=True)
    try:
        data = json.loads(path.read_text(encoding='utf-8')) if path.exists() else {}
    except json.JSONDecodeError:
        print('  – settings.json повреждён, хук не добавлен')
        return
    if path.exists():
        path.with_suffix('.json.bak').write_text(path.read_text(encoding='utf-8'), encoding='utf-8')
    cmd = '"%s" "%s"' % (py, guard)
    hooks = data.setdefault('hooks', {}).setdefault('PreToolUse', [])
    hooks[:] = [h for h in hooks if not any('guard.py' in x.get('command', '') and 'obezlichivatel' in x.get('command', '')
                                            for x in h.get('hooks', []))]
    hooks.append({'matcher': '*', 'hooks': [{'type': 'command', 'command': cmd, 'timeout': 10}]})
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding='utf-8')
    print('  ✓ хук добавлен в %s (копия прежних настроек — settings.json.bak)' % path)


if __name__ == '__main__':
    main()
