# Brief Review Actions Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add explicit reject and research-retry paths to Article Brief human review so an unsuitable topic is not forced into writer.

**Architecture:** Keep the workflow file-backed because the existing brief gate uses `content/briefs/article-brief-latest.md`. Add two sibling bridge endpoints next to `approve`: `reject` only changes brief status and appends reviewer note; `research-retry` changes status, appends reviewer note, then starts `article-brief-researcher` through the existing manual routine runner path. Update the drawer UI with a comment textarea and three decision buttons.

**Tech Stack:** TypeScript, Hono bridge server, React drawer UI, Vitest.

---

### Task 1: Backend Brief Decision Endpoints

**Files:**
- Modify: `bridge/server.ts`
- Test: `tests/brief-review-actions.test.ts`

**Step 1: Write failing tests**
- Create tests that start bridge on dynamic port and use a temporary repo cwd.
- Fixture `content/briefs/article-brief-latest.md` with `Status: needs_human_review`.
- Assert `POST /content/briefs/latest/reject` returns `{ok:true,status:'rejected'}`, updates status, and appends reviewer comment.
- Assert `POST /content/briefs/latest/research-retry` returns `{ok:true,status:'research_requested'}`, updates status, and requires non-empty comment.

**Step 2: Verify red**
- Run `pnpm test -- tests/brief-review-actions.test.ts`.
- Expected: fails because endpoints do not exist.

**Step 3: Implement minimal backend**
- Extract helpers for latest brief path, status parsing, status replacement, and reviewer note append.
- Add `reject` endpoint.
- Add `research-retry` endpoint; for first pass, status update is tested without forcing a real routine run dependency.

**Step 4: Verify green**
- Run `pnpm test -- tests/brief-review-actions.test.ts`.

### Task 2: Drawer UI Controls

**Files:**
- Modify: `bridge/app/src/components/Office/RoutineDetailDrawer.tsx`

**Step 1: Add UI state**
- Add `reviewComment` state.
- Add textarea under brief markdown when status is `needs_human_review`.

**Step 2: Add actions**
- Add `rejectBrief` calling `/content/briefs/latest/reject` with `{comment}`.
- Add `requestResearchRetry` calling `/content/briefs/latest/research-retry` with `{comment}`.
- Keep existing approve+writer behavior.

**Step 3: UX rules**
- Disable research retry when comment is empty.
- Show action message and reload brief after each action.
- Layout buttons: `Отклонить`, `На новое исследование`, `Подтвердить и запустить writer`, `Обновить`.

### Task 3: Verification

**Files:**
- `bridge/server.ts`
- `bridge/app/src/components/Office/RoutineDetailDrawer.tsx`
- `tests/brief-review-actions.test.ts`

**Step 1: Typecheck/build**
- Run `pnpm test -- tests/brief-review-actions.test.ts`.
- Run `pnpm run typecheck`.
- Run `pnpm run build` if typecheck is clean.

**Step 2: Deploy runtime assets**
- If build succeeds, restart bridge server/UI processes so the new route and drawer bundle are active.

**Step 3: Smoke check**
- `GET /content/briefs/latest` returns current brief.
- UI at `127.0.0.1:5173` still responds 200.
