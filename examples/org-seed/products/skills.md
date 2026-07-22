# Skills — переиспользуемые «навыки» сотрудников

Skill — это Anthropic-совместимый пакет `skills/<id>/`. Один скилл = одна
законченная компетенция (написать статью, опубликовать на vc.ru, аудит SEO).

Связано: [[employees]] (кто нанимает), [[capabilities]] (что мы умеем в целом).

## Текущая инвентаризация

| Скилл | Категория | Что делает |
|---|---|---|
| **article-writing** | writing | Пишет длинную статью (1000-3000 слов) от outline до self-edit. Использует [[brand-voice]] + org/audience для тона. |
| **vc-publishing** | publishing | Публикует готовый черновик (`status: ready`) на vc.ru через persistent browser profile (patchright) |
| **browser-control** | automation | Базовые примитивы управления браузером — persistent profile, login session, screenshot, click, type |
| **research-serp** | research | Ищет источники по теме через публичный DuckDuckGo SERP. Возвращает топ-N результатов с заголовками и URL |
| **seo-audit** | analysis | Аудит markdown-draft по SEO-правилам: H1, H2, lead-длина, internal links, title/meta-description |
| **cover-design** | design | Генерирует обложку для статьи из SVG-шаблона с подстановкой заголовка и hero-text |
| **analytics-traffic** | analysis | Собирает публичные метрики трафика (views, comments, likes) для опубликованной статьи на vc/habr/dzen |

## Архитектура skill

Каждый скилл в `skills/<id>/`:

```
skills/<id>/
├── SKILL.md              ← frontmatter (name, description, requiresScopes) + body
├── references/           ← подробности, читаются по требованию
├── scripts/              ← deterministic actions, JSON output
├── assets/               ← шаблоны (SVG, JSON-схемы)
└── permissions.md        ← bashWhitelist, requiredSdkTools, maxSteps
```

**Discovery layer** (~80 токенов/скилл): name + description всегда в system
prompt routine'а. Тело SKILL.md инжектируется **по требованию** или через
`forceLoad: [skill-id]` в frontmatter routine'а.

## Категории (фиксированные 7)

- `publishing` — публикация на платформу (vc, дзен, reddit, …)
- `research` — поиск источников, фактов, конкурентов
- `writing` — длинные/короткие тексты
- `analysis` — метрики, KPI, аудит
- `communication` — отправка сообщений
- `automation` — браузер, файлы, веб-скрапинг (примитивы)
- `internal` — общие модули, скрыты от маркетплейса (`browser-control`)

## Skills которые живут в чужих репо

Cross-project routine может нанимать skill из target-репо. Например
`marketing-content-example-project` использует `build-guide` —
он физически живёт в `example-project/.claude/skills/`. См.
[[downstream-projects]].

Список таких skills:
- `build-guide` (example-project) — 14-этапный workflow гайдов в блог
- `build-instruction` (example-project) — 12-этапный workflow инструкций курса
- `build-vc-spoke` (example-project) — spoke-статья на vc.ru на основе pillar
- `ui-ux-pro-max` (example-project) — UI/UX design intelligence

## Как добавить новый skill

См. [`plans/`](../../plans/)
и существующий пример `skills/vc-publishing/`.

Минимум:
1. `skills/<id>/SKILL.md` с frontmatter (name, description обязательны).
2. `skills/<id>/permissions.md` — что можно (bashWhitelist, tools).
3. Если deterministic — `scripts/*.ts` с JSON-return.
4. Опубликовать в routine через `skills: [id]`.
