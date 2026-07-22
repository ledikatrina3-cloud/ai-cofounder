# Утренний отчёт — настройки

Параметры сборки и отправки утреннего отчёта (фаза 2.5). `src/report/morning.ts` (`buildReport`) + `src/report/sender.ts` (`sendReport`) читают этот файл при каждом вызове. CLAUDE.md правило 1: ни одного хардкода в TS — лимит длины Telegram, путь к Page-overflow, имена шаблонов всё здесь.

```json
{
  "telegramMessageLimit": 4096,
  "templatesDir": "src/report/templates",
  "headerTemplate": "header.md",
  "emptyTemplate": "empty.md",
  "codeTemplate": "code.md",
  "codeNoProposalTemplate": "code-no-proposal.md",
  "humanTemplate": "human.md",
  "unclearTemplate": "unclear.md",
  "failureTemplate": "failure.md",
  "errorReportTemplate": "error.md",
  "overflowPageDir": "journal/proposals",
  "overflowPageType": "archive",
  "overflowSuffixTemplate": "… ещё в `{{path}}`",
  "parseMode": "Markdown",
  "sendRetries": 2,
  "sendRetryBaseMs": 250,
  "sendRetryJitterMs": 250,
  "usdCap": 10
}
```

## Поля

- `telegramMessageLimit` — жёсткий лимит длины одного Telegram-сообщения (риск №10 плана). Один блок текста в parse_mode='Markdown' не должен превышать. На overflow — обрезаем + ссылка на Page.
- `templatesDir` — где лежат `.md`-шаблоны сообщений. Каждый шаблон — одна Telegram-плашка с `{{placeholder}}`-полями. Никакого хардкода фраз в TS.
- `headerTemplate` — шапка треда (1 сообщение). Поля: `problemsTotal`, `problemsWord`, `codeCount`, `humanCount`, `unclearCount`, `usdSpent`, `usdCap`, `deferredNote`.
- `emptyTemplate` — отчёт «нечего разбирать». Поля: `eventTriggerId` (опционально, для drill-down).
- `codeTemplate` — `verdict='code'` + есть `intent.proposal`. Поля: `summary`, `asIs`, `problem`, `asWillBe`, `filesList`, `estimateMinutes`.
- `codeNoProposalTemplate` — `verdict='code'`, но решатель не дал proposal (упал/упёрся в budget). Поля: `summary`, `rationale`, `diagnosisId`.
- `humanTemplate` — `verdict='human'`. Поля: `summary`, `rationale`.
- `unclearTemplate` — `verdict='unclear'`. Поля: `summary`, `rationale`.
- `failureTemplate` — `audit.investigate.failed` или `audit.solve.failed` для проблемы. Поля: `step`, `message`, `summary`.
- `errorReportTemplate` — `runIteration` упал на `<step>`. Поля: `step`, `message`. Используется на fail-fast.
- `overflowPageDir` — относительный путь для Page-overflow при превышении `telegramMessageLimit`. Файл создаётся как `<dir>/<ulid>.md`, INSERT-ится `Page` с этим path и type=`overflowPageType`. CompanyWiki-архитектура (prisma/schema.prisma): Page — индекс файла, файл живёт в git.
- `overflowPageType` — `Page.type` для overflow-страниц. Default `archive` — нашли подходящий из канона (см. сущности.md), смысл «архивный текст для drill-down». Менять на `'journal'`, если решим формализовать новый тип.
- `overflowSuffixTemplate` — что дописывается к обрезанному сообщению. `{{path}}` → путь к Page'е.
- `parseMode` — Telegram parse_mode. Markdown по умолчанию (план). На «нерендерящиеся» куски — fallback на HTML (см. шапку sender.ts).
- `sendRetries` — сколько повторов при сетевой ошибке Telegram. План: 2.
- `sendRetryBaseMs` — базовая задержка перед retry в мс.
- `sendRetryJitterMs` — добавка случайного jitter'а в мс (random ∈ [0, jitter]).
- `usdCap` — дневной cap бюджета для строки шапки «$X.XX из $Y.YY». **Дублирует** значение из `config/budget.md` (daily.usd) намеренно: формат отчёта = вёрстка, не доменная политика. Менять синхронно.

## Когда менять

- Telegram поднял лимит — поправь `telegramMessageLimit`.
- Хочешь новый стиль шапки или формат блока — правь `.md` в `templatesDir`. TS не трогается.
- Решил, что overflow Page лежит в `_журнал/proposals/`, а не `journal/proposals/` — поправь `overflowPageDir`.
- Подняли cap в `config/budget.md` — **синхронно** правь `usdCap` тут (или вынеси через общий `config/limits.md` на M4).
