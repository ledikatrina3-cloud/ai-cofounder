# Что AI-кофаундер умеет и не умеет — capability matrix

«Что реально работает прямо сейчас» vs «что в планах». Без этого фаундер
просит у агента то, чего инфраструктурно нет — и удивляется ответу
«не получается».

Связано: [[stage]] (где мы в milestone'ах), [[employees]] (кто умеет),
[[skills]] (чем умеет).

## ✅ Умеем (работает)

### Routines (расписание + автономный запуск)
- Cron-расписание любой routine через launchd (`pnpm install:launchd:routines`).
- Manual-запуск: `pnpm cron:run:routine <id>`.
- Одноразовый запуск через N секунд: `pnpm exec tsx scripts/schedule-one-shot.ts <id> <delay>`.
- Идемпотентность: `idempotencyKey UNIQUE` в SQLite-таблице Records.

### Cross-project
- Спавн `claude -p` в другом репо через `targetProject` (см. [[downstream-projects]]).
- Auth: `ANTHROPIC_API_KEY` (apikey-транспорт по умолчанию) наследуется дочерним `claude`-процессом.
- NDJSON-стрим обратно: tool.start/end, assistant.thinking, audit.spend, routine.start/end.

### Telegram
- Long-poll бот (grammy) для двусторонней связи с фаундером.
- Allowlist по chat_id (через `pnpm pair`).
- Авто-фоллбэк plain text если Markdown упал на parse-error.
- `outputType: telegram-thread | journal-only | both` — кому когда писать.
- Кастомные templates `src/report/templates/<routineId>.md`.

### Bridge UI (Office)
- 3D-сцена в React-three-fiber (6 desk-grid).
- Каждый сотрудник как фигурка, цвет/лого по routine.
- Live-events: routine.start/end → status, assistant.thinking → облако,
  tool.start → walking to station.
- DeskCountdown — countdown до nextRun или elapsed во время running.
- DocumentsPile — растущая стопка бумаг по tool.end.
- Progress bar 0..100% по 14 этапам (regex + tool-heuristics).
- LiveActivityStream в drawer'е routine с replay из JSONL.

### Skills
- Discovery layer (~80 ток/скилл) всегда в system prompt.
- `forceLoad: [id]` для full-body injection.
- Транзитивные deps (skill → skill).
- Категории, bashWhitelist union, requiredSdkTools.

### Budget enforcement
- Per-day/per-month/per-cycle caps в `config/budget.md`.
- Per-department `perDayUsd` (см. [[departments]]).
- Pre-call guard режет прогон до spawn'а subprocess'а.

### Аудит
- Каждый routine-run → `event.routine.trigger` + `audit.routine.start` + `audit.spend` + `audit.routine.end`.
- Каждый sub-agent → `tool.start/end/error`.
- JSONL-session на каждый bridge-run (replay при рестарте).
- Ring-buffer 800 events в памяти для warmup на следующий рестарт.

### Memory (auto-memory Claude Code 2.1+)
- `~/.claude/projects/<repo>/memory/MEMORY.md` — индекс, авто-обновляется.
- Отдельные memory-файлы по типам (user, feedback, project, reference).

## ⚠️ Частично умеем

- **Browser automation.** Skill `browser-control` есть (patchright + persistent
  profile), но публикатор только для vc.ru. Для Хабр/Дзен/Reddit/LinkedIn —
  нужны отдельные publishing-skills.
- **Concept auto-linking.** Endpoint автолинковки концептов в CMS example-project
  требует admin-сессию (не CRON_SECRET). Сейчас этап кросс-линковки делается
  руками после прогона.
- **Live-metrics.** Маркер `LIVE` в org/* + SQL в `live-metrics.md` — пока
  такого файла нет, цифры из БД руками.

## ❌ Не умеем (пока)

- **Email-канал.** Категория `communication` объявлена, но реализации нет.
- **Voice / TTS.** Никаких голосовых уведомлений.
- **Multi-founder.** Архитектура заточена под одного юзера (founder allowlist).
- **Self-deployment.** Routine не может сам себя задеплоить — это всегда
  явная команда от фаундера (см. CLAUDE.md принцип 2).
- **Recovery после crash.** Если процесс умер посреди 90-минутного workflow —
  нет ресюма с checkpoint'а. В планах Temporal-runner (отложено в
  [`plans/`](../../plans/) §6).
- **Альтернативные CLI.** Только claude. Cursor, Aider, opencode — runner-
  interface заложен, имплементации нет.
- **OSS-distribution.** Сейчас один-юзерская инсталляция. Open-source — отдельный
  scope (план в §7 cross-project-runner).
