# Карта проекта Acme Academy

Что AI-Cofounder знает о проекте `example-project` (см. `config/projects.md`):
где код, где БД, где клиенты переписываются. Карту читает routine-движок
(фаза 1.3+) при каждом запуске routine, привязанной к этому projectId.

Принципы:
- Карта — **не секреты**. Кредла лежат в Keychain под именованным
  service-key. В карте — только имя service-key, путь до файла,
  chat_id и whitelist таблиц.
- Карта обновляется вручную фаундером по мере изменений в проекте
  (новая таблица в БД → правим `db-connections.allowedTables[]`,
  иначе routine её не увидит).
- Любой tool routine'ы (`project.read`, `project.db.query`,
  `project.telegram.read`) привязан к этой карте: вне whitelist'а —
  permission error и `audit.security.tool.deny`.

Формат:
- Секции `## <name>` фиксированы (см. `src/projects/map.ts`).
- `description` и `notes` — свободный markdown в теле секции, агент
  читает «как есть». Остальные секции — структурные.

Обязательные секции: `description`, `key-directories`, `key-files`,
`db-connections`, `telegram-channels`. Отсутствие любой — `ProjectMapError`
при `loadProjectMap('example-project')`. Допустимы пустые списки: «коннектов
ещё нет, но место под них объявлено».

## description

Acme Academy — пример downstream-проекта: online-school SaaS на Next.js
(App Router) + Prisma + PostgreSQL. Воркеры для асинхронной обработки
сообщений (support-чат, рассылки, автоматизации). Платежи — через
платёжный провайдер (пример). Контент — курсы (Module/Lesson), домашки,
livestream-трансляции.

Воркеры запускаются отдельными процессами (`pnpm bot`, `pnpm workers`,
`pnpm automation-worker`). Production деплоится через CI/CD; миграции —
`prisma migrate deploy` в build:prod.

Это вымышленный пример: подставьте сюда карту вашего реального проекта.

## key-directories

- src/app: Next.js App Router (страницы, API routes под `src/app/api/*`).
- src/lib: бизнес-логика (платежи, подписки, support-чат, telegram-бот, автоматизации, рассылки).
- src/lib/support: support-pipeline (chat, knowledge, ai-suggest).
- src/lib/telegram: интеграция с Telegram (бот, handlers, helpers, link-token).
- src/lib/payments: денежный поток (confirm, refund, providers, money).
- src/lib/automations: движок drip-кампаний и trigger-based рассылок.
- src/workers: фоновые воркеры (bot, message, automation, chain, reminder).
- src/components: React-компоненты (UI, формы, дашборды).
- src/features: фичевые модули (chat, courses).
- prisma: схема БД и миграции (PostgreSQL).
- prisma/migrations: timestamp-папки с SQL-миграциями (`pnpm seed` для seed-данных).
- blueprint: внутренняя документация проекта (архитектура, домен-модель, юзер-журней).
- business: бизнес-документация (audience, economics, marketing, products, support).
- specs: спеки фич/фаз (по датам).
- scripts: ad-hoc скрипты (бэкфилл, сидинг, аудит).

## key-files

- prisma/schema.prisma: единая схема БД. Источник правды по структуре данных.
- src/middleware.ts: Next.js middleware (auth, csrf, redirects).
- src/instrumentation.ts: bootstrap фоновых сервисов при старте Next.
- src/lib/prisma.ts: singleton Prisma-клиента, connection pooling.
- src/workers/queue.ts: декларация всех очередей и Redis-коннект.
- src/lib/messaging.ts: единая точка отправки сообщений пользователю (email, telegram, push).
- src/lib/access.ts: AccessGrant — контракт «у пользователя есть доступ к ресурсу X».
- src/lib/payments/confirm.ts: атомарное закрытие платежа → выдача доступа.
- src/lib/support/index.ts: точка входа в support-pipeline.
- next.config.mjs: конфиг сборки Next.js, image domains.
- package.json: команды (`dev`, `build:prod`, `bot`, `workers`, `automation-worker`).
- start.sh: production-entrypoint.

## db-connections

- id: example-project-prod
- driver: postgres
- keychainService: ai-cofounder.example-project.db
- description: production-БД проекта (read-only коннект). Whitelist таблиц фаундер заполняет по мере подключения routine'ов — пустой массив значит «routine не может SELECT'ить ничего, явно разреши».
- allowedTables: [users, orders, support_messages]
- queryTimeoutMs: 10000
- rowLimit: 1000

## telegram-channels

## metrics-endpoints

## notes

Когда подключаем `project.db.query` (фаза 2.3) — сначала создаём
read-only Postgres-роль в БД проекта (`GRANT SELECT ON … TO ai_cofounder_ro`),
её DSN кладём в Keychain под `ai-cofounder.example-project.db`,
заполняем `allowedTables[]` начиная с самых безопасных таблиц
(агрегаты по событиям и сообщениям, без полей с PII — например, без
`users.email`/`users.phone`, в SELECT — только агрегаты).

Когда подключаем `project.telegram.read` (фаза 2.4) — добавляем сюда
секцию `## telegram-channels` с записями вида:

  - id: support
    chatId: -100200300400
    purpose: support-чат клиентов
    botKeychainService: ai-cofounder.example-project.tg.support

Сейчас обе секции (db и tg) пустые / placeholder — routine-движок поднимет
ProjectMapError только если routine реально попросит запрещённый ресурс.
