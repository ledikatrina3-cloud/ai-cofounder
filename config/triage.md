# Триаж — настройки

Параметры одиночного Sonnet-вызова в `src/triage/extract.ts` (фаза 2.2a). Меняются — поправь этот файл; код подхватит при следующем вызове `extractProblems()`. Никаких хардкодов в TS.

```json
{
  "model": "claude-sonnet-4-6",
  "maxTokens": 4096,
  "toolChoice": { "type": "tool", "name": "extract_problems" }
}
```

## Поля

- `model` — имя модели или alias из `config/pricing.md`. Sonnet 4.6 выбран потому, что задача структурного парсинга текста на русском без сложного reasoning'а.
- `maxTokens` — потолок ответа. 4096 хватает на ~30 проблем со средним текстом; реальный поток поддержки example-project < 5/день, запас гигантский.
- `toolChoice` — `{ "type": "tool", "name": "extract_problems" }` форсит вызов tool'а (модель обязана вернуть structured output, не свободный текст). Альтернативы: `{ "type": "auto" }` (модель сама решает) или `{ "type": "any" }` (любой tool).

## Почему отдельный config-файл, а не const в коде

Принцип CLAUDE.md «не хардкодить динамику»: модель и лимиты меняются чаще, чем код. Парсинг копирует паттерн `config/pricing.md` / `config/budget.md`.
