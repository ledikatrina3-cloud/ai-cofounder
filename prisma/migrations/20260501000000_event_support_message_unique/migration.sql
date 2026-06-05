-- ============================================================
-- Дедуп event.support.message: партишн-UNIQUE на JSON-полях
-- (properties.chatId, properties.messageId) среди support-сообщений.
--
-- Источник:
--   plans/ (фаза 2.1b)
--   architecture/03-данные/правила-нерушимые.md:31..32 (UNIQUE и идемпотентность)
--   architecture/05-интеграции/telegram.md (секция «Support-бот»)
--
-- Зачем именно так:
--   * `event.support.message` приходит из Telegram через `bot.api.getUpdates`.
--     Telegram сам не даёт глобально-уникального ключа в шкалах AI-Cofounder:
--     `update_id` уникален на бота, но повторный fetch без offset вернёт те же
--     обновления заново. Уникальная пара — `(chat.id, message.id)`.
--   * Ключ кладётся в JSON `properties`, а не в hot-path колонку Record:
--     architecture/03-данные/сущности.md:119 — поднимаем колонки только под
--     реальные горячие запросы. Дедуп — это INSERT-конфликт, hot-path не нужен.
--   * Поэтому индекс — на `json_extract(properties, '$.chatId')` и
--     `json_extract(properties, '$.messageId')`. SQLite (3.10+) индексирует
--     детерминированные expression'ы; JSON1 включён по дефолту в 3.38+
--     (project на 3.46). Партишн `WHERE type='event.support.message'` —
--     чтобы не задевать остальные подтипы Record.
--
-- Smoke-валидатор (src/db/invariants-check.ts) НЕ требует extension'а:
--   * Никаких новых колонок Record не появилось → триггер
--     `record_immutable_fields` остаётся покрывающим (см. ретро 1.1, секция
--     «Что нашёл во втором ревью»).
--   * Index — это не CHECK и не trigger, валидатор его не сверяет (пока).
--     Если в будущем понадобится, добавим в `assertSchemaInvariants` сверку
--     присутствия по имени.
--
-- INSERT-паттерн: `ON CONFLICT DO NOTHING RETURNING id` (без conflict-target).
--   * SQLite UPSERT конфликт-таргетом для expression-индекса не умеет.
--     Без таргета — поведение совместимое: матчится любое UNIQUE/PK violation.
--     Для event.support.message единственный возможный UNIQUE-конфликт — этот
--     индекс (idempotencyKey support-сообщения не пишут), поэтому семантически
--     эквивалентно «дубликат → silent skip».
--
-- Конфликт с глобальным `Record_idempotencyKey_key` исключён: support-message
-- не задаёт idempotencyKey, NULL'ы в SQLite в UNIQUE'е не считаются равными.
-- ============================================================

CREATE UNIQUE INDEX "Record_event_support_message_chatId_messageId_unique"
ON "Record" (
    json_extract("properties", '$.chatId'),
    json_extract("properties", '$.messageId')
)
WHERE "type" = 'event.support.message';
