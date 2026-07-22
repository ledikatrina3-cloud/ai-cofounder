# AI-Cofounder — навигация по проекту

Проактивный AI-кофаундер для соло-фаундера: сам находит проблемы в бизнесе и
доводит до результата (поддержка → код → деплой, маркетинг, аналитика).
Local-first, живёт на маке. Канал общения — Telegram. Расписание — launchd.

## Порядок чтения в начале каждой сессии

1. **`ai-clone/INDEX.md`** — кто фаундер, как принимает решения, его голос,
   правила из ошибок. Этот слой едет с фаундером на любой проект.
2. **`org/INDEX.md`** — что строим (AI-кофаундер как продукт): identity,
   audience, brand-voice, продукты. Этот слой остаётся с проектом.
3. `CLAUDE.md` (этот файл) — правила репо и навигация.
4. Зона задачи: `plans/<актуальный>.md`, нужный `agents/<id>/`,
   `skills/<имя>/SKILL.md` или папка в `src/`.

Слой «кто говорит» (ai-clone) — раньше слоя «о чём говорит» (org). Не случайно.

## Структура репозитория

```
ai-cofounder/
├── CLAUDE.md          ← этот файл (навигация)
├── ai-clone/          ← цифровая проекция фаундера (role, voice, principles, feedback)
├── org/               ← бизнес-знания: identity, brand-voice, audience, product-knowledge
├── plans/             ← планы фич (большие задачи > 1ч)
├── retrospectives/    ← рефлексии после сессий
├── agents/            ← ЮЗЕР: самодостаточные агенты agents/<id>/ (см. docs/AGENTS.md). gitignore'нут
├── examples/          ← ДВИЖОК: примеры агентов (examples/agents/) + seed'ы (org-seed, ai-clone-seed) для /setup
├── routines/          ← legacy flat-формат (back-compat; см. routines/README.md + scripts/migrate-routines.ts)
├── skills/            ← переиспользуемые навыки (shared-библиотека: article-writing, …)
├── departments/       ← отделы (DEPARTMENT.md + pipeline.yml + budget)
├── projects/          ← карты внешних проектов (example-project, …)
├── config/            ← реестры (projects.md, allowlist.md, budget.md, pricing.md)
├── infrastructure/    ← launchd-плисты (шаблоны расписания)
├── src/               ← TypeScript-исходники
├── bridge/            ← Hono-сервер + React-UI 3D-офиса
├── scripts/           ← утилитарные tsx-скрипты
├── prisma/            ← схема БД и миграции
├── tests/             ← Vitest-тесты (top-level, не colocate)
└── .env.local         ← dev-секреты (grep only, никогда Read целиком)
```

## Где что искать

| Вопрос | Файл |
|---|---|
| Кто фаундер, как решает, его голос, его правила | `ai-clone/INDEX.md` (создаётся `/setup` из `examples/ai-clone-seed`) |
| Что мы строим, кто аудитория, как звучим (от компании) | `org/INDEX.md` (создаётся `/setup` из `examples/org-seed`) |
| LLM-транспорт (apikey по умолчанию; oauth опционален) | `src/llm/transport.ts` |
| Активный план | `plans/YYYY-MM-DD-<имя>.md` |
| Что делает «сотрудник» (агент) | `agents/<id>/` (AGENT.md + prompt.md + permissions.yml; docs/AGENTS.md) |
| Создать/настроить агента | `/scaffold-agent <id>` или вручную из `templates/agent/` |
| Первичная настройка форка | `/setup` (.claude/commands/setup.md) |
| Граница движок/пользователь, обновления | `engine-manifest.json` + `docs/UPDATING.md` + `scripts/update-engine.sh` |
| Что умеет навык | `skills/<имя>/SKILL.md` |
| Отдел + pipeline + дневной бюджет | `departments/<id>/` |
| Реестр downstream-проектов (cwd, allowed skills) | `config/projects.md` |
| Templates для Telegram-сообщений | `src/report/templates/<routineId>.md` |
| Прошлые сессии | `retrospectives/YYYY-MM-DD_*.md` |
| Секреты | macOS Keychain через `keytar`; dev — `.env.local` |

