# Сторонние компоненты

## Входят в репозиторий и в собранную страницу

| Компонент | Где | Лицензия |
|---|---|---|
| [pdf.js](https://github.com/mozilla/pdf.js) 6.4.299, Mozilla | `vendor/pdfjs/`, встраивается в `Обезличиватель.html` | Apache License 2.0 — полный текст в `vendor/pdfjs/LICENSE` |
| Словарь [OpenCorpora](https://opencorpora.org) | `src/lexicon.js` — список обычных слов, похожих на фамилии, выбранный из словаря | [CC BY-SA 3.0](https://creativecommons.org/licenses/by-sa/3.0/). `src/lexicon.js` — производная база данных и распространяется на тех же условиях (с указанием источника) |

## Не входят: ставятся отдельно или берутся из системы

| Компонент | Зачем | Лицензия |
|---|---|---|
| [Natasha](https://github.com/natasha/natasha) | Поиск имён нейросетью; установщик ставит через pip | MIT |
| [pymorphy2](https://github.com/pymorphy2/pymorphy2) и pymorphy2-dicts-ru | Только для пересборки `src/lexicon.js` (`tools/build_lexicon.py`) | MIT (код), словарь OpenCorpora — CC BY-SA 3.0 |
| [Ollama](https://github.com/ollama/ollama) | Локальный запуск модели для глубокой проверки; пользователь ставит сам или по кнопке | MIT |
| [Qwen3](https://huggingface.co/Qwen) (`qwen3:8b`) | Модель для глубокой проверки, скачивается через Ollama | Apache License 2.0 |
| Apple Vision | Распознавание сканов на macOS (`mcp/ocr.swift`, `mcp/ocr-macos`) — системная библиотека macOS | Часть macOS |
| Шрифт Lato | Указан в стилях; используется, только если уже установлен на компьютере, в репозиторий не входит | SIL Open Font License 1.1 |

Иконка (`launcher/icon.svg`) и весь остальной код написаны для этого проекта.
