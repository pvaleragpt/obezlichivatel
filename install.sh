#!/usr/bin/env bash
# Установка Обезличивателя: страница, MCP-сервер для Claude Code и защитный хук.
# Запуск из распакованной папки:  bash install.sh [папка-установки]
# По умолчанию ставит в ~/obezlichivatel-mcp, рабочие папки — ~/Обезличиватель. macOS и Linux.
set -euo pipefail

SRC="$(cd "$(dirname "$0")" && pwd)"
DEST="${1:-$HOME/obezlichivatel-mcp}"
DATA="${OBEZL_HOME:-$HOME/Обезличиватель}"

say()  { printf '\n\033[1m%s\033[0m\n' "$*"; }
ok()   { printf '  ✓ %s\n' "$*"; }
skip() { printf '  – %s\n' "$*"; }

say "1/8 Python"
PY="$(command -v python3 || true)"
if [ -z "$PY" ]; then echo "  Не найден python3. Установите Python 3.8+ и запустите снова." >&2; exit 1; fi
"$PY" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 8) else 1)' || { echo "  Нужен Python 3.8+" >&2; exit 1; }
ok "$("$PY" --version 2>&1)"

say "2/8 Файлы → $DEST"
mkdir -p "$DEST"
PAGE="$SRC/dist/Обезличиватель.html"
[ -f "$PAGE" ] || PAGE="$SRC/Обезличиватель.html"
if [ ! -f "$PAGE" ] && [ -f "$SRC/build.py" ]; then "$PY" "$SRC/build.py" >/dev/null; PAGE="$SRC/dist/Обезличиватель.html"; fi
cp "$SRC/mcp/server.py" "$SRC/mcp/guard.py" "$SRC/mcp/ner_worker.py" "$SRC/mcp/llm.py" "$SRC/mcp/install_hook.py" "$DEST/" 2>/dev/null || cp "$SRC/server.py" "$SRC/guard.py" "$SRC/ner_worker.py" "$SRC/llm.py" "$DEST/"
cp "$PAGE" "$DEST/Обезличиватель.html"
[ -f "$SRC/README.md" ] && cp "$SRC/README.md" "$DEST/"
ok "сервер, хук и страница скопированы"
# Распознавание сканов и картинок (Apple Vision): собираем из исходника, нет компилятора — берём готовую программу.
if [ "$(uname)" = "Darwin" ]; then
  OCR_SRC="$SRC/mcp/ocr.swift"; [ -f "$OCR_SRC" ] || OCR_SRC="$SRC/ocr.swift"
  OCR_BIN="$SRC/mcp/ocr-macos"; [ -f "$OCR_BIN" ] || OCR_BIN="$SRC/ocr-macos"
  rm -f "$DEST/ocr"
  if [ -f "$OCR_SRC" ] && xcrun --find swiftc >/dev/null 2>&1 && swiftc -O "$OCR_SRC" -o "$DEST/ocr" >/dev/null 2>&1; then
    ok "распознавание сканов: собрано на этом Mac"
  elif [ -f "$OCR_BIN" ]; then
    cp "$OCR_BIN" "$DEST/ocr-macos"; chmod +x "$DEST/ocr-macos"
    xattr -d com.apple.quarantine "$DEST/ocr-macos" 2>/dev/null || true
    ok "распознавание сканов: готовая программа"
  else
    skip "распознавание сканов недоступно"
  fi
fi

say "3/8 Рабочие папки → $DATA"
mkdir -p "$DATA/Сырые" "$DATA/Обезличенные" "$DATA/С данными" "$DATA/.ключи"
chmod 700 "$DATA/.ключи"
cp "$DEST/Обезличиватель.html" "$DATA/Обезличиватель.html"
[ -f "$DATA/правила.txt" ] || printf '# Всегда скрывать: по одному на строку. Тип через двоеточие, шаблон — между косыми.\n# ШКОЛА: Лицей «Вектор»\n# /ДЛ-\\d{6}/\n' > "$DATA/правила.txt"
[ -f "$DATA/не скрывать.txt" ] || printf '# Никогда не скрывать: слова, похожие на имена, но не являющиеся ими.\n' > "$DATA/не скрывать.txt"
ok "Сырые, Обезличенные, С данными, .ключи; страница — $DATA/Обезличиватель.html"

