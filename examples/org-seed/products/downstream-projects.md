# Downstream-проекты — где AI-кофаундер реально работает

AI-кофаундер — это «штаб-квартира». В нём живут [[employees]], но **работают**
они в downstream-проектах через cross-project runner (см.
[`plans/`](../../plans/)).

Реестр downstream-проектов: [`config/projects.md`](../../config/projects.md).
Контракт: id + name + path + enabled + mapPath + routinesGlob.

## Текущие проекты

### 🌐 example-project (Acme Academy)

- **Путь:** `${PROJECTS_ROOT}/example-project`
- **Что это:** основной бизнес фаундера (пример). Online-course SaaS:
  курсы + публичный блог (SEO-гайды по AI-инструментам).
- **Где работают агенты:**
  - Гайд-райтер (пишет гайды в блог) - daily/triweekly
  - Финансовый аналитик (выручка вчера)
  - Critical-alerts (support-чат каждые 30 мин)
  - Support-triage (жалобы → причины)
  - DB morning triage (аномалии за 24ч)
  - Weekly metrics (понедельник утром)
- **Skills которые там живут (cross-project):** `build-guide`,
  `build-instruction`, `build-vc-spoke`, `ui-ux-pro-max` (см. [[skills]]).

### 🏢 ai-cofounder-marketing

- **Путь:** корень этого репозитория (HQ)
- **Что это:** маркетинг самого AI-кофаундера (если/когда будем продвигать
  как продукт).
- **Где работают агенты:**
  - Маркетолог vc.ru (публикует ready-черновики)
  - Smoke unattended (регрессионные тесты инфры)
  - Demo-routine для skill-инфраструктуры

### 📂 marketing-content (department-project)

- **Путь:** тот же корень репозитория (HQ)
- **Что это:** «папка отдела» — где собираются draft'ы пока ждут approve.
- **Сотрудники:** 6 платформенных писателей (см. [[employees]] + [[departments]]).

## Контракт cross-project запуска

Когда routine в HQ имеет `targetProject: <id>` — диспатчер идёт в ветку
`executeUnattendedRoutine` (см. [`src/routines/runtime.ts`](../../src/routines/runtime.ts)):

1. Резолвит `targetProject` через `config/projects.md`.
2. Спавнит `claude --print --output-format stream-json --permission-mode bypassPermissions --max-turns 500` с `cwd = project.path`.
3. Body routine'а уходит в stdin (промт).
4. Внутри той сессии Claude видит `targetProject/.claude/skills/*`, `CLAUDE.md` чужого репо, свои MCP-серверы — и работает там как «нанятый внешний агент».
5. NDJSON-стрим возвращается обратно в bridge → audit + Telegram.

**Защита от misfire:** disabled projects (нет физического пути) — блокируются
до старта (мы не вызовем skill в репо, которого нет на маке).

## Как добавить новый downstream-проект

1. Прописать в [`config/projects.md`](../../config/projects.md): секция `## <id>` с обязательными полями.
2. Создать `projects/<id>/map.md` — карту внешнего проекта (что у него за БД, какие env, какие entrypoints).
3. Создать routine с `targetProject: <id>` (см. [[employees]] → «Как добавить»).
