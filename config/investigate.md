# Исследователь — настройки

Параметры sub-agent'а из `src/investigate/run.ts` (фаза 2.3a). Меняются — поправь этот файл; код подхватит при следующем `investigateProblem()`. Никаких хардкодов в TS.

```json
{
  "targetProjectPath": "${PROJECTS_ROOT}/example-project",
  "model": "claude-sonnet-4-6",
  "subagentType": "Explore",
  "timeoutMs": 300000,
  "maxTokens": 100000,
  "maxTurns": 20,
  "promptId": "investigate:run",
  "bashWhitelist": [
    "git log",
    "git show",
    "git blame",
    "git diff",
    "git status",
    "git branch",
    "cat",
    "head",
    "tail",
    "wc",
    "find",
    "ls",
    "rg",
    "grep",
    "pwd"
  ],
  "concurrency": 3,
  "maxProblemsPerCycle": 10,
  "parentSessionPrefix": "investigate"
}
```

## Поля

- `targetProjectPath` — абсолютный путь к репозиторию проекта, который исследователь читает. По умолчанию `${PROJECTS_ROOT}/example-project`. Если папки физически нет — `investigateProblem()` падает с понятной ошибкой; обнови путь и положи проект по нему. Тесты используют свой fixture-tempdir через `runOverride.targetProjectPath`.
- `model` — какая модель крутит исследователя. Sonnet 4.6 — рутинный класс задач (grep + чтение + git log + одно решение «код или человек»), не требует Opus. Менять — ADR.
- `subagentType` — лейбл для Bridge-event `subagent.start`. Не SDK-параметр: верхнеуровневый `query()` уже играет роль исследователя, второго уровня sub-agent нет.
- `timeoutMs` — жёсткий тайм-аут на весь run через `AbortController`. Default 5 мин из плана. Превышение → `verdict='unclear'`, `rationale='тайм-аут N мин'`.
- `maxTokens` — лимит **input tokens** на одну investigation (план: 100K). Считается по `usage.inputTokens` после run. Превышение → `InvestigateBudgetExceededError`, обработает 2.3b.
- `maxTurns` — потолок agentic-turns SDK (`Options.maxTurns`). 20 — достаточно для grep + чтение 3-5 файлов + git log + ответ. Слишком высокое значение бессмысленно при `timeoutMs=5min` (упрёмся раньше).
- `promptId` — идёт в `audit.spend.properties.promptId`. Стабилен, не меняется.
- `bashWhitelist` — массив prefix-паттернов: команда разрешается, если `cmd.trim()` начинается с одного из элементов. Read-only выборка: `git log/show/blame/diff/status/branch`, `cat/head/tail/wc/find/ls/rg/grep/pwd`. **НЕ в списке** (==запрет): `rm`, `mv`, `cp`, `git checkout`, `git reset`, `git push`, `git commit`, `> file`, `&&` с write-командой, `eval`, `curl`, `wget`. Проверка — в `canUseTool` callback.
- `concurrency` — сколько sub-agent'ов исследователя бегут параллельно в `investigateMany()` (фаза 2.3b). Default 3 — компромисс из риска №3 плана: при 100K токенов на проблему и `perCycle=300K`, три параллельных исчерпают cap почти точно; четвёртый и далее упрутся в `BudgetExceeded` ещё до сетевого hop'а. Поднимать вместе с `perCycle` в `config/budget.md`.
- `maxProblemsPerCycle` — soft-cap количества проблем в одном fan-out'е. Default 10 (предельная оценка плана). Если триаж выдал больше — хвост попадает в `audit.investigate.softcap.skip` и обработается на следующей итерации. Не путать с per-cycle токен-cap'ом из budget.md (тот hard-cap, этот — заранее обрезает заведомо невыполнимый объём).
- `parentSessionPrefix` — лейбл-префикс для группировки события `subagent.start/end` в Bridge UI. Default `investigate`. Сейчас не используется в логике (parentSession = ULID как есть), оставлен на будущее (если появятся параллельные batch-ы с разными именами).

## Почему отдельный config-файл, а не const в коде

CLAUDE.md правило 1 («не хардкодить динамику»). `targetProjectPath` особенно — у фаундера он один, у тестов — tempdir, у будущего multi-project — массив (расширим shape, но файл уже есть). Парсинг копирует паттерн `config/triage.md` / `config/embeddings.md`.

## Когда менять

- Поднимаем maxTokens — рискуем сжечь дневной бюджет (10 проблем × 200K = 2M input × Sonnet rate). Митигация: per-cycle cap 300K в `config/budget.md` отрубит fan-out раньше.
- Расширяем `bashWhitelist` — оборачиваем в ADR: что добавили и почему read-only гарантия не нарушена.
- Меняем `targetProjectPath` — если у фаундера несколько проектов, расширяем shape: `targetProjectPath: string` → `targets: Record<projectName, path>`. Тогда же расширяем `investigateProblem()` для выбора проекта по `intent.problem.subjectPagePath`.
