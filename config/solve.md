# Решатель — настройки

Параметры sub-agent'а из `src/solve/run.ts` (фаза 2.4a). Меняешь — поправь этот файл; код подхватит при следующем `solveDiagnosis()`. Никаких хардкодов в TS.

```json
{
  "targetProjectPath": "${PROJECTS_ROOT}/example-project",
  "model": "claude-sonnet-4-6",
  "subagentType": "Plan",
  "timeoutMs": 300000,
  "maxTokens": 100000,
  "maxTurns": 20,
  "promptId": "solve:propose",
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
  "parentSessionPrefix": "solve"
}
```

## Поля

- `targetProjectPath` — абсолютный путь к репозиторию проекта, который читает решатель. Сейчас совпадает с `config/investigate.md` — оба sub-agent'а смотрят в один и тот же проект. Если у фаундера появится несколько проектов — расширяем оба файла одновременно: `targetProjectPath: string` → `targets: Record<projectName, path>`. **Почему отдельный файл, а не один общий с investigate**: контракты разные (исследователь — read-only диагност, решатель — read-only архитектор предложения), таймауты/токены могут разойтись по мере калибровки на реальных данных, и держать «настройки решателя» рядом с `src/solve/` важнее, чем избежать одного дублирования строки. Тесты используют свой fixture-tempdir через `configOverride.targetProjectPath`.
- `model` — какая модель крутит решателя. Sonnet 4.6 — рутинный класс задач (читаем codeRefs из диагноза, читаем файлы, пишем три абзаца + список файлов). Opus здесь избыточен. Менять — ADR.
- `subagentType` — лейбл для Bridge-event `solve.start/end` и для будущей SDK-параметризации (если SDK позволит указать «класс» агента). По плану — `Plan`. У исследователя — `Explore`.
- `timeoutMs` — жёсткий тайм-аут на весь run через `AbortController`. Default 5 мин (как у исследователя). Превышение → `SolveTimeoutError`. **Отличие от исследователя**: у решателя тайм-аут — это ошибка, а не «синтетический unclear». Если решения нет — отдельная ветка для отчёта; не маскируем под пустое предложение.
- `maxTokens` — лимит **input tokens** на одну solve-сессию. По умолчанию 100K — тот же лимит, что у исследователя. Считается по `usage.inputTokens` после run. Превышение → `SolveBudgetExceededError`.
- `maxTurns` — потолок agentic-turns SDK (`Options.maxTurns`). 20 — достаточно для чтения 3-5 файлов + git-history + написание предложения.
- `promptId` — идёт в `audit.spend.properties.promptId`. Стабилен, не меняется. `solve:propose` — потому что это «предложение решения», не сама правка (правка — `execute:run` в M3.3).
- `bashWhitelist` — массив prefix-паттернов: команда разрешается, если `cmd.trim()` начинается с одного из элементов. **Read-only выборка**, дублирует whitelist исследователя из `config/investigate.md`. Это намеренно: 2.4a — решатель, который **только предлагает диф**, не применяет его. Edit/Write/git-commit/git-push — это 3.3a (исполнитель), у того будет свой config с расширенным whitelist'ом. Запрещены явно (т.е. не в списке): `rm`, `mv`, `cp`, `git checkout`, `git reset`, `git push`, `git commit`, `> file`, `&&` с write-командой, `eval`, `curl`, `wget`. Проверка — в `canUseTool` callback (тот же паттерн, что в `src/investigate/run.ts`).
- `concurrency` — потолок одновременно работающих sub-agent'ов в `solveMany()` (фаза 2.4b). 3 — тот же лимит, что у исследователя в `config/investigate.md`, и тот же риск №3 из плана: 3 × `maxTokens` = 300K ровно совпадает с per-cycle cap из `config/budget.md`. Поднимать — синхронно с `config/budget.md`.
- `maxProblemsPerCycle` — soft-cap входного массива `diagnosisIds`. Хвост идёт в `deferred[soft-cap-skip]` + Record `audit.solve.softcap.skip`. 10 — то же значение, что у исследователя; больше за один утренний цикл (M2) фаундер всё равно не прочитает в Telegram.
- `parentSessionPrefix` — prefix для `parentSession` ULID, объединяющего solve.batch.start/end + N×solve.start/end в Bridge. У исследователя — `investigate`, у решателя — `solve`. Не совпадает намеренно: UI рисует разноцветные группы.

## Почему отдельный config-файл, а не один общий с investigate

CLAUDE.md правило 1 («не хардкодить динамику») + правило 10 («любая правка стека = ADR»). У исследователя и решателя могут разойтись лимиты после первой калибровки на реальных данных проекта. Один общий файл вынудил бы ждать «общую» правку при изменении любого. Лучше два файла со 70% общего содержания (которое всё равно копи-паст из CLAUDE.md).

## Когда менять

- Поднимаем `maxTokens` — рискуем сжечь дневной бюджет. Митигация: per-cycle cap 300K в `config/budget.md` отрубит fan-out раньше.
- Расширяем `bashWhitelist` — оборачиваем в ADR: что добавили и почему read-only гарантия не нарушена.
- Меняем `targetProjectPath` — синхронизируем с `config/investigate.md`. На multi-project — расширяем shape вместе с `loadInvestigateConfig`/`loadSolveConfig` одной фазой.
