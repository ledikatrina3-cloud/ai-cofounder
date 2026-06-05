# Реестр проектов AI-Cofounder

Источник правды: какие проекты у фаундера и где они физически живут на маке.
Из этого реестра routine-движок (фаза 1.3) выбирает контекст для каждого
запуска: путь к коду, ссылку на карту, glob с routine-файлами проекта.

Формат:
- Каждая секция `## <id>` — один проект. `<id>` — стабильный slug
  (`example-project`, `myapp`, `client-acme`), используется как FK из routine'ов
  и из логов. Ломать — миграция в коде; новый id — новая секция.
- Внутри секции — строки `- <key>: <value>`. Игнорируются пустые строки и
  все, что не подходит под этот шаблон (см. `src/lib/page-sections.ts`).
- Обязательные поля: `name`, `path`, `enabled`, `mapPath`, `routinesGlob`.
  Отсутствие — `ProjectMetaError` при `getProject(id)`.
- `path` — абсолютный путь. Если папки физически нет, `getProject(id)`
  отдаст `enabled=false` динамически (даже если в файле `enabled: true`)
  и пишет warning в `console.warn` — это graceful-degradation для
  multi-mac setup'а (ноут / десктоп).

Что НЕ хранится здесь (намеренно):
- Credentials к БД и Telegram-ботам — они в Keychain под именованным
  service-key. Карта `projects/<id>/map.md` ссылается на service-key,
  не на пароль.
- Cron-расписания — они в `routines/<id>.md` (фаза 1.2), у каждой
  routine своё.
- Бюджет — глобальный в `config/budget.md`, не per-project.

Изменение реестра:
- Добавить проект → новая секция `## <id>` руками.
- Отключить временно → `- enabled: false`.
- Перенести проект на другой mac → правишь `path` (либо `enabled: false`
  на старом маке через переменное окружение в будущем).

## example-project

- name: Acme Academy
- path: ${PROJECTS_ROOT}/example-project
- enabled: true
- mapPath: projects/example-project/map.md
- routinesGlob: routines/example-project-*.md

## ai-cofounder-marketing

- name: AI-Cofounder Marketing
- path: ${PROJECTS_ROOT}/ai-cofounder
- enabled: true
- mapPath: projects/ai-cofounder-marketing/map.md
- routinesGlob: routines/ai-cofounder-marketing-*.md

## marketing-content

- name: Marketing Content (department)
- path: ${PROJECTS_ROOT}/ai-cofounder
- enabled: true
- mapPath: projects/marketing-content/map.md
- routinesGlob: routines/marketing-content-*.md
