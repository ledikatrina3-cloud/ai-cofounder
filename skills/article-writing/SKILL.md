---
name: article-writing
description: Пишет длинную статью (1000–3000 слов) от outline до self-edit на основе research-пакета. Подключает org/brand-voice + org/audience автоматически. Не публикует и не выбирает темы — это другие скиллы.
version: 1.0.0
category: writing
displayName: Article Writer
icon: ✍️
color: "#9F7AEA"
dependsOn: []
requiresScopes: []
---

# article-writing

## Когда использовать
Когда есть подтверждённая тема (approve-theme прошёл) и research-пакет, и нужно
получить master-draft статьи — единый длинный markdown-файл, который потом
адаптируется под платформы (vc.ru, Дзен, Telegram). НЕ используй этот скилл
для коротких постов (<500 слов), маркетинговых тизеров, твитов — у них своя
структура и тон.

## Основной workflow (5-7 шагов)

1. **Прочитай research-пакет** (выдаётся routine'ой как input). Если нет —
   останавливайся и проси research-агента.
2. **Построй outline** — структура из 3–7 секций. Сверяйся с
   `references/structure-template.md` (intro → body → CTA).
3. **Напиши draft** по outline. Для каждой секции — конкретные тезисы из
   research. Не выдумывай факты, не подтверждённые источниками.
4. **Самопроверка тона.** Сверь с `org/brand-voice.md` (он автоматически в
   твоём system prompt от runtime) + `references/tone-of-voice.md`.
5. **SEO-минимум.** Сверь с `references/seo-basics.md`: один H1, 2+ H2, lead
   100–250 символов, meta description если требует target-платформа.
6. **Длину проверь скриптом:**
   ```
   pnpm exec tsx skills/article-writing/scripts/word-count-check.ts <path> [--min N] [--max M]
   ```
   Скрипт вернёт JSON `{wordCount, charCount, status: 'ok'|'too-short'|'too-long'}`.
   Дефолтный диапазон: 1000–3000 слов.
7. **Финальный чек-лист** (см. ниже) и сдача артефакта.

## Что обязательно проверить перед сдачей

- Все факты из research имеют ссылку (или явно помечены как «свой опыт»)
- Один H1, минимум 2 H2
- Lead-параграф 100–250 символов
- Brand-voice выдержан (никаких корпоративных штампов, см. `references/style-guide.md`)
- Длина в диапазоне 1000–3000 слов (или явно обоснован выход за рамки)
- Есть финальный CTA (подписка / следующий пост / комментарии)

## Подробности

Большие пакеты знаний разнесены по `references/`:

- [structure-template.md](references/structure-template.md) — каркас статьи
- [style-guide.md](references/style-guide.md) — формулировки и табу
- [seo-basics.md](references/seo-basics.md) — H1/H2/meta правила
- [tone-of-voice.md](references/tone-of-voice.md) — голос (поверх org/brand-voice)
- [research-protocol.md](references/research-protocol.md) — как обращаться с источниками
- [examples/good-article-1.md](references/examples/good-article-1.md) — образец
- [examples/what-not-to-do.md](references/examples/what-not-to-do.md) — антипаттерны

Читай только нужное — на простой статье достаточно structure-template + style-guide.

<!-- TODO фаундеру: импортируй сюда свой существующий article-writing промпт.
Распредели по references/ по темам (structure / style / SEO / tone / research /
examples). Этот SKILL.md — generic placeholder; реальный текст должен быть
в твоём голосе. См. план 2026-05-21-skills-architecture-v3, п.10. -->
