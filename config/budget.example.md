# Бюджет — лимиты cost-meter'а

Hard-cap'ы для `src/llm/call.ts`. Превышение → `BudgetExceededError` + `audit.budget.deny` Record. Все проверки происходят **до** сетевого вызова к Anthropic.

Дефолты — из [config/pricing.md:97](../config/pricing.md#L97). Меняй здесь, не в коде.

```json
{
  "perCycle": {
    "inputTokens": 300000,
    "comment": "input tokens за один цикл runIteration; cycle = период с момента последнего event.trigger"
  },
  "daily": {
    "usd": 10.0,
    "comment": "сумма USD за календарные сутки UTC; считается по audit.spend.properties.usd"
  },
  "monthly": {
    "usd": 150.0,
    "comment": "сумма USD за календарный месяц UTC"
  }
}
```

## Семантика проверки

- Перед каждым `call(...)` сравниваем накопленный spend с лимитом. Если **уже** ≥ лимита — отказ.
- Текущий `call` может перетянуть лимит на свою величину. Это сознательно — иначе пришлось бы предсказывать токены до вызова. Hard-cap здесь = «не делать N+1-й вызов после того, как N-й увёл за линию».
- `perCycle.inputTokens` суммирует только `audit.spend.properties.inputTokens` (без output, без cache_read) — лимит токенов, как в плане 1.3.

## Тестовые сниппеты

В тестах `src/llm/budget.ts:loadBudgetLimits()` принимает override-объект через DI (опциональный аргумент), чтобы не править `config/budget.md` ради $0.001-теста. В проде override не передаётся.
