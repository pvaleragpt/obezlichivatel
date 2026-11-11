#!/bin/bash
# Обезличиватель (без Claude). Есть Python — страница с глубокой проверкой через Ollama и распознаванием сканов;
# нет — просто страница (быстрая проверка). Ничего не устанавливает.
cd "$(dirname "$0")" || exit 1
PY=""
for c in /opt/homebrew/bin/python3 /usr/local/bin/python3 /Library/Frameworks/Python.framework/Versions/Current/bin/python3; do
  [ -x "$c" ] && PY="$c" && break
done
# Системный python3 работает, только если стоят «инструменты разработчика» — иначе он попросит их скачать.
[ -z "$PY" ] && xcode-select -p >/dev/null 2>&1 && PY="/usr/bin/python3"
if [ -n "$PY" ]; then
  nohup "$PY" local_server.py >/dev/null 2>&1 &
  echo "Обезличиватель открывается в браузере. Это окно можно закрыть."
else
  open "Обезличиватель.html"
  echo "Python не найден — открыта страница с быстрой проверкой. Это окно можно закрыть."
fi
