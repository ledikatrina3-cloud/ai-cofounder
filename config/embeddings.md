# Embeddings — конфиг

Параметры embedding-провайдера и семантического мерджа триажа (фаза 2.2b).
Меняешь модель/threshold — правишь этот файл, не код. Любая смена `dim`
требует `pnpm db:reset` (virtual table нельзя пересоздать без потери данных).

## Конфигурация

```json
{
  "provider": "xenova-local",
  "model": "Xenova/multilingual-e5-small",
  "dim": 384,
  "mergeThreshold": 0.85,
  "mergeWindowDays": 7,
  "vecTable": "vec_intent_problem"
}
```

## Смысл полей

- **provider** — кто считает embedding. Сейчас `xenova-local` (через
  `@xenova/transformers`, локально на маке, без сети). Альтернативы — Voyage
  или OpenAI; тогда нужен Keychain-секрет и pairing-скрипт.
- **model** — конкретная модель. `Xenova/multilingual-e5-small` — 384-dim,
  multilingual (русский + английский), ~120MB на диск, ~50ms/embedding после
  warmup на M-серии. Первая загрузка качает модель в `~/.cache/huggingface/`.
  Альтернативы: `Xenova/multilingual-e5-base` (768-dim, точнее, ~280MB) —
  `dim` тогда становится 768.
- **dim** — размерность вектора. Должна совпадать с моделью. Используется
  при `CREATE VIRTUAL TABLE vec_intent_problem USING vec0(embedding float[<dim>])`.
- **mergeThreshold** — порог cosine similarity (НЕ distance) для слияния
  проблем. Similarity ≥ threshold → merge с существующей `intent.problem`,
  иначе → новая. **0.85 — палец в небо**, см. risk #2 в плане. Будет
  откалиброван на реальных данных проекта в первую неделю M2.
- **mergeWindowDays** — сколько дней назад искать открытые `intent.problem`
  для дедупа. 7 дней — компромисс между «не повторять вчерашнее» и «не
  объединять старое с новым».
- **vecTable** — имя virtual table. Менять не нужно; зафиксировано здесь
  для единого источника правды (миграция, init-скрипт, merge.ts).

## Про cosine distance vs similarity

sqlite-vec возвращает **distance**, мы сравниваем с **similarity**:

```
cosine_similarity = 1 - cosine_distance
similarity ≥ 0.85  ≡  distance ≤ 0.15
```

В коде SQL `WHERE distance <= (1 - mergeThreshold)`.

## Exit-критерий (смена провайдера)

Переключение `provider` с `xenova-local` на `voyage` / `openai` =
- новый Keychain-сервис + pairing-скрипт;
- новая `dim` → `pnpm db:reset` обязателен;
- новый ADR-NNNN, не молчаливая правка этого файла.
