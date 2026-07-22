# Updating the Engine

AI Cofounder is split into an **engine** that upstream owns and a **user layer**
that is yours. The single most important property of this project is:

> Pulling engine updates from upstream never touches your customization.

This document explains how that guarantee works, exactly where the boundary is,
how to run an update, and how to prove the split holds on your own machine.

## The 4-layer mental model

1. **Engine** (`src/`, `bridge/`, `skills/` shared library, `scripts/`,
   `.claude/`, `prisma/`, `infrastructure/`, plus engine-tuning `config/*.md`) -
   HOW the co-founder thinks and acts. Upstream owns it. You do not edit it.
2. **`agents/<id>/`** - WHAT each agent does (permissions, model, schedule).
   Your main customization surface.
3. **`org/`** - WHO the company is (identity, brand-voice, audience).
4. **`ai-clone/`** - WHO the founder is (voice, principles).

Layers 2 to 4 are your **user layer**. Layer 1 is the engine. Reconfigure the
top layers and the same engine becomes a co-founder for another business.

## Why the split is enforced by ABSENCE, not by a merge driver

There are two ways you could try to keep `git pull` from clobbering user files.
This project deliberately uses the first.

### What we do: upstream ships ZERO files at user paths

Upstream contains **no files at all** under `agents/`, `org/`, `ai-clone/`,
`content/`, or at the four user config paths (`config/projects.md`,
`config/allowlist.md`, `config/budget.md`, `config/support-source.md`). Those
paths are listed in `.gitignore`. Your local copies are materialized by
`/setup` from `examples/` (org-seed, ai-clone-seed, example agents) and from
`config/*.example.md`.

Because upstream has nothing tracked there, a pull has **nothing to bring in**
and therefore **nothing to overwrite**. There is no conflict to resolve, no
three-way merge to get wrong, no diff to apply. The safety is structural: you
cannot clobber a file that the other side does not ship. This is the "absence
mechanism".

### Why `merge=ours` alone would be unreliable

A `.gitattributes` `merge=ours` driver only runs **during a merge of tracked
files that both sides have**. It does nothing for files that are untracked
locally, it does not protect against a `git checkout` / `git reset` / rebase
that bypasses the merge machinery, and it silently does the wrong thing the
moment upstream legitimately starts tracking a path. It is also easy to forget
to register or to mis-scope. Relying on a merge driver to protect user data is
relying on the engine never making a mistake at exactly the wrong line of an
attributes file. Absence has no such failure mode: there is simply nothing on
the upstream side to merge.

The trade-off is that the boundary must be explicit and machine-readable, which
is what `engine-manifest.json` is for.

## The exact engine[] vs user[] boundary

The boundary is declared in `engine-manifest.json` at the repo root. It has two
arrays. Summarized:

**`engine[]`** (upstream-owned, updated on pull): `src`, `bridge`, `skills`,
`scripts`, `prisma/schema.prisma`, `prisma/migrations`, `infrastructure`,
`.claude`, `tests`, `templates`, `examples`, `docs`, the engine-tuning config
files (`config/pricing.md`, `config/embeddings.md`, `config/report.md`,
`config/triage.md`, `config/investigate.md`, `config/solve.md`),
`package.json`, `pnpm-lock.yaml`, `tsconfig.json`, `biome.json`,
`vitest.config.ts`, `lefthook.yml`, `.nvmrc`, `.gitignore`,
`engine-manifest.json`, `VERSION`, `CHANGELOG.md`, `LICENSE`, `README.md`,
`SETUP.md`, `CLAUDE.md`.

**`user[]`** (yours, never shipped by upstream): `agents`, `org`, `ai-clone`,
`content`, `config/projects.md`, `config/allowlist.md`, `config/budget.md`,
`config/support-source.md`, `.env`, `.env.local`, `prisma/dev.db`.

A vitest proof (described below) asserts that `engine[]` and `user[]` never
overlap, so a path is owned by exactly one side.

### config/*.md is split on purpose

This is the subtle part, so it is worth stating plainly:

- **Engine-tuning `config/*.md` DOES update on pull.** `config/pricing.md`,
  `triage.md`, `report.md`, `embeddings.md`, `investigate.md`, and `solve.md`
  are engine defaults (model pricing, triage heuristics, report formatting).
  They are in `engine[]`, they stay tracked, and improving them upstream should
  flow to you. They are correctly **not** gitignored.
- **User `config/*.md` does NOT update.** `config/projects.md`,
  `allowlist.md`, `budget.md`, and `support-source.md` are your data. They are
  in `user[]`, they are gitignored, and upstream ships nothing there.

So "config updates" and "config is protected" are both true - it depends on
which config file, and the manifest is the source of truth.

(Note: `config/projects.md` is optional. A self-contained fork that does no
cross-project work does not need it.)

## How to update

### One-time setup: add the upstream remote

When you fork the repo, your `origin` is your fork. Add upstream once:

```bash
git remote add upstream <UPSTREAM_REPO_URL>
```

`/setup` offers to do this for you during onboarding.

### Every update: `pnpm update-engine`

```bash
pnpm update-engine
```

This runs `scripts/update-engine.sh`. Make sure your working tree is clean on
engine paths first (your user-layer changes are fine and stay untouched).

