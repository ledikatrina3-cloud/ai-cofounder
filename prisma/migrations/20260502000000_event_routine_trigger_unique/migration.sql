-- ============================================================
-- Идемпотентность event.routine.trigger: партишн-UNIQUE по (idempotencyKey)
-- среди event.routine.trigger Записей.
--
-- Источник:
--   plans/ (фаза 1.3 — dispatcher).
--   architecture/03-данные/правила-нерушимые.md:31..32 (UNIQUE и идемпотентность).
--   prisma/migrations/20260430220000_event_trigger_unique (аналог для старого
--     pipeline'а — этот файл повторяет паттерн под новый тип Record).
--
-- Зачем отдельный партишн-индекс, если глобальный Record_idempotencyKey_key
-- уже стоит:
--   1. Документирует контракт «event.routine.trigger.idempotencyKey уникален»
--      в DDL: читая schema.prisma + миграции, инвариант виден без Grep'а.
--   2. Belt-and-suspenders: если когда-нибудь захотим разрешить audit.repeat /
--      audit.cancel переиспользовать ключ исходного routine-trigger'а
--      (сейчас они не пишут idempotencyKey — global UNIQUE их не зацепит,
--      но семантически правильнее иметь явное partial-UNIQUE на event.routine.trigger).
--   3. SQLite оптимизирует ON CONFLICT по партишн-индексу при наличии WHERE
--      предиката — explicit плана выполнения для INSERT-кейса dispatcher'а.
--
-- Этот индекс СЕМАНТИЧЕСКИ слабее глобального Record_idempotencyKey_key
-- (требует уникальности только среди event.routine.trigger), но для валидных
-- данных оба удовлетворяются одновременно. Конфликта нет.
--
-- Smoke-валидатор (src/db/invariants-check.ts) НЕ требует расширения:
--   * Никаких новых колонок Record не добавлено → триггер
--     `record_immutable_fields` остаётся покрывающим.
--   * Index — это не CHECK и не trigger, валидатор его не сверяет.
--   * Тип `event.routine.trigger` не входит в whitelist'ы валидатора —
--     записывается как обычный Record, properties = JSON.
-- ============================================================

CREATE UNIQUE INDEX "Record_event_routine_trigger_idempotencyKey_idx"
ON "Record" ("idempotencyKey")
WHERE "type" = 'event.routine.trigger';
