---
name: SEO Department
description: SEO-отдел — 6 сотрудников, каждый пишет и публикует статьи на свою платформу (acme.example.com, vc.ru, Дзен, Хабр, Reddit, LinkedIn).
budget:
  perDayUsd: 5.00
  perRunUsd: 1.00
---

# Отдел: SEO Department

## Что делает
6 платформенных писателей. Каждый отвечает за одну площадку:
- **example-project** — гайды/статьи на главный сайт acme.example.com
- **vc** — статьи на vc.ru (skill vc-publishing активен)
- **dzen** — статьи на Яндекс Дзен (publishing skill — TODO)
- **habr** — статьи на Хабр (publishing skill — TODO)
- **reddit** — посты на Reddit (publishing skill — TODO)
- **linkedin** — статьи и посты на LinkedIn (publishing skill — TODO)

Все используют skill `article-writing` (структура, style-guide, SEO basics в
references/). Платформенно-специфичный publishing — это второй skill
который добавляется по мере готовности (по аналогии с vc-publishing).

## KPI
- 1 пост в неделю на каждую активную площадку.
- ≥ 100 reads/post на vc.ru.
- Стоимость публикации ≤ $1.00.

## Бюджет
- `perDayUsd: 5.00` — больше не сжигаем за день (защита от глюка writer'а).
- `perRunUsd: 1.00` — один цикл укладывается в $1.

## Состояние промтов
Все 6 routines созданы с TODO-плейсхолдерами в body. Фаундер заполняет
промт под каждую площадку отдельно — это часть онбординга, не делается
автоматом (план явно отложил «реальный article-writing промпт» в open
questions).
