---
name: analytics-traffic
description: Собирает публичные метрики трафика (views, comments, likes) для опубликованных постов. Парсит публичные страницы vc.ru; Дзен/Telegram — stub'ы. Не использует приватные admin API.
version: 1.0.0
category: analysis
displayName: Traffic Analytics
icon: 📈
color: "#00AA88"
dependsOn: []
requiresScopes: []
---

# analytics-traffic

## Когда использовать
Через 24 часа (или больше) после публикации. Собирает публичные метрики
для одного или нескольких URL'ов / директории `content/published/<platform>/`.
Возвращает JSON-отчёт для дальнейшего report-агента.

НЕ используй для:
- private dashboard метрик (нужны OAuth/cookies — это другой скилл)
- A/B тестов
- историй кликов / heat-maps

## Алгоритм

1. **Собери URL'ы.** Два режима:
   - Передан `--urls url1,url2` → используешь их напрямую.
   - Передан `--from-content content/published/vc/` → читаешь все `.md`
     с `published_url` во frontmatter, берёшь оттуда URL'ы.
2. **Запусти скрипт:**
   ```
   pnpm exec tsx skills/analytics-traffic/scripts/collect.ts --platform vc --urls "url1,url2"
   ```
   или
   ```
   pnpm exec tsx skills/analytics-traffic/scripts/collect.ts --platform vc --from-content content/published/vc/
   ```
   stdout JSON:
   ```json
   {
     "platform": "vc",
     "urls": [
       {"url": "...", "views": 234, "comments": 12, "likes": 5, "error": null},
       {"url": "...", "views": 0, "comments": 0, "likes": 0, "error": "..."}
     ],
     "collectedAt": "2026-05-21T08:00:00Z",
     "errors": []
   }
   ```
3. **Запиши отчёт** в output путь (markdown):
   ```markdown
   # Traffic report: <platform>
   Собрано: <date>

   | URL | Views | Comments | Likes | Δ vs prev |
   | --- | --- | --- | --- | --- |
   | ... | ... | ... | ... | ... |

   ## Insights
   - ...
   ```

## Поддерживаемые платформы

- **vc.ru** — реальный парсинг публичных страниц.
- **dzen** — TODO (заглушка возвращает `error: 'not-implemented'`).
- **tg** (Telegram) — TODO (требует API для publicly-видимых каналов).

## Ограничения

- Только публично-видимые метрики. Reads, subscribers — недоступны без API.
- Может вернуть ошибку, если страница за paywall'ом / 404.
- Rate-limit'а на vc.ru — щадящий, но для bulk-сбора используй задержку.
