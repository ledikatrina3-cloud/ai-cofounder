-- CreateTable
CREATE TABLE "Record" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "type" TEXT NOT NULL,
    "properties" TEXT NOT NULL,
    "parentId" TEXT,
    "actorKind" TEXT NOT NULL,
    "actorRef" TEXT,
    "subjectPagePath" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" TEXT NOT NULL DEFAULT 'active',
    "closedAt" DATETIME,
    "closedReason" TEXT,
    "dueAt" DATETIME,
    "priority" INTEGER,
    "visibility" TEXT NOT NULL DEFAULT 'autonomous',
    "idempotencyKey" TEXT,
    CONSTRAINT "Record_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "Record" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Record_subjectPagePath_fkey" FOREIGN KEY ("subjectPagePath") REFERENCES "Page" ("path") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Page" (
    "path" TEXT NOT NULL PRIMARY KEY,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "parentPath" TEXT,
    "freshnessMode" TEXT,
    "tags" TEXT NOT NULL DEFAULT '[]',
    "updatedAt" DATETIME NOT NULL,
    "gitSha" TEXT NOT NULL,
    "archived" BOOLEAN NOT NULL DEFAULT false,
    CONSTRAINT "Page_parentPath_fkey" FOREIGN KEY ("parentPath") REFERENCES "Page" ("path") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "RecordLink" (
    "id" BIGINT NOT NULL PRIMARY KEY,
    "fromRecordId" TEXT NOT NULL,
    "toRecordId" TEXT,
    "toPagePath" TEXT,
    "linkType" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "RecordLink_fromRecordId_fkey" FOREIGN KEY ("fromRecordId") REFERENCES "Record" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "RecordLink_toRecordId_fkey" FOREIGN KEY ("toRecordId") REFERENCES "Record" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "RecordLink_toPagePath_fkey" FOREIGN KEY ("toPagePath") REFERENCES "Page" ("path") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "SyncCheckpoint" (
    "source" TEXT NOT NULL PRIMARY KEY,
    "cursor" TEXT NOT NULL,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Embedding" (
    "recordId" TEXT NOT NULL PRIMARY KEY,
    "model" TEXT NOT NULL,
    "vector" BLOB NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Embedding_recordId_fkey" FOREIGN KEY ("recordId") REFERENCES "Record" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "Record_idempotencyKey_key" ON "Record"("idempotencyKey");

-- CreateIndex
CREATE INDEX "Record_type_createdAt_idx" ON "Record"("type", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "Record_type_status_dueAt_idx" ON "Record"("type", "status", "dueAt");

-- CreateIndex
CREATE INDEX "Record_subjectPagePath_createdAt_idx" ON "Record"("subjectPagePath", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "Record_parentId_type_status_idx" ON "Record"("parentId", "type", "status");

-- CreateIndex
CREATE INDEX "Record_actorKind_actorRef_createdAt_idx" ON "Record"("actorKind", "actorRef", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "Record_status_dueAt_idx" ON "Record"("status", "dueAt");

-- CreateIndex
CREATE INDEX "Record_visibility_type_idx" ON "Record"("visibility", "type");

-- CreateIndex
CREATE INDEX "Page_type_archived_idx" ON "Page"("type", "archived");

-- CreateIndex
CREATE INDEX "Page_updatedAt_idx" ON "Page"("updatedAt");

-- CreateIndex
CREATE INDEX "Page_parentPath_idx" ON "Page"("parentPath");

-- CreateIndex
CREATE INDEX "RecordLink_toRecordId_linkType_idx" ON "RecordLink"("toRecordId", "linkType");

-- CreateIndex
CREATE INDEX "RecordLink_toPagePath_linkType_idx" ON "RecordLink"("toPagePath", "linkType");

-- CreateIndex
CREATE INDEX "RecordLink_fromRecordId_linkType_idx" ON "RecordLink"("fromRecordId", "linkType");

-- CreateIndex
CREATE UNIQUE INDEX "RecordLink_fromRecordId_toRecordId_toPagePath_linkType_key" ON "RecordLink"("fromRecordId", "toRecordId", "toPagePath", "linkType");

