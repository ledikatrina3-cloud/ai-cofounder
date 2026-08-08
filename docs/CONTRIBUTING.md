# Contributing to AI Cofounder

This guide is for people contributing to the **engine** - the upstream-owned part of AI Cofounder. If you only want to configure your own co-founder (agents, org, ai-clone), you do not need this file; see `SETUP.md` and `docs/AGENTS.md`.

AI Cofounder is local-first and runs on your Mac. The engine is TypeScript + pnpm + SQLite/Prisma + Hono + a React "3D office" bridge UI, driven by the Claude Agent SDK. License is MIT.

---

## 1. Dev setup

You need **Node 22** (pinned in `.nvmrc`). Use `nvm use` if you manage versions with nvm.

```bash
nvm use                       # or otherwise switch to Node 22
pnpm install                  # installs deps (this is a pnpm repo, not npm/yarn)
echo 'DATABASE_URL=file:./dev.db' > .env   # local SQLite db; .env holds only DATABASE_URL + public defaults
pnpm db:migrate               # prisma migrate deploy + sqlite-vec init (scripts/init-vec.ts)
```

Notes:

- `.env` is git-ignored and is meant to hold **only** `DATABASE_URL` and public defaults. Real secrets never go in `.env` - they live in the macOS Keychain via `keytar`. See `.env.example` for the full set of public defaults.
- `pnpm db:migrate` runs `prisma migrate deploy` and then initializes the `sqlite-vec` extension. Run it after any pull that touches `prisma/migrations`.
- LLM transport is not required to run tests. For end-to-end agent runs you configure either the local `gateway` oauth gateway (Claude.ai subscription) or `ANTHROPIC_API_KEY`; that is a runtime concern, not a contributor prerequisite.

---

## 2. The gates (must be green before you push)

Two commands gate every change. Both must pass.

```bash
pnpm build    # biome check . && prisma generate && tsc (root) && tsc (bridge) && tsc (bridge/app, --noEmit) && vite build (bridge UI)
pnpm test     # vitest run  (requires DATABASE_URL, e.g. file:./dev.db)
```

`pnpm build` is the real gate, not bare `tsc`. It runs, in order:

1. `biome check .` - lint **and formatter**. **Biome formatter errors fail the build.** Run `pnpm format` (`biome format --write .`) before pushing so formatting never blocks you.
2. `prisma generate` - regenerates the Prisma client.
3. `tsc -p tsconfig.json`, `tsc -p bridge/tsconfig.json`, and `tsc -p bridge/app/tsconfig.json --noEmit` - typecheck the root, the bridge server, and the bridge React app (the `.tsx` UI; previously unchecked).
4. `vite build --config bridge/app/vite.config.ts` - builds the bridge React UI.

`pnpm test` runs the full Vitest suite and needs `DATABASE_URL` set in the environment. There are also focused scripts (e.g. `pnpm test:routines`, `pnpm test:invariants`) for tight loops, but CI and your final check should be the full `pnpm test`.

---

## 3. The engine/user boundary (the key invariant)

The repository has a 4-layer model. As a contributor you work on the **engine**; you must not commit anything from the user layers.