say "4/8 Claude Code"
if command -v claude >/dev/null 2>&1; then
  claude mcp remove obezlichivatel -s user >/dev/null 2>&1 || true
  claude mcp add obezlichivatel -s user -- "$PY" -u "$DEST/server.py" >/dev/null
  ok "MCP-сервер obezlichivatel добавлен"
else
  skip "Claude Code не найден — добавьте сервер вручную (см. README)"
fi

say "5/8 Защитный хук"
SETTINGS="$HOME/.claude/settings.json"
mkdir -p "$HOME/.claude"
"$PY" - "$SETTINGS" "$PY" "$DEST/guard.py" <<'PYEOF'
import json, sys
from pathlib import Path
path, py, guard = Path(sys.argv[1]), sys.argv[2], sys.argv[3]
try:
    data = json.loads(path.read_text(encoding='utf-8')) if path.exists() else {}
except json.JSONDecodeError:
    print('  – settings.json повреждён, хук не добавлен'); sys.exit(0)
if path.exists():
    path.with_suffix('.json.bak').write_text(path.read_text(encoding='utf-8'), encoding='utf-8')
cmd = '"%s" "%s"' % (py, guard)
hooks = data.setdefault('hooks', {}).setdefault('PreToolUse', [])
hooks[:] = [h for h in hooks if not any('guard.py' in x.get('command', '') and 'obezlichivatel' in x.get('command', '') for x in h.get('hooks', []))]
hooks.append({'matcher': '*', 'hooks': [{'type': 'command', 'command': cmd, 'timeout': 10}]})
path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding='utf-8')
print('  ✓ хук добавлен в %s (копия прежних настроек — settings.json.bak)' % path)
PYEOF

say "6/8 Скилл для Claude Code"
SKILL_SRC="$SRC/skill/obezlichivatel/SKILL.md"
if [ -f "$SKILL_SRC" ]; then
  mkdir -p "$HOME/.claude/skills/obezlichivatel"
  cp "$SKILL_SRC" "$HOME/.claude/skills/obezlichivatel/SKILL.md"
  ok "скилл obezlichivatel → ~/.claude/skills/obezlichivatel (Claude сам обезличивает файлы с данными)"
else
  skip "файла скилла нет — пропускаю"
fi

say "7/8 Умная проверка (Natasha)"
VENV="$DEST/.venv"
UV="$(command -v uv || true)"; [ -z "$UV" ] && [ -x "$HOME/.local/bin/uv" ] && UV="$HOME/.local/bin/uv"
if [ -x "$VENV/bin/python" ] && "$VENV/bin/python" -c 'import natasha' 2>/dev/null; then
  ok "Natasha уже установлена"
elif [ -n "$UV" ]; then
  "$UV" venv "$VENV" --python 3.12 -q 2>/dev/null || "$UV" venv "$VENV" -q
  if "$UV" pip install --python "$VENV/bin/python" --offline natasha >/dev/null 2>&1 || "$UV" pip install --python "$VENV/bin/python" natasha >/dev/null 2>&1; then
    ok "Natasha установлена в $VENV"
  else
    skip "Natasha не установилась — страница работает на правилах"
  fi
elif "$PY" -m venv "$VENV" >/dev/null 2>&1 && "$VENV/bin/pip" install -q natasha >/dev/null 2>&1; then
  ok "Natasha установлена в $VENV"
else
  skip "Natasha не установилась — страница работает на правилах"
fi

say "8/8 Ярлык"
if [ -f "$SRC/launcher/make_launcher.sh" ]; then
  bash "$SRC/launcher/make_launcher.sh" "$DATA/Обезличиватель.html" "$DEST/server.py"
else
  skip "папки launcher нет — ярлык не создан"
fi

say "Готово"
cat <<EOF
  • Страница без Claude: ярлык «Обезличиватель» на Рабочем столе, в Launchpad и Spotlight.
  • В Claude Code перезапустите сессию и скажите: «Обезличь свежий файл из Сырых».
  • Файлы с данными кладите в $DATA/Сырые — Claude их не прочитает.
EOF
