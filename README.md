# AI Cofounder

A local-first, proactive **AI co-founder framework for a solo founder**. It runs on your own Mac, talks to you over Telegram, schedules its own work with launchd, and is powered by the [Claude Agent SDK](https://docs.anthropic.com/en/api/agent-sdk). Instead of waiting for prompts, you give it standing jobs - a morning DB triage, a weekly metrics digest, an autonomous article factory - and it shows up and does them on a schedule, then pings you with the result. The hook: fork it once, reconfigure two thin layers (who your company is, who you are), and the same engine becomes a co-founder for an entirely different business.

Project home: [github.com/artemiimillier/ai-cofounder](https://github.com/artemiimillier/ai-cofounder). License: [MIT](LICENSE).

## The 4-layer model

The repo is built as four layers. The engine knows *how* to think and act; `org/` and `ai-clone/` say *who* is speaking; each agent folder says *what* to do and when. You configure the top layers and leave the engine alone.

| Layer | Lives in | What it is | You edit it? |
|---|---|---|---|
| **1. Engine** | `src/`, `bridge/`, `skills/`, `scripts/`, `.claude/`, `prisma/`, `infrastructure/` | The runtime: orchestration loop, scheduler, Telegram channel, the 3D-office bridge UI, shared skill library. *How* to act. | No - upstream owns it |
| **2. Agents** | `agents/<id>/` | *What* each agent does, with which permissions, model, and schedule. Your main customization surface. | Yes |
| **3. Org** | `org/` | *Who* the company is: identity, brand voice, audience. | Yes |
| **4. AI-clone** | `ai-clone/` | *Who* the founder is: voice, principles. Travels with you across projects. | Yes |

**Reconfigure the top layers and the same engine becomes a co-founder for another business.** The split is enforced by *absence*, not by a merge driver: upstream ships zero files under `agents/`, `org/`, and `ai-clone/` (they are gitignored), so a `git pull` of engine updates can never clobber your customization. `/setup` materializes those layers locally from `examples/`.

## Quickstart

```bash
git clone https://github.com/artemiimillier/ai-cofounder.git   # or your fork
cd ai-cofounder && pnpm install                              # Node 22, see .nvmrc
claude /setup                                                # guided onboarding (see below)
# /setup runs your first agent once and pings you on Telegram.
# For a cron agent, install its launchd schedule:
pnpm install:launchd:routines                                # installs plists for ENABLED cron agents
# Manual agents you trigger by hand: pnpm dev:run <agent-id> --unique
```

`/setup` walks you through everything one step at a time: preflight checks, seeding `ai-clone/` and `org/`, choosing the LLM transport, running DB migrations, storing secrets in the macOS Keychain, a Telegram pairing round-trip, adding the upstream remote, copying a first example agent, and a smoke run. Full walkthrough in **[SETUP.md](SETUP.md)**.

## How an agent works

An agent is a self-contained folder under `agents/<id>/`. The minimum is two files:

- **`AGENT.md`** - YAML frontmatter (`displayName`, `model`, `enabled`, `schedule`, `output`, optional `avatar`/`color`/`maxTokens`/`timeoutMs`/`skills`/`department`) plus a one-line description. `model` accepts aliases `opus`/`sonnet`/`haiku` or a full `claude-*` id; `output` is `telegram`, `journal`, or `both`.
- **`prompt.md`** - the agent's full instructions (its task / system prompt).

Optional files refine it: `permissions.yml` (which tools and bash commands it may use, which Keychain secrets it may read - **absent means zero tools, so silence is safe**), `rules.md` (guardrails), `report.md` (a per-agent Telegram template), and `target.yml` (opt-in: run inside an external repo for cross-project work). Create one with `claude /scaffold-agent <id>`, which asks identity/model/tools/schedule one question at a time and validates the result.

Full reference: **[docs/AGENTS.md](docs/AGENTS.md)**.

## Repo map

**Engine (upstream owns it - do not edit):**

- `src/` - TypeScript engine: orchestration, scheduler, reporting, Telegram, tool registry
- `bridge/` - Hono server + React 3D-office UI (see below)
- `skills/` - shared skill library (article writing, SERP research, SEO audit, cover design, ...)
- `scripts/` - utility `tsx`/shell scripts (launchd install, migration, update-engine, ...)
- `.claude/` - slash commands (`/setup`, `/scaffold-agent`)
- `prisma/` - schema and migrations
- `infrastructure/` - launchd plist templates
- `templates/`, `examples/`, `tests/` - agent scaffolds, copyable examples, Vitest suite

**User layer (created locally by `/setup`, never shipped by upstream):**

- `agents/<id>/` - your agents
- `org/` - your company identity, brand voice, audience
- `ai-clone/` - your founder profile: voice, principles
- `content/` - artifacts agents produce (drafts, covers)
- `config/projects.md`, `allowlist.md`, `budget.md`, `support-source.md` - your registries

The exact boundary is machine-readable in [`engine-manifest.json`](engine-manifest.json) (`engine[]` vs `user[]`). Engine-tuning defaults that *do* update on pull (`config/pricing.md`, `triage.md`, `report.md`, `embeddings.md`, `investigate.md`, `solve.md`) stay tracked - those are engine defaults, not your customization. A Vitest proof asserts no user-layer file is ever tracked.

## Example agents

`/setup` copies one example agent you choose from `examples/agents/` into `agents/`. Every example ships `enabled: false` (nothing runs until you configure it) **except** `example-noop`, which ships `enabled: true` as the first smoke. Running any agent needs the baseline LLM key (`ANTHROPIC_API_KEY`) and a migrated dev DB - see Quickstart.

- **`article-writer`** (flagship) - an autonomous article factory: picks an angle, runs viral scoring, drafts, then multi-stage QA (anti-AI, tone, uniqueness, de-identification), and writes markdown + paste-ready HTML + a typography SVG cover (PNG if the optional `sharp` dependency is installed) to `./content/`. Self-contained: **no project secrets and no DB by default** beyond the baseline LLM key (its stage-2 research queries a free public DuckDuckGo endpoint; output and cover stay local). External publishing is opt-in via `target.yml.example` (copy to `target.yml` to activate); the shipped vc.ru/Osnova publisher and Gemini cover generator under `src/publish/` are **optional reference adapters**, not core - wire your own platform the same way.
- **`financial-yesterday`**, **`db-morning-triage`**, **`metrics-weekly`**, **`support-triage`**, **`critical-alerts`** - analytics/ops examples, mostly read-only DB plus Telegram.
- **`example-noop`** - a zero-tool health-check (the smallest working agent): no Telegram, no project data - just the baseline LLM key plus a migrated dev DB. It makes one tiny haiku call and writes a journal/audit row. It ships **`enabled: true`** (intentionally - it is `schedule: manual`, so it never runs on its own, only when you invoke it) so it is your first real smoke: `pnpm db:migrate && pnpm dev:run example-noop`.

## Updates

Add the upstream remote once (`git remote add upstream <URL>`), then run **`pnpm update-engine`** whenever you want to pull a new release. It applies *only* the `engine[]` paths, then runs install, migrations, build, and tests. Your `agents/`, `org/`, and `ai-clone/` are untouched. See **[docs/UPDATING.md](docs/UPDATING.md)**.

## Stack

- **Language / runtime:** TypeScript on Node.js 22 (`.nvmrc`), managed with **pnpm**
- **LLM:** Claude Agent SDK with an `ANTHROPIC_API_KEY` (`LLM_TRANSPORT=apikey`, the default). An experimental, not-endorsed `oauth` mode (route via a self-hosted gateway, not shipped) exists for subscription billing - see src/llm/transport.ts; it may conflict with provider ToS, use at your own risk
- **HTTP:** [Hono](https://hono.dev/) (webhook + bridge server)
- **Database:** SQLite + [sqlite-vec](https://github.com/asg017/sqlite-vec), with [Prisma](https://www.prisma.io/) as the ORM
- **Telegram:** [grammy](https://grammy.dev/) long-poll, with a plain-text fallback when Markdown fails to parse
- **Scheduling:** macOS **launchd** backed by a SQLite queue with idempotency keys
- **Quality:** Vitest, [Biome](https://biomejs.dev/), lefthook

Key commands: `pnpm install`, `pnpm build` (Biome check + Prisma generate + `tsc` + Vite build - **Biome formatter errors fail the build**), `pnpm test` (Vitest; needs `DATABASE_URL`, e.g. `file:./dev.db`), `pnpm db:migrate`. Platform secrets (Telegram tokens) live in the macOS Keychain via [keytar](https://github.com/atom/node-keytar); `.env`/`.env.local` (both git-ignored) hold `DATABASE_URL`, public defaults, and - for the `apikey` transport - `ANTHROPIC_API_KEY` (the code reads it from the environment; the Keychain adapter for that key is not wired in v1.0).

## The 3D-office bridge UI

`bridge/` ships a React + react-three-fiber **3D "office"** view of your co-founder: a Hono server feeds a live UI where each agent is a desk you can watch work. Run it locally with `pnpm bridge:dev` (Vite + Electron).

## Docs

- **[SETUP.md](SETUP.md)** - first-run onboarding, end to end
- **[docs/AGENTS.md](docs/AGENTS.md)** - the agent folder format in full
- **[docs/UPDATING.md](docs/UPDATING.md)** - pulling engine releases safely
- **[docs/CONTRIBUTING.md](docs/CONTRIBUTING.md)** - contributing to the engine

## A note on language

The runtime, this README, `SETUP.md`, and everything under `docs/` are in English. Some internal working notes (`CLAUDE.md`, parts of `org/` and `ai-clone/`) are in the author's native language - rewrite them in your own voice when you configure your fork. Note too that the **example agents' prompts** (`examples/agents/*/prompt.md`, `rules.md`) and the engine's **Telegram report templates** (`src/report/templates/`) are written in the author's native language, and **an agent's prompt language drives its output language** - translate any example before you enable it, and override report wording per agent via `agents/<id>/report.md` (or translate the engine templates).

Throughout the docs you will see a running fictional example - **Alex Rivera**, a solo founder, building **Acme Academy** (project id `example-project`, domain `acme.example.com`). It exists only to make the configuration layers concrete; replace it with your own.

## License

[MIT](LICENSE).