| Layer | Paths | Owner |
|---|---|---|
| **Engine** (HOW to think/act) | `src/`, `bridge/`, `skills/` (shared library), `scripts/`, `.claude/`, `prisma/`, `infrastructure/`, `tests/`, `templates/`, `examples/`, `docs/`, engine-tuning `config/*.md` | upstream (you) |
| **agents/** (WHAT each agent does) | `agents/<id>/` | the user |
| **org/** (WHO the company is) | `org/` | the user |
| **ai-clone/** (WHO the founder is) | `ai-clone/` | the user |

The exact, machine-readable boundary lives in **`engine-manifest.json`** (`engine[]` vs `user[]`). Treat it as the source of truth.

Rules you must follow:

- **Never put example or user-specific content in engine paths.** User-shaped content (a real company's brand voice, a personal agent) belongs in the user layer, which upstream does not ship. De-identified samples go in `examples/` (see section 5).
- **A new engine top-level directory must be added to `engine-manifest.json` `engine[]`.** Otherwise `scripts/update-engine.sh` (`pnpm update-engine`) will not pull it for downstream users, and the split tests cannot reason about it.
- **Never track files under the user paths.** Upstream ships **zero** files under `agents/`, `org/`, `ai-clone/`, `content/`, and the user config files (`config/projects.md`, `config/allowlist.md`, `config/budget.md`, `config/support-source.md`). All of these are in `.gitignore`. The split is enforced by **absence**, not by a merge driver: because upstream has no files there, a user's `git pull` of engine updates never touches their customization.
- Engine-tuning config (`config/pricing.md`, `config/triage.md`, `config/report.md`, `config/embeddings.md`, `config/investigate.md`, `config/solve.md`) stays **tracked** and is expected to update on pull - those are engine defaults, not user customization. Do not move them to the user layer.
- Do not use `git add -A` or `git add .`. Add files by name so a stray user-layer or WIP file never sneaks into a commit.

---

## 4. Testing conventions

- Tests live **top-level in `tests/`** (not co-located next to source).
- Engine-specific proof tests live in **`tests/engine/`**.
- For isolation, code takes its filesystem access via **dependency injection** - pass in `read` / `glob` / `fileExists` style functions rather than calling `node:fs` directly, so tests can supply fakes and stay hermetic. New engine code that reads the repo should follow the same pattern.
- Two proof tests guard the invariants above and **must stay green**:
  - `tests/engine/examples-valid.test.ts` - every shipped `examples/agents/<id>/` parses to a valid agent via `parseAgentFolder` (`projectId === 'self'`, model alias resolved, non-empty prompt, valid output/trigger). A broken example must never reach a release. This is also the round-trip check for the `scripts/migrate-routines.ts` codemod.
  - `tests/engine/engine-user-split.test.ts` - asserts that **no** user-layer file is tracked in git and that all user paths are covered by `.gitignore` (and conversely that engine files, including engine-tuning `config/*.md`, stay tracked). If someone `git add -f`s a user file, this test fails.
- The companion loader tests `tests/engine/agent-loader.test.ts` and `tests/engine/registry-agents-win.test.ts` cover folder parsing and the dual-loader collision rule (on an id collision an `agents/<id>/` wins over a legacy `routines/<id>.md`, which is silently skipped). Keep them green when touching the loader.

---

## 5. Adding a new example agent

Example agents live in **`examples/agents/<id>/`** and are copied into `agents/` by `/setup`. To add one:

1. Create `examples/agents/<id>/` with at least the two required files:
   - `AGENT.md` - YAML frontmatter (`displayName`, `model`, `enabled`, `schedule`, `output` are the core required fields; `id`, `role`, `avatar`, `color`, `logo`, `maxTokens`, `timeoutMs`, `department`, and the `skills:` / `forceLoad:` lists are optional) plus a short description in the body. `model` accepts the aliases `opus` / `sonnet` / `haiku` (resolved to `claude-opus-4-7` / `claude-sonnet-4-6` / `claude-haiku-4-5`) or a full `claude-*` / `voyage-*` id. `output` accepts `telegram` / `journal` / `both`.
   - `prompt.md` - the agent's full instructions (its task/system prompt). Required and non-empty.
2. Optional files, as needed: `permissions.yml` (its **absence means zero tools** - silence is safe; tool names must be real entries from `src/routines/tool-registry.ts` such as `project.read`, `project.grep`, `project.glob`, `project.bash`, `project.db.query`, `project.telegram.read`, `journal.search`, `report.send`), `rules.md` (guardrails, supports `@<relative-path>` includes that reject `..` traversal), `report.md` (per-agent Telegram template), `target.yml` (cross-project opt-in; ship it as `target.yml.example` in examples so it is opt-in, not active).
3. **Ship it `enabled: false` by default** (the user enables it after configuring), unless there is a documented reason not to.
4. **Keep it de-identified.** Use **only** the anonymization world: founder **Alex Rivera**, company **Acme Academy**, project id **example-project**, domain **acme.example.com**. The public OSS identity is **AI Cofounder** (github.com/artemiimillier/ai-cofounder). Never reference any real brand, person, real path, or internal project in an example.
5. **Run the de-id check before committing.** There is no automated de-id script in v1.0 - it is a manual discipline. Grep your new files for forbidden tokens and confirm only the anonymization world appears:

   ```bash
   grep -riE 'real-name-or-brand-you-must-not-ship' examples/agents/<id>/   # expect no hits
   ```

   Then run `pnpm test` so `examples-valid` confirms the folder parses.

The flagship example is `article-writer` (autonomous article factory: topic -> viral scoring >= 85 -> draft -> multi-stage QA / anti-AI / de-identification -> writes markdown + paste-ready HTML + a typography SVG cover, or PNG if the optional `sharp` dependency is installed, to `./content/`). It is self-contained with **no secrets and no DB by default** (its stage-2 research queries a free public DuckDuckGo endpoint; output and cover stay fully local); external publishing is opt-in via `target.yml.example`. It uses the shared-library skills `article-writing`, `research-serp`, `seo-audit`, `cover-design`. The other examples (`financial-yesterday`, `db-morning-triage`, `metrics-weekly`, `support-triage`, `critical-alerts`) are mostly read-only DB + Telegram analytics/ops agents.

To scaffold a brand-new agent interactively (one question at a time, then validates the folder parses), use the `/scaffold-agent <id>` slash command, which builds from `templates/agent/`.

---

## 6. Commit and PR norms

- **Branch off `main`**; do not commit directly to `main`.
- **`git add` by name only.** Never `git add -A` / `git add .` - it risks committing user-layer or WIP files and breaks the engine/user split test.
- **Both gates green before you push:** `pnpm build` and `pnpm test`. `lefthook` runs hooks locally and GitHub Actions runs CI; a red build or red test will block the PR.
- Write a clear PR description: what changed, why, and which gate/test proves it. If you added an engine top-level dir, say that you updated `engine-manifest.json`. If you touched the agent loader, registry, or the split, note which proof test covers it.
- Keep engine changes and example/user-shaped changes in separate, focused PRs where possible.

### Codex Desktop publish flow for this fork

When Codex Desktop prepares a PR for the `ledikatrina3-cloud/ai-cofounder` fork,
use a clean local clone instead of pushing from a live runtime checkout. Runtime
machines can have no `origin`, no `gh`, and a dirty user layer; a clean clone
keeps the PR scoped and avoids committing local state.

```powershell
$base = "C:\MyWork\AI-Cofounder\pr-worktrees"
git clone -c core.autocrlf=false --depth 1 https://github.com/ledikatrina3-cloud/ai-cofounder.git "$base\<pr-name>"
cd "$base\<pr-name>"
git switch -c agent/<short-scope>
```

Copy or edit only the intended engine/example files, then validate in the clean
clone. On Windows, keep `core.autocrlf=false`; otherwise Biome can fail on CRLF
line-ending churn across the whole repo.

```powershell
pnpm install --frozen-lockfile
pnpm exec vitest <focused-test-files> --run
git add <explicit-file-1> <explicit-file-2>
git commit -m "<short summary>"
git push -u origin agent/<short-scope>
gh pr create --repo ledikatrina3-cloud/ai-cofounder --base main --head agent/<short-scope> --draft --title "<title>" --body-file <body.md>
```

If the runtime checkout has changes under ignored user paths (`agents/`, `org/`,
`ai-clone/`, `content/`), mirror the fix into tracked engine/template paths such
as `examples/`, `skills/`, `scripts/`, `tests/`, or `docs/` before opening the PR.

---

## 7. A note on user customization

The user customization layers - `agents/`, `org/`, `ai-clone/`, `content/`, and the user `config/*.md` files - are **git-ignored** and are materialized locally by `/setup` from `examples/` (org-seed, ai-clone-seed, example agents) and `config/*.example.md`. As a contributor you will see these directories populated on your own machine after running `/setup`, but **nothing in them is yours to commit**. If you need to change behavior that currently lives only in a user file, the fix belongs in the engine (`src/`), in a shipped `examples/` seed, or in engine-tuning `config/*.md` - never by tracking a user file.

Engine updates for downstream users flow through `git remote add upstream <URL>` then `pnpm update-engine` (`scripts/update-engine.sh`), which applies only `engine[]` paths and then runs `pnpm install`, `pnpm db:migrate`, `pnpm migrate` (the user-file schema runner - a stub in v1.0), `pnpm build`, and `pnpm test`. Keep that path working when you change the manifest or the build/test gates.
