-- ============================================================
-- AI-Cofounder schema invariants.
--
-- Источник правил: architecture/03-данные/правила-нерушимые.md
-- Источник модели: architecture/03-данные/schema.prisma (комментарий внизу).
--
-- Prisma не умеет CHECK и триггеры — они кладутся отдельной миграцией.
-- Здесь две вещи:
--   1. Перестроение Record и RecordLink с добавлением CHECK constraint'ов
--      (SQLite не умеет ALTER TABLE ADD CHECK — нужен rebuild).
--   2. Триггеры BEFORE DELETE / BEFORE UPDATE на Record, которые делают
--      append-only инвариантом БД, а не дисциплиной.
-- ============================================================

PRAGMA foreign_keys=OFF;

-- ============================================================
-- Record: rebuild с CHECK constraint'ами
-- ============================================================

CREATE TABLE "Record_new" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "type" TEXT NOT NULL,
    "properties" TEXT NOT NULL,
    "parentId" TEXT,
    "actorKind" TEXT NOT NULL,
    "actorRef" TEXT,
    "subjectPagePath" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT (CAST(unixepoch('now', 'subsec') * 1000 AS INTEGER)),
    "status" TEXT NOT NULL DEFAULT 'active',
    "closedAt" DATETIME,
    "closedReason" TEXT,
    "dueAt" DATETIME,
    "priority" INTEGER,
    "visibility" TEXT NOT NULL DEFAULT 'autonomous',
    "idempotencyKey" TEXT,
    CONSTRAINT "Record_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "Record" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Record_subjectPagePath_fkey" FOREIGN KEY ("subjectPagePath") REFERENCES "Page" ("path") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "record_created_at_typeof_check" CHECK (typeof("createdAt") = 'integer'),
    CONSTRAINT "record_closed_at_typeof_check" CHECK ("closedAt" IS NULL OR typeof("closedAt") = 'integer'),
    CONSTRAINT "record_due_at_typeof_check" CHECK ("dueAt" IS NULL OR typeof("dueAt") = 'integer'),
    CONSTRAINT "record_chronology_check" CHECK ("closedAt" IS NULL OR "closedAt" >= "createdAt"),
    CONSTRAINT "record_event_trigger_idempotency_check" CHECK (
        ("type" = 'event.trigger' AND "idempotencyKey" IS NOT NULL)
        OR "type" <> 'event.trigger'
    ),
    CONSTRAINT "record_due_at_typed_check" CHECK (
        "dueAt" IS NULL
        OR "type" IN ('intent.promise', 'intent.step', 'intent.task')
    ),
    CONSTRAINT "record_priority_range_check" CHECK (
        "priority" IS NULL OR "priority" BETWEEN 0 AND 3
    ),
    CONSTRAINT "record_audit_visibility_check" CHECK (
        ("type" LIKE 'audit.%' AND "visibility" = 'autonomous')
        OR "type" NOT LIKE 'audit.%'
    )
);

INSERT INTO "Record_new" SELECT * FROM "Record";
DROP TABLE "Record";
ALTER TABLE "Record_new" RENAME TO "Record";

CREATE UNIQUE INDEX "Record_idempotencyKey_key" ON "Record"("idempotencyKey");
CREATE INDEX "Record_type_createdAt_idx" ON "Record"("type", "createdAt" DESC);
CREATE INDEX "Record_type_status_dueAt_idx" ON "Record"("type", "status", "dueAt");
CREATE INDEX "Record_subjectPagePath_createdAt_idx" ON "Record"("subjectPagePath", "createdAt" DESC);
CREATE INDEX "Record_parentId_type_status_idx" ON "Record"("parentId", "type", "status");
CREATE INDEX "Record_actorKind_actorRef_createdAt_idx" ON "Record"("actorKind", "actorRef", "createdAt" DESC);
CREATE INDEX "Record_status_dueAt_idx" ON "Record"("status", "dueAt");
CREATE INDEX "Record_visibility_type_idx" ON "Record"("visibility", "type");

-- ============================================================
-- RecordLink: rebuild с XOR CHECK на (toRecordId, toPagePath)
-- ============================================================

CREATE TABLE "RecordLink_new" (
    "id" BIGINT NOT NULL PRIMARY KEY,
    "fromRecordId" TEXT NOT NULL,
    "toRecordId" TEXT,
    "toPagePath" TEXT,
    "linkType" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT (CAST(unixepoch('now', 'subsec') * 1000 AS INTEGER)),
    CONSTRAINT "RecordLink_fromRecordId_fkey" FOREIGN KEY ("fromRecordId") REFERENCES "Record" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "RecordLink_toRecordId_fkey" FOREIGN KEY ("toRecordId") REFERENCES "Record" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "RecordLink_toPagePath_fkey" FOREIGN KEY ("toPagePath") REFERENCES "Page" ("path") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "recordlink_xor_check" CHECK (
        ("toRecordId" IS NULL) <> ("toPagePath" IS NULL)
    ),
    CONSTRAINT "recordlink_created_at_typeof_check" CHECK (typeof("createdAt") = 'integer')
);

INSERT INTO "RecordLink_new" SELECT * FROM "RecordLink";
DROP TABLE "RecordLink";
ALTER TABLE "RecordLink_new" RENAME TO "RecordLink";

CREATE INDEX "RecordLink_toRecordId_linkType_idx" ON "RecordLink"("toRecordId", "linkType");
CREATE INDEX "RecordLink_toPagePath_linkType_idx" ON "RecordLink"("toPagePath", "linkType");
CREATE INDEX "RecordLink_fromRecordId_linkType_idx" ON "RecordLink"("fromRecordId", "linkType");
CREATE UNIQUE INDEX "RecordLink_fromRecordId_toRecordId_toPagePath_linkType_key" ON "RecordLink"("fromRecordId", "toRecordId", "toPagePath", "linkType");

-- ============================================================
-- Append-only триггеры на Record
-- ============================================================

-- Hard DELETE Record запрещён физически.
CREATE TRIGGER "record_no_delete"
BEFORE DELETE ON "Record"
BEGIN
    SELECT RAISE(ABORT, 'Record append-only: hard DELETE forbidden, use audit.cancel instead');
END;

-- После INSERT поля immutable, кроме status / closedAt / closedReason.
-- Список покрытия валидируется smoke-валидатором (assertSchemaInvariants):
-- любая колонка Record вне whitelist'а RECORD_MUTABLE_COLUMNS обязана
-- упоминаться в этом UPDATE OF, иначе append-only становится дырявым.
CREATE TRIGGER "record_immutable_fields"
BEFORE UPDATE OF "id", "type", "properties", "parentId", "actorKind", "actorRef", "subjectPagePath", "createdAt", "dueAt", "priority", "visibility", "idempotencyKey"
ON "Record"
BEGIN
    SELECT RAISE(ABORT, 'Record fields are immutable after insert');
END;

-- closedAt ставится один раз; повторная установка — баг.
CREATE TRIGGER "record_close_once"
BEFORE UPDATE OF "closedAt" ON "Record"
WHEN OLD."closedAt" IS NOT NULL
BEGIN
    SELECT RAISE(ABORT, 'closedAt already set, Record cannot be reopened');
END;

-- audit.* записи — полностью immutable, никаких UPDATE'ов вообще.
CREATE TRIGGER "audit_fully_immutable"
BEFORE UPDATE ON "Record"
WHEN OLD."type" LIKE 'audit.%'
BEGIN
    SELECT RAISE(ABORT, 'audit.* records are fully immutable');
END;

PRAGMA foreign_keys=ON;
