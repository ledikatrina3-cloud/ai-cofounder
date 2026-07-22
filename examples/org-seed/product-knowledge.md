# Знание о продукте

> Этот файл НЕ инжектируется в discovery layer скиллов. Скиллы читают его через `project.read` когда нужна продуктовая специфика (фичи, отличия, цены).

## Что такое AI-кофаундер

Local-first приложение для соло-фаундера. Живёт на маке. Канал общения — Telegram-бот.

## Архитектура (high-level)

- **Ядро:** Claude Agent SDK с Opus 4.7 (архитектура), Sonnet 4.6 (рутина), Haiku 4.5 (review).
- **Транспорт:** прямой Anthropic API по `ANTHROPIC_API_KEY` (`LLM_TRANSPORT=apikey`, по умолчанию). oauth - экспериментальный escape-hatch.
- **Хранение:** SQLite + sqlite-vec через Prisma. Бэкап в Cloudflare R2 через rclone.
- **Расписание:** launchd + SQLite-таблица как очередь (idempotencyKey UNIQUE).
- **UI:** Bridge — Electron-app на маке с React-overlay'ем «офис AI-сотрудников».

## Ключевые концепты

- **Routine** — единица автономной работы (`routines/<id>.md`). Описывает: какой агент, по какому расписанию, с какими tools, что делает.
- **Skill** — Anthropic-совместимый пакет (`skills/<id>/`). Discovery layer (~80 ток/скилл) всегда в system prompt; body инжектируется lazy.
- **Project** — внешний бизнес фаундера (`config/projects.md` + `projects/<id>/map.md`). Routines ссылаются на projectId.
- **Org** — слой знаний выше проектов (этот каталог `org/`). Бренд, аудитория, стиль — общие для всех проектов.

## Стадия

MVP в разработке. M1 + M2 закрыты (фундамент + утренний детектив). Сейчас — Фаза 3 плана `plans/` (org knowledge + базовый Office UI).

<!-- TODO фаундеру: добавь сюда детали ценообразования, отличий от конкурентов, конкретных фич — когда это понадобится writer-агенту для статьи. -->
