# Карта проекта AI-Cofounder Marketing

«Виртуальный отдел маркетинга». Сотрудники этого проекта публикуют посты
в соцсети от лица фаундера: vc.ru, Дзен, Reddit, LinkedIn. Рабочая
директория — сам репо AI-Cofounder: здесь живут черновики
(`content/drafts/<platform>/<slug>.md`) и кнопка публикации
(`pnpm publish <platform> <draft>`), которая открывает браузер с
залогиненным persistent profile (см. `src/browser/`) и проходит сценарий
публикации руками — как человек.

## description

Маркетинговый отдел AI-Cofounder: ежедневная публикация ready-черновиков
в социальные сети. Каждый сотрудник (routine) отвечает за одну
платформу. Перед публикацией сотрудник проверяет, что в директории
платформы есть черновик со `status: ready` на сегодняшнюю дату, вызывает
`pnpm publish <platform> <draft> --yes`, ловит URL опубликованного поста
из stdout publisher'а и шлёт фаундеру отчёт в Telegram.

## key-directories

- content/drafts: черновики постов, разложены по platform-поддиректориям (vc/, dzen/, reddit/, linkedin/).
- src/browser: обёртка над patchright (Playwright + anti-detect) с persistent profile per (platform, account).
- src/publish: per-platform публикаторы. vc.ts — единственный готовый сейчас.
- scripts: CLI-инструменты, в т.ч. publish.ts (точка входа для `pnpm publish`).

## key-files

- content/drafts/README.md: формат черновика, workflow (draft → ready → published).
- src/publish/loader.ts: парсер markdown-frontmatter драфта.
- src/publish/vc.ts: публикатор vc.ru — открывает редактор, заполняет, кликает «Опубликовать», возвращает URL.
- scripts/publish.ts: CLI-обёртка. Stdout: «✓ опубликовано: URL: https://vc.ru/...» при успехе.
- scripts/browser-login.ts: wizard первичного логина (фаундер запускает руками для каждой новой связки platform/account).

## db-connections

Маркетинговый отдел не работает с продуктовыми БД проектов — он работает
с файлами черновиков и с браузером. Поэтому секция пустая по дизайну.

## telegram-channels

Отчёт о публикации идёт в дефолтный канал founder-allowlist (см.
`config/allowlist.md`) через `outputType: telegram-thread` routine'ы.
Отдельной project-secition для маркетинга не нужно.

## notes

**Что разрешено маркетологу-routine'у в Bash:**

Routine получает право расширить DEFAULT_WHITELIST через frontmatter
`bashWhitelist`. Для текущих публикаторов добавляется минимум:

- `pnpm publish vc` — вызов CLI-публикатора для vc.ru.
- В будущем для других платформ: `pnpm publish dzen`, `pnpm publish reddit`, и т.д.

Никаких других write-команд (никакого `git`, `pnpm install`, и т.п.) —
если routine попробует `pnpm install`, canRunCommand откажет, и
`audit.security.tool.deny` запишется в журнал.

**Запуск зависит от:**

1. Persistent profile уже создан (фаундер один раз запустил
   `pnpm browser:login <platform> <account>` и залогинился руками).
2. Mac не спит (cron-routine не может разбудить ноут).
3. В `content/drafts/<platform>/` есть файл со `status: ready`.

Если профиль не создан или сессия истекла — publisher вернёт
non-zero exit с человекочитаемым сообщением. Маркетолог-routine должен
поймать это и отрапортовать фаундеру: «не могу опубликовать, нужен
повторный логин».
