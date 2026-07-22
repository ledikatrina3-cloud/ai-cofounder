# Сотрудники AI-кофаундера

Каждый сотрудник — это routine-файл `routines/<id>.md`. Frontmatter = «паспорт»
(где работает, по какому расписанию, кому отчитывается). Body = промт.

Связано: [[skills]] (что умеют), [[departments]] (в каком отделе),
[[downstream-projects]] (в чьём репо работают), [[capabilities]] (общая
матрица возможностей).

## Активные сотрудники (enabled, работают по расписанию)

| Сотрудник | Проект | Триггер | Что делает |
|---|---|---|---|
| **Гайд-райтер example-project** 📝 | example-project | manual (после теста - `0 22 * * 2,5`) | Запускает skill `build-guide` в example-project: многоэтапный workflow от выбора темы до прод-деплоя гайда в блог |
| **Маркетолог vc.ru** | ai-cofounder-marketing | enabled | Публикует свежий ready-черновик на vc.ru через `pnpm publish vc` |
| **Финансовый аналитик** example-project | example-project | enabled | Считывает покупки за вчера из БД example-project, считает выручку, шлёт сводку утром |
| **Метрики example-project (еженедельно)** | example-project | enabled | Каждый понедельник — обзор ключевых метрик за неделю |
| **Critical-alerts example-project** | example-project | каждые 30 мин | Чекает support-чат на критичные сообщения, эскалирует |
| **Support-triage example-project** | example-project | enabled | Триажирует жалобы в support-чате, исследует причины |
| **DB morning triage example-project** | example-project | enabled | Каждое утро анализирует БД example-project за 24ч, ищет аномалии |

## Неактивные сотрудники (placeholders, ждут промта)

Marketing-content отдел — 5 платформенных писателей ждут пока появятся
соответствующие skills в их репозиториях (по аналогии с
`build-guide`):

| Сотрудник | Платформа | Состояние |
|---|---|---|
| Писатель vc.ru | vc.ru | placeholder, ждёт `build-vc-spoke` (есть в example-project) |
| Писатель Хабр | habr.com | placeholder, нет ещё publishing skill |
| Писатель Дзен | dzen.ru | placeholder, нет ещё publishing skill |
| Писатель Reddit | reddit.com | placeholder, нет ещё publishing skill |
| Писатель LinkedIn | linkedin.com | placeholder, нет ещё publishing skill |

## Системные / тестовые

| Сотрудник | Назначение |
|---|---|
| smoke-unattended 🔬 | Smoke-тест cross-project runner. Запускается вручную для регрессионных проверок инфры |
| example-project-noop | Пустая routine для тестов dispatcher (фаза 1.3) |
| example-read-readme | Минимальный пример — читает README, возвращает первые 100 символов |
| marketing-vc-publish-via-skill | Демо новой skill-инфраструктуры (vc-publishing skill) |

## Как добавить нового сотрудника

1. Создать `routines/<id>.md`, frontmatter обязателен (id, projectId, trigger, model, и т.д.).
2. Если работает в чужом репо — поле `targetProject: <project-id>` (см. [[downstream-projects]]).
3. Если нанимает skill — поле `skills: [skill-id]` + опционально `forceLoad`.
4. Body = промт (см. [`ai-clone/voice/tone.md`](../../ai-clone/voice/tone.md) для стиля).
5. Если в новом отделе — обновить `departments/<dep>/pipeline.yml`.
6. Установить через `pnpm install:launchd:routines` (генерирует plist'ы из cron-expressions).

Подробнее: [`CLAUDE.md`](../../CLAUDE.md) §структура + [`plans/`](../../plans/).