### What `update-engine.sh` does, step by step

1. **Preconditions.** `cd` to the repo root and verify that the `upstream`
   remote exists. If it does not, it prints the `git remote add upstream`
   command and exits.
2. **Fetch.** `git fetch upstream <branch>` (default `main`; pass another
   branch as the first argument).
3. **Read the manifest.** It loads the `engine[]` array from
   `engine-manifest.json` using Node (no `jq` dependency).
4. **Engine-only diff, including deletes.** It runs
   `git diff --name-status HEAD upstream/<branch> -- <engine paths>` and walks each
   change:
   - `A` / `M` (added or modified): `git checkout upstream/<branch> -- <path>`.
   - `D` (upstream deleted the file): `git rm --ignore-unmatch -- <path>` so
     removals propagate too, not just additions.
   - `R*` (rename): checkout the new path, remove the old one.

   Only `engine[]` paths are passed to the diff, so user-layer files are never
   in scope.
5. **Install.** `pnpm install` (the lockfile is engine-owned, so it may have
   changed).
6. **Migrate.** `pnpm db:migrate` applies Prisma schema migrations, then
   `pnpm migrate` runs the user-file schema migration runner (see the seam
   below).
7. **Gate.** `pnpm build` then `pnpm test`. The build is biome check + prisma
   generate + tsc + vite build; a biome formatter error fails the build. The
   test run includes the engine/user split proof.
8. **Done.** It reminds you that `agents/`, `org/`, `ai-clone/`, and
   `config/*` were not touched, and that `git status` should show only engine
   files.

If there are no engine changes, step 4 prints "engine is already current" and
the rest still runs as a no-op-safe re-verification.

## How to VERIFY the split holds

You do not have to trust this document. Three checks, runnable anytime.

### 1. The proof test

```bash
pnpm test tests/engine/engine-user-split.test.ts
```

`tests/engine/engine-user-split.test.ts` asserts, against your actual git
state, that:

- **No user-layer file is tracked.** `git ls-files agents`, `... org`,
  `... ai-clone`, `... content`, and each user config path all return empty.
  If anyone ever `git add -f`s a user file, this test fails.
- **Every user path is gitignored.** `git check-ignore` returns true for
  `org/INDEX.md`, `ai-clone/INDEX.md`, `agents/whatever/AGENT.md`,
  `content/draft.md`, and the four user config files.
- **Engine files are tracked.** e.g. `src/routines/parser.ts`,
  `config/pricing.md`, `package.json`.
- **Engine-tuning config is NOT ignored** (so it updates on pull):
  `config/pricing.md` and `config/triage.md` are not ignored.
- **`engine[]` and `user[]` do not overlap** in the manifest, and every user
  config path is listed under `user[]`.

### 2. Confirm nothing of yours is tracked

```bash
git ls-files agents org ai-clone content \
  config/projects.md config/allowlist.md config/budget.md config/support-source.md
```

This should print **nothing**. Any output means a user file leaked into
tracking - back it out with `git rm --cached <path>` and check why it was
force-added.

### 3. Confirm your files are ignored, and engine config is not

```bash
git check-ignore agents/ org/ ai-clone/ content/ config/projects.md   # prints each path (ignored - good)
git check-ignore config/pricing.md config/triage.md                   # prints nothing (NOT ignored - good)
```

If `check-ignore` prints a user path, it is protected. If it stays silent for
`config/pricing.md`, that engine default will correctly update on your next
`pnpm update-engine`.

## Checking for a new version

`pnpm check:engine` tells you whether upstream has a newer engine without
changing anything. It compares your local `VERSION` against
`upstream/main:VERSION` and, if a newer one exists, points you at
`pnpm update-engine`. It is a read-only `git fetch` plus a one-file compare, so
it is safe to run any time (and in CI). On a fresh fork with no `upstream`
remote it prints how to add one (`git remote add upstream <url>`) and exits
cleanly - it never fails the build.

## The user-file schema seam (for future versions)

In v1.0, `pnpm migrate` is a **stub** runner for **user-file** schema
migrations - the equivalent of database migrations, but for the shape of your
hand-edited files (`AGENT.md` frontmatter, `permissions.yml`, `org/` and
`ai-clone/` layouts). The engine cannot edit your user-layer files via a git
pull (that is the whole point of the split), so when a future engine version
changes an expected user-file format, it ships a migration step here instead.

The runner records its progress in `.ai-cofounder-migrate-state` (gitignored,
so your migration state is local and never travels upstream). Because it runs
as part of `update-engine.sh` after install and before the build/test gate, a
format bump and its migration land together: pull the new engine, the migration
adjusts your files in place, and the gate verifies everything still parses.
Today there is nothing to migrate, so it is a safe no-op; the seam exists so
that v1.1+ can evolve user-file formats without ever asking upstream to write
into your protected layer.

## In one paragraph

Upstream owns the engine and ships nothing at your paths; your layer is
gitignored and created locally by `/setup`; the boundary is declared in
`engine-manifest.json`; `pnpm update-engine` applies only engine changes
(adds, edits, and deletes), reinstalls, migrates, and gates on build + test;
engine-tuning `config/*.md` updates while your `config/*.md` does not; and a
proof test plus two git commands let you verify the guarantee on your own
machine at any time.
