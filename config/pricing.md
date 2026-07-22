# Тарифы Anthropic — источник правды

Цены для расчёта `audit.spend.properties.usd`. Меняются — поправь этот файл; mtime становится `pricingAsOf` каждой следующей записи аудита (см. `config/pricing.md:9`).

Числа — USD за 1M токенов. Источник: [config/pricing.md:39](../config/pricing.md#L39).

```json
{
  "models": {
    "claude-opus-4-7": {
      "input": 15.0,
      "output": 75.0,
      "cacheWrite": 18.75,
      "cacheRead": 1.5
    },
    "claude-sonnet-4-6": {
      "input": 3.0,
      "output": 15.0,
      "cacheWrite": 3.75,
      "cacheRead": 0.3
    },
    "claude-haiku-4-5-20251001": {
      "input": 1.0,
      "output": 5.0,
      "cacheWrite": 1.25,
      "cacheRead": 0.1
    }
  },
  "aliases": {
    "claude-opus-4-7[1m]": "claude-opus-4-7",
    "claude-haiku-4-5": "claude-haiku-4-5-20251001"
  }
}
```

## Как менять

1. Поправь числа или добавь модель в блок `models` выше.
2. `pnpm db:check` — он не упадёт, но при следующем `call(...)` `pricingAsOf` уже будет новый.
3. Зафиксируй причину правки коммитом — `audit.spend.pricingAsOf` будет ссылаться на эту версию.

`aliases` нужны для того, чтобы внутренний идентификатор модели Claude (например, `claude-opus-4-7[1m]`) разрешался в имя API. Никаких хардкодов в коде — всё здесь.