## Принципы

1. Не хардкодить динамику (цены, даты, имена) — всё через `org/`, `config/` или БД.
2. Не деплоить и не запускать live-routine без явной команды от фаундера.
3. Удалять одноразовый код в той же сессии — не плодить отладочные ветки.
4. `pnpm build` перед push (не `tsc`). Biome тоже валит build при formatter-ошибках.
5. Большая фича (>1ч или новый модуль) = план в `plans/`. Микро-правка — без.
6. После каждой фичи — 5 ходов ретро: ошибки → пропуски → причины → diff с свежим взглядом → security.
7. В конце сессии — `retrospectives/YYYY-MM-DD_<кратко>.md` (задача / решение / итог / что узнал).
8. `git add` только поимённо. Никогда `-A` / `.` — параллельные routine'ы могут иметь WIP.
9. `.env*` — только `grep "^VAR=" .env`, никогда Read целиком (риск утечки в контекст).
10. Любая правка стека или транспорта — фиксируй причину в `CHANGELOG.md` и в комментарии у кода.
11. Cross-project (агент работает над внешним репо) = OPT-IN: файл `agents/<id>/target.yml` с `cwd:`. По умолчанию агент self-contained. Legacy-аналог — `targetProject:` в routines/.
12. Telegram-сообщение всегда с plain-text fallback — Markdown может упасть на парсинге (`can't parse entities` — прецедент 2026-05-22).
13. Движок/пользователь разделены ОТСУТСТВИЕМ: upstream не трекает `agents/ org/ ai-clone/` + user-config (они в .gitignore); `/setup` сидит их локально из `examples/`. `git pull` движка их не трогает. См. `engine-manifest.json` + `docs/UPDATING.md`.

## Стек

- **Язык:** TypeScript 5.x, Node.js 22 LTS, **pnpm**
- **LLM:** Claude Agent SDK; Opus 4.7 1M — архитектура, Sonnet 4.6 — рутина, Haiku 4.5 — review
- **Транспорт:** `LLM_TRANSPORT=apikey` (default, рекомендуемый) — прямой Anthropic API по `ANTHROPIC_API_KEY`. `oauth` — экспериментальный/НЕ endorsed (свой gateway, не поставляется; может конфликтовать с ToS). src/llm/transport.ts.
- **HTTP:** Hono (webhook + bridge-server)
- **БД:** SQLite + sqlite-vec, ORM — Prisma. Бэкап rclone → Cloudflare R2
- **Telegram:** `grammy` long-poll, parse_mode=Markdown с авто-fallback на plain
- **Расписание:** launchd + SQLite-очередь, `idempotencyKey UNIQUE`. Одноразовый запуск — `scripts/schedule-one-shot.ts`
- **Тесты/lint:** Vitest, Biome, lefthook
- **Деплой:** локально на маке. VPS/Coolify — escape-hatch
- **Секреты:** Keychain через `keytar`

## Самообучение в конце каждой сессии

Перед тем как завершить — проверь:
1. Узнал что-то новое о **фаундере** или его стиле? → файл в `ai-clone/feedback/<имя>.md`
   (формат Rule → Why → How). НЕ в CLAUDE.md — личное про фаундера едет с фаундером.
2. Узнал что-то новое о **проекте** (аудитория, продукт, экономика)? → одна строка
   в нужный файл `org/` или новый файл.
3. Поймал инфраструктурную ловушку (Markdown parse-error, `pg_dump --where`,
   и т.п.)? → файл в `ai-clone/feedback/<ловушка>.md` с указанием обхода.
4. Завершил фичу? → 5-ходовое ретро в `retrospectives/YYYY-MM-DD_*.md`
   (см. `ai-clone/feedback/retro-after-feature.md`).

Принцип: каждое правило проверяемо — «если убрать, Claude сделает ошибку».
Если нет — не добавляй. CLAUDE.md таргетируем под 100-120 строк (Anthropic
рекомендует <200).

## Язык

Всегда отвечай на русском. Только дефис, не длинное тире (`—` ломает MDX-parser и не любит SEO).
