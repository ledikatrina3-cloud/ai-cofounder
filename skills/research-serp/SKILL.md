---
name: research-serp
description: Ищет источники по теме через публичный DuckDuckGo SERP и, если задан список reference-блогов, открывает их страницы для сверки редакционных паттернов. Не использует платные API.
version: 1.2.0
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
источников по теме и проверить reference-блоги, которые явно перечислены в
локальном файле `org/reference-blogs.md`.

НЕ используй для: глубокого парсинга всего сайта,
проверки одного факта (для этого один URL → одна выписка, не SERP).

## Алгоритм

1. **Sanitize topic.** Убери лишние пробелы, новые строки. Если тема —
   markdown с заголовком и описанием, оставь только заголовок.
2. **Запусти скрипт:**
   ```
   pnpm exec tsx skills/research-serp/scripts/search.ts "<topic>"
   ```
   Скрипт сначала обращается к DuckDuckGo HTML, затем при пустой выдаче или
   вероятном rate-limit автоматически пробует DuckDuckGo Lite и GET-вариант HTML.
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
4. **SERP hard-gate.** PASS только если после фильтрации осталось минимум 3
   релевантных результата и `errors` пустой. Если `errors` не пустой или
   `results.length === 0`, не называй это выполненным research: переформулируй
   запрос и сделай ещё до 3 попыток с другим языком пользователя, болью клиента
   или более широким бизнесовым запросом.
5. **Если все попытки пустые**, запиши `SERP unavailable` и ошибки из JSON. Не
   добавляй внешние факты, цифры, нормы или цитаты. Для задач, где актуальные
   источники обязательны, остановись на gate вместо генерации готового текста.
6. **Reference-blog check.** Если есть `org/reference-blogs.md`, открой
   reference-блоги через скрипт:
   ```
   pnpm exec tsx skills/research-serp/scripts/reference-blogs.ts --topic "<topic>" --blogs-file org/reference-blogs.md --max-pages 3
   ```
   Скрипт возвращает JSON:
   ```json
   {
     "topic": "...",
     "blogsFile": "org/reference-blogs.md",
     "status": "pass",
     "blogs": [
       {
         "url": "https://example.com/guides",
         "status": "pass",
         "pages": [
           {
             "url": "https://example.com/guides",
             "title": "...",
             "description": "...",
             "headings": ["..."],
             "matchedTerms": ["..."],
             "snippet": "..."
           }
         ],
         "errors": []
       }
     ],
     "errors": []
   }
   ```
   PASS только если `status: "pass"` и хотя бы одна страница открыта. Если
   файл отсутствует, пустой или сайт не открылся, честно запиши этот статус и
   не утверждай, что reference-блоги проверены.
7. **Запиши итоговый research** как markdown в output путь (передаётся
   routine'ой). Формат:
   ```markdown
   # Research: <topic>
   Дата: YYYY-MM-DD

   ## Sources
   1. [Title](url) — snippet
   ...

   ## Key facts (если уже видно из snippets)
   - ...

   ## Reference blogs
   Status: pass | missing_blogs_file | empty | failed
   Pages opened:
   1. [Title](url) — matched terms: ...

   ## Notes
   - ...
   ```

## Ограничения

- DuckDuckGo может вернуть пусто или капчу; скрипт пробует запасные DDG endpoints,
  но если все они пустые, это попадёт в `errors` и не считается успешным research.
- Скрипт `reference-blogs.ts` ходит только на явно перечисленные публичные
  HTTPS-страницы из `org/reference-blogs.md`, без cookies и без чтения секретов.
- Без VPN/прокси — географическая привязка ограничивает выдачу.
