-- ============================================================
-- Идемпотентность event.trigger: партишн-UNIQUE по (idempotencyKey)
-- среди event.trigger Записей.
--
-- Источник:
--   architecture/03-данные/правила-нерушимые.md:31 (CHECK NOT NULL для event.trigger)
--   architecture/03-данные/правила-нерушимые.md:32 (UNIQUE по всей таблице)
--   architecture/04-потоки/триггеры.md:46 (защита от дублей через idempotencyKey)
--   architecture/04-потоки/путь-данных.md:30 (паттерн ON CONFLICT(idempotencyKey) DO NOTHING)
--   plans/ (фаза 1.4)
--
-- Зачем отдельный партишн-индекс, если глобальный UNIQUE на idempotencyKey уже стоит:
--   1. Документирует контракт «event.trigger.idempotencyKey уникален» в DDL,
--      а не только в global UNIQUE'е (читая schema.prisma, легче считать инвариант).
--   2. Belt-and-suspenders: если когда-нибудь захотим разрешить
--      audit.repeat / audit.cancel переиспользовать ключ исходного триггера
--      (сейчас они не пишут idempotencyKey, но ограничение мягче глобального),
--      партишн-UNIQUE для event.trigger останется на месте.
--   3. SQLite оптимизирует ON CONFLICT по партишн-индексу при наличии
--      WHERE предиката — explicit плана выполнения для INSERT-кейса.
--
-- Этот индекс СЕМАНТИЧЕСКИ слабее глобального Record_idempotencyKey_key
-- (требует уникальности только среди event.trigger), но для валидных данных
-- оба удовлетворяются одновременно. Конфликта нет.
-- ============================================================

CREATE UNIQUE INDEX "Record_event_trigger_idempotencyKey_idx"
ON "Record" ("idempotencyKey")
WHERE "type" = 'event.trigger';
