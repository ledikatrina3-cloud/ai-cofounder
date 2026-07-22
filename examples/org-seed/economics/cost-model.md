# Экономика AI-кофаундера

Как работают деньги: что платим, сколько стоит сотрудник, где экономим.

Связано: [[../products/employees]] (кто тратит), [[../products/departments]]
(per-day cap'ы), [`config/budget.md`](../../config/budget.md) (live-настройки).

## Принцип: прямой биллинг по API-токенам

Дефолтный транспорт (см. src/llm/transport.ts): LLM-вызовы идут напрямую в Anthropic API по
`ANTHROPIC_API_KEY` (`LLM_TRANSPORT=apikey`). Каждый прогон тарифицируется
по фактическим токенам.

**Что это даёт:**
- Прозрачный per-routine billing. `audit.spend.usd` в БД отражает реальный
  расход прогона - можно сравнивать «дороже / дешевле» и резать перерасход.
- Никакого скрытого state: ключ в `.env.local` (dev) или Keychain (prod),
  стоимость считается из `total_cost_usd` в `result`-event'е.

**Что НЕ даёт:**
- Нет фиксированного потолка - счёт растёт с использованием. Поэтому
  бюджет-гарды (ниже) обязательны для unattended-прогонов.

## Транспорты

1. **`LLM_TRANSPORT=apikey`** (default, рекомендуемый) - прямой Anthropic API
   через `ANTHROPIC_API_KEY`. Real billing per token. `audit.spend.usd` =
   фактический расход.
2. **`LLM_TRANSPORT=oauth`** (экспериментальный, НЕ endorsed) - маршрут через
   локальный gateway. Gateway в репо не входит, может конфликтовать с ToS
   провайдера. Использовать на свой риск.

См. [src/llm/transport.ts](../../src/llm/transport.ts).

## Цены прогонов

Ориентиры по фактическому per-token биллингу (Anthropic public pricing,
сверяй с `config/pricing.md`):

| Сотрудник | Цена/прогон | Длительность | Источник |
|---|---|---|---|
| Гайд-райтер example-project | $0.50-$1.50 | 25-90 мин | один цикл многоэтапного workflow |
| Финансовый аналитик | $0.01-$0.05 | 30-60 сек | SQL + summary |
| Critical-alerts | $0.01 | <30 сек | grep + если тригер → escalate |
| Support-triage | $0.05-$0.10 | 1-2 мин | прочесть N сообщений, классифицировать |
| Маркетолог | $0.10-$0.30 | 5-15 мин | публикация через browser |
| example-noop | $0.01 | ~10 сек | health-check |

## Бюджеты

Уровни budget guard (см. `src/llm/budget.ts` + `src/llm/department-budget.ts`):

### Per-cycle (одна routine-сессия)
- Cap `maxStepsPerInvocation` в skill.permissions - защита от инфинит-лупа.
- `--max-turns 500` для unattended cross-project - многоэтапный workflow со
  sub-agent'ами легко делает сотни turns.

### Per-routine (одна routine за день)
- Опциональное поле `budget: { perRunUsd, perDayUsd }` во frontmatter.
- Пока используется только для [[../products/departments]] (department-level cap).

### Per-department (все routines одного отдела)
- `departments/<id>/DEPARTMENT.md` → `budget.perDayUsd` + `perRunUsd`.
- Pre-call guard агрегирует spend всех routines с тем же `departmentId`.
- При превышении следующий прогон сразу падает с `budget_exceeded`, не
  тратит API.

### Per-global (config/budget.md)
- Per-cycle / daily / monthly. Используется для всех in-process subagent'ов
  (не unattended).

## Что реально дорого

Что жжёт бюджет быстрее всего:

1. **Многоэтапные workflow'ы** (гайд-райтер, инструкция-курс). Многочасовые
   сессии, многие sub-agent'ы, тяжёлый skill.
2. **Multi-agent QA-этап** блог-гайда - несколько параллельных QA-агентов
   (Anti-AI, Legal, Tone, Fact, SEO+GEO, Cross-link).
3. **Deep research** через параллельные Agent на research-этапе (Reddit/HN/X/YouTube).
4. **Длинные cache-creation токены** при первом чтении больших файлов. См.
   spend-record audit: `cacheCreationTokens` - самая дорогая категория.

## Где экономим

1. **Skills lazy-load.** Discovery layer ~80 ток/скилл всегда, body - только
   если `forceLoad` или агент решил использовать.
2. **Org-knowledge только когда нужно.** writing/research-скиллы инжектируют
   `org/identity` + `org/brand-voice` + `org/audience`. Routine без таких
   скиллов не грузит org/.
3. **Pre-call budget guard.** Если бюджет превышен - даже не спавним
   subprocess.
4. **JSONL warmup при рестарте bridge.** Не пересоздаём контекст из API,
   читаем с диска.

## Будущие фичи экономики

- **Soft warnings.** При 80% бюджета - warning в Telegram, не block.
- **Auto-throttling.** При 100% - пауза до начала следующего периода.
- **Per-model routing.** Дешёвые задачи на Haiku, дорогую архитектуру на Opus.
