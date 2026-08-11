# Editorial System Refactor Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace duplicated writer instructions with one enforceable editorial system that uses mastery, reference sources, corpus fingerprints, and independent editing.

**Architecture:** `org/article-editorial-playbook.md` becomes the only editorial source of truth. A deterministic context builder records corpus, reference, and mastery evidence before drafting; a separate editor subagent reviews the resulting article, while prompt, rules, and skill keep non-overlapping responsibilities.

**Tech Stack:** TypeScript, Vitest, Markdown contracts, existing routine subagent runtime, existing `research-serp` fetch utilities.

---

### Task 1: Lock the non-duplication contract

**Files:**
- Create: `tests/article-editorial-architecture.test.ts`
- Read: `agents/article-writer/prompt.md`
- Read: `agents/article-writer/rules.md`
- Read: `skills/article-writing/SKILL.md`

**Steps:**
1. Write a failing test requiring exactly one reference to
   `org/article-editorial-playbook.md` from each entry-point file.
2. Add assertions that voice, mastery application, reference patterns and
   structural diversity prose are not duplicated across entry points.
3. Run `pnpm exec vitest run tests/article-editorial-architecture.test.ts` and
   verify RED against the current duplicated contracts.
4. Commit the failing contract test.

### Task 2: Create the editorial source of truth

**Files:**
- Create: `org/article-editorial-playbook.md`
- Modify: `org/reference-blogs.md`
- Test: `tests/article-editorial-architecture.test.ts`

**Steps:**
1. Add the approved voice rubric, natural-speech test, composition model,
   mastery evidence contract and independent-editor response schema.
2. Add `https://t.me/s/findir_pro` as a public thematic reference with explicit
   allowed uses: questions, angles, professional contradictions and formats.
3. Explicitly prohibit copying phrases or treating any reference as factual
   support for an unrelated subject.
4. Run the architecture test and confirm it still fails only because old entry
   points have not yet been reduced.
5. Commit the playbook and registry changes.

### Task 3: Build corpus fingerprints

**Files:**
- Create: `scripts/article-editorial-context.mjs`
- Create: `tests/article-editorial-context.test.ts`
- Reuse: `scripts/article-diversity-check.mjs`

**Steps:**
1. Write fixtures containing repeated `X начинается с Y` H1 formulas,
   question-heavy H2 lists and identical composition sequences.
2. Write failing tests requiring normalized H1 formula, question-H2 ratio,
   scene, narrative form, practical block and final move in JSON output.
3. Implement deterministic extraction without LLM calls.
4. Add a hard failure when the candidate repeats the recent dominant formula or
   composition, even if lexical overlap is low.
5. Run `pnpm exec vitest run tests/article-editorial-context.test.ts`.
6. Commit script and tests.

### Task 4: Enforce reference and mastery evidence

**Files:**
- Modify: `skills/research-serp/scripts/reference-blogs.ts`
- Modify: `scripts/article-editorial-context.mjs`
- Create: `tests/article-editorial-evidence.test.ts`

**Steps:**
1. Write failing tests for Telegram preview URL normalization and extraction of
   post headings/questions from `https://t.me/s/<channel>`.
2. Require each reference pattern to include opened URL, observed pattern and
   planned article decision.
3. Require each mastery method to include problem, planned location, rejected
   alternative and later before/after revision.
4. Reject a list containing only file paths or generic `прочитано/применено`.
5. Run focused reference and evidence tests.
6. Commit the evidence implementation.

### Task 5: Reduce the writer entry points

**Files:**
- Modify: `agents/article-writer/prompt.md`
- Modify: `article-writer-prompt.md`
- Modify: `examples/agents/article-writer/prompt.md`
- Modify: `agents/article-writer/rules.md`
- Modify: `skills/article-writing/SKILL.md`
- Test: `tests/article-editorial-architecture.test.ts`

**Steps:**
1. Replace duplicated editorial prose with stage calls to the playbook and
   context builder.
2. Keep prompt responsible for orchestration, rules for immutable safety/fact/
   publication constraints, and skill for invocation and commands.
3. Preserve existing publication, privacy and artifact contracts unchanged.
4. Run architecture and existing writer contract tests.
5. Inspect the diff and prove old duplicate blocks were removed rather than
   supplemented.
6. Commit the reduced contracts.

### Task 6: Add independent editorial review

**Files:**
- Modify: `agents/article-writer/prompt.md`
- Create: `tests/article-independent-editor.test.ts`

**Steps:**
1. Write a failing contract test requiring a clean-context editor subagent after
   the first complete draft.
2. Require JSON with `issues`, `revisions`, `voice`, `naturalSpeech`,
   `compositionDifference`, `masteryEvidence` and `referenceInfluence`.
3. Reject empty `PASS`, missing before/after revisions or writer self-review.
4. Add one bounded rewrite loop and rerun deterministic checks afterward.
5. Run focused and writer regression tests.
6. Commit the independent editor contract.

### Task 7: Verify with real articles and deploy

**Files:**
- Create: `content/editorial-evaluation/<date>-<slug>.md` for each trial
- Modify only if a proven defect is found in the single source of truth.

**Steps:**
1. Run the complete targeted test set, typecheck and Vite production build.
2. Generate three trials using distinct subjects and compositions.
3. Record voice, unnatural phrases, reference influence, mastery decisions and
   corpus difference for manual review.
4. Change the playbook only for proven common defects; do not patch individual
   prompts.
5. Rebuild and restart only affected VPS services after explicit deployment
   approval.
6. Commit trial evidence and any approved playbook correction.

## Acceptance Gates

- one editorial source of truth;
- no duplicated voice/diversity/mastery instructions in entry points;
- reference registry includes and opens `findir_pro` preview;
- mastery requires decision and before/after evidence;
- repeated H1/H2/composition fixtures fail deterministically;
- independent editor cannot self-certify with empty `PASS`;
- three trial articles await human acceptance before declaring voice complete.
