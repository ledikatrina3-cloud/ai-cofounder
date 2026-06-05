---
name: telegram-plain-fallback
description: Каждое Telegram-сообщение от агента — Markdown с auto-fallback на plain text при parse-error.
type: feedback
---

Когда агент шлёт сообщение фаундеру через `grammy` (`parse_mode: 'Markdown'`),
обязательно ловить parse-error и retry'ить как plain text без `parse_mode`.

**Why:** Telegram отказывается рендерить Markdown с любым несбалансированным
символом (`_`, `*`, `` ` ``, или незакрытый `\`\`\``). Возвращает
`400: Bad Request: can't parse entities: Can't find end of the entity at byte offset X`.

Если dispatcher молча проглатывает ошибку (наш случай до фикса) —
фаундер не получает финальный отчёт вообще. Прецедент: первый прогон
маркетинг-контент routine — гайд опубликован, $0.54 потрачено, URL
получен, но в Telegram прилетел только skipped-сигнал от первого ошибочного
sendMessage. Узнали что произошло только из БД-аудита.

**How to apply:**
- В `src/core/dispatcher.ts:buildDefaultSendToFounder` — try/catch вокруг
  Markdown-send. На `can't parse entities` ловим, retry'им БЕЗ `parse_mode`.
- Routine-prompt НЕ должен оборачивать финальный output в \`\`\`...\`\`\` —
  это превращает весь блок в monospace + URL некликабельны (см.
  `feedback/no-codefences-in-telegram.md`).
- `src/report/render.ts:stripCodeFences` снимает обрамляющие \`\`\` если
  агент всё-таки их вставил.
- Любое НОВОЕ место где шлём message пользователю — те же два слоя:
  fallback в send + защита формата при render.
