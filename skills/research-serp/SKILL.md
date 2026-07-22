---
name: research-serp
description: Ищет источники по теме через публичный DuckDuckGo SERP. Возвращает топ-10 ссылок с title и snippet. Не парсит контент страниц — только результаты поиска. Не использует платные API.
version: 1.0.0
category: research
displayName: SERP Researcher
icon: 🔍
color: "#5588FF"
dependsOn: []
requiresScopes: []
---

# research-serp

## Когда использовать
Когда тебе нужно собрать первичный research-пакет: список релевантных
источников по теме. Дальше writer-агент будет цитировать эти источники.

НЕ используй для: глубокого парсинга контента (это отдельная задача),
проверки одного факта (для этого один URL → одна выписка, не SERP).

## Алгоритм

1. **Sanitize topic.** Убери лишние пробелы, новые строки. Если тема —
   markdown с заголовком и описанием, оставь только заголовок.
2. **Запусти скрипт:**
   ```
   pnpm exec tsx skills/research-serp/scripts/search.ts "<topic>"
   ```
   Скрипт возвращает JSON последней строкой stdout:
   ```json
   {
     "topic": "...",
     "results": [
       {"title": "...", "url": "https://...", "snippet": "..."},
       ...
     ],
     "errors": []
   }
   ```
3. **Интерпретируй.** Отбрось результаты с:
   - подозрительными доменами (spam-сайты, кликбейт)
   - дубликатами по URL
   - явно не relevant контентом (по title/snippet)
4. **Запиши итоговый research** как markdown в output путь (передаётся
   routine'ой). Формат:
   ```markdown
   # Research: <topic>
   Дата: YYYY-MM-DD

   ## Sources
   1. [Title](url) — snippet
   ...

   ## Key facts (если уже видно из snippets)
   - ...

   ## Notes
   - ...
   ```

## Ограничения

- DuckDuckGo может вернуть пусто или капчу — это попадёт в `errors`.
- Скрипт не ходит на сами страницы (deep parsing — отдельный скилл).
- Без VPN/прокси — географическая привязка ограничивает выдачу.
