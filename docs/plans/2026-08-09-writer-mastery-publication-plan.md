# Writer Mastery and Publication Contract Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make article writing prove mastery-based drafting and editing, link only verified website publications, and keep source notes out of public articles.

**Architecture:** Extend the writer prompt and article-writing skill with one explicit publication registry and deterministic gates. Keep research evidence staff-only. Correct the current article Markdown and regenerate its HTML from the corrected public body.

**Tech Stack:** Markdown agent contracts, JSON registry, Vitest contract tests, existing article HTML build/check scripts.

---

### Task 1: Add failing contract tests

**Files:**
- Create: `tests/article-writer-publication-contract.test.ts`
- Test: `agents/article-writer/prompt.md`
- Test: `skills/article-writing/SKILL.md`
- Test: `content/published-articles.json`

1. Assert exact topical mastery evidence and post-draft `mastery/redaktor` evidence are mandatory.
2. Assert internal links require `status: published` plus explicit `https://` URL from the registry.
3. Assert public Markdown forbids an H2 named `Источники`.
4. Run `pnpm exec vitest run tests/article-writer-publication-contract.test.ts` and verify RED.

### Task 2: Implement the writer contract

**Files:**
- Modify: `agents/article-writer/prompt.md`
- Modify: `skills/article-writing/SKILL.md`
- Modify: `agents/article-writer/rules.md`
- Create: `content/published-articles.json`

1. Add the approved mastery and redaktor evidence gates.
2. Add website-first canonical publication rules.
3. Ban inferred relative links and ready-only article links.
4. Keep source evidence in research/QA and ban public `## Источники`.
5. Run the focused test and verify GREEN.

### Task 3: Correct the latest article

**Files:**
- Modify: `content/kontrol-schetov-oplat-aktov.md`
- Regenerate: `content/kontrol-schetov-oplat-aktov.html`

1. Remove links to unverified `/ruchnoy-vvod` and `/poteryannye-zayavki-do-pervogo-otveta` while preserving readable sentences.
2. Remove the public `## Источники` section; retain `.research.md` unchanged.
3. Rebuild HTML with the existing article HTML command.
4. Run existing structure, HTML, and focused contract checks.

### Task 4: Verify runtime behavior

1. Run `pnpm typecheck` and focused article-writing tests.
2. Confirm the registry has zero published URLs until website publication.
3. Confirm the latest Markdown and HTML contain no `Источники` heading and no invented relative article links.
4. Confirm writer, researcher, and scout remain enabled in the bridge API.

