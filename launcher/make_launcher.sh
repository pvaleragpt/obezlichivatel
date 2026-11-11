#!/usr/bin/env bash
# Ярлык «Обезличиватель» для macOS: приложение в ~/Applications (видно в Launchpad и Spotlight)
# и ярлык на Рабочем столе. Запускает локальный сервер страницы (127.0.0.1, без интернета) —
# так работает умная проверка нейросетью. Нет Python — открывает страницу прямо из файла.
#
#   bash make_launcher.sh [путь к Обезличиватель.html] [путь к server.py]
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
PAGE="${1:-$HOME/Обезличиватель/Обезличиватель.html}"
SERVER="${2:-$HOME/obezlichivatel-mcp/server.py}"
APP="$HOME/Applications/Обезличиватель.app"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

if [ "$(uname)" != "Darwin" ]; then
  echo "  – ярлык делается только на macOS. На Windows ярлык делает install.cmd."
  exit 0
fi

mkdir -p "$HOME/Applications"
rm -rf "$APP"

cat > "$WORK/main.applescript" <<APPLESCRIPT
on run
	set serverPath to "$SERVER"
	set pagePath to "$PAGE"
	try
		do shell script "test -f " & quoted form of serverPath & " && test -x /usr/bin/python3"
		do shell script "nohup /usr/bin/python3 " & quoted form of serverPath & " --app > /dev/null 2>&1 &"
	on error
		try
			do shell script "test -f " & quoted form of pagePath
			do shell script "open " & quoted form of pagePath
		on error
			display dialog "Не найден Обезличиватель. Переустановите: bash install.sh" buttons {"Понятно"} default button 1 with icon caution
		end try
	end try
end run
APPLESCRIPT
osacompile -o "$APP" "$WORK/main.applescript"

# Иконка: SVG → PNG (Quick Look) → набор размеров → .icns
if qlmanage -t -s 1024 -o "$WORK" "$HERE/icon.svg" >/dev/null 2>&1 && [ -f "$WORK/icon.svg.png" ]; then
  SET="$WORK/icon.iconset"; mkdir -p "$SET"
  for s in 16 32 128 256 512; do
    sips -z $s $s "$WORK/icon.svg.png" --out "$SET/icon_${s}x${s}.png" >/dev/null
    sips -z $((s * 2)) $((s * 2)) "$WORK/icon.svg.png" --out "$SET/icon_${s}x${s}@2x.png" >/dev/null
  done
  iconutil -c icns "$SET" -o "$APP/Contents/Resources/applet.icns"
  touch "$APP"
  echo "  ✓ иконка"
else
  echo "  – иконку сделать не удалось, будет стандартная"
fi

/usr/libexec/PlistBuddy -c "Set :CFBundleName Обезличиватель" "$APP/Contents/Info.plist" 2>/dev/null || true
/usr/libexec/PlistBuddy -c "Add :CFBundleIdentifier string local.obezlichivatel.launcher" "$APP/Contents/Info.plist" 2>/dev/null || true

# После правки иконки и Info.plist подписываем заново, иначе macOS может не запустить приложение.
codesign --force --deep --sign - "$APP" >/dev/null 2>&1 || true
ln -sfn "$APP" "$HOME/Desktop/Обезличиватель"
echo "  ✓ приложение: $APP"
echo "  ✓ ярлык на Рабочем столе: ~/Desktop/Обезличиватель"
