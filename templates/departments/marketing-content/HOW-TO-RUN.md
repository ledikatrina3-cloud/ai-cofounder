# Как запустить marketing-content pipeline

## Первый раз

```bash
# 1. Инстанцируй департамент (создаёт departments/marketing-content/ +
#    routines/marketing-content-*.md).
pnpm dept:instantiate marketing-content

# 2. (опционально) Отредактируй topics-backlog:
$EDITOR departments/marketing-content/shared/topics-backlog.md

# 3. Включи routines (по дефолту enabled: false):
$EDITOR routines/marketing-content-researcher.md      # enabled: true
$EDITOR routines/marketing-content-writer-editor.md   # enabled: true
# ... остальные по мере готовности.
```

## Запуск pipeline'а вручную

```bash
pnpm pipeline:run marketing-content
# или
pnpm exec tsx scripts/run-pipeline.ts marketing-content
```

Скрипт:
1. Загружает `departments/marketing-content/` через `getDepartment()`
2. Генерит runId через ulid
3. Вызывает `executePipeline(dept, runId)`
4. Логирует Bridge events в stdout (pipeline.start, pipeline.node.*,
   pipeline.end)

Пайплайн доходит до approve-гейтов — присылает в Telegram сообщение с
кнопками ✅/❌/✏️. Бот должен быть запущен (`pnpm bot:dev` в другом
терминале) и фаундер должен быть в allowlist (`pnpm pair`).

## Обновление шаблона

Если ты доработал `templates/departments/marketing-content/` и хочешь
подтянуть изменения в уже инстанцированный департамент:

```bash
pnpm dept:update marketing-content
```

Это обновит `DEPARTMENT.md`, `pipeline.yml`, `shared/*` — **НЕ трогая**
routines (employees), которые ты мог дополнить вручную.

## Проверка статуса

После запуска артефакты появятся в:

- `outputs/research/<date>.md` — research-пакет
- `outputs/outlines/<date>.md` — outline
- `content/drafts/master/<date>.md` — master-draft
- `outputs/seo-audits/<date>.json` — SEO-аудит
- `content/drafts/master/<date>-cover.svg` — обложка
- `content/drafts/vc/<date>.md` — vc-адаптация
- `content/drafts/dzen/<date>.md` — Дзен-адаптация
- `outputs/publish/{vc,dzen,tg}-<date>.md` — отчёты publishers
- `outputs/analytics/<date>.json` — трафик-отчёт через 24ч

Pipeline state — в БД (Record type `pipeline.state`).
