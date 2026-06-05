# Setup

This is the step-by-step onboarding guide for the **AI Cofounder** framework. By the end you
will have a forked, configured, and runnable co-founder that talks to you over Telegram and
runs scheduled agents on your Mac.

If you have not read it yet, start with **[README.md](README.md)** - especially the **4-layer
model**:

1. **Engine** (`src/`, `bridge/`, `skills/`, `scripts/`, `.claude/`, `prisma/`,
   `infrastructure/`) - *how* to think and act. Upstream owns it; you do not edit it.
2. **`agents/<id>/`** - *what* each agent does, with which permissions, model, and schedule.
   This is your main customization surface.
3. **`org/`** - *who* the company is (identity, brand-voice, audience).
4. **`ai-clone/`** - *who* the founder is (voice, principles). Travels with you across projects.

This guide configures the top three layers and leaves the engine alone.

Throughout, we use the README's running example: solo founder **Alex Rivera** building **Acme
Academy**, an online-course business with project id `example-project` and domain
`acme.example.com`. Replace it with your own business as you go.

The engine/user boundary is machine-readable in
[`engine-manifest.json`](engine-manifest.json) (`engine[]` vs `user[]`). The whole user layer
(`agents/`, `org/`, `ai-clone/`, `content/`, and the user config files) ships **empty** from
upstream and is git-ignored - that is exactly how a `git pull` of engine updates never touches
your customization. The steps below materialize that layer locally from `examples/` and
`config/*.example.md`.

---

## Fastest path: the `/setup` slash command

If you have the `claude` CLI, the quickest way to onboard is the guided **`/setup`** command
([`.claude/commands/setup.md`](.claude/commands/setup.md)). Open this repo in Claude Code and run:

```
/setup
```

It walks you through the whole thing one question at a time, is idempotent (it detects what is
already configured and skips it), never prints secret values, and never commits or pushes. Its
steps:

0. **Preflight** - checks Node 22 (against `.nvmrc`), `pnpm`, and the `claude` CLI; runs
   `pnpm install` if `node_modules` is missing.
1. **`ai-clone/` (who is the founder)** - seeds `ai-clone/` from `examples/ai-clone-seed/` and
   asks for your name, style, and principles.
2. **`org/` (what is the business)** - seeds `org/` from `examples/org-seed/` and asks for your
   brand, audience, and product.
3. **LLM transport** - `apikey` (`ANTHROPIC_API_KEY` in `.env.local`, the default and recommended
   path) or the experimental, not-endorsed `oauth`; creates `.env` from `.env.example` with
   `LLM_TRANSPORT=` and `DATABASE_URL="file:./dev.db"`.
4. **Database** - runs `pnpm db:migrate`.
5. **Secrets to Keychain** - prompts for each needed key and stores it in the macOS Keychain via
   `keytar`, never in `.env`.
6. **Telegram** - takes your BotFather token (to the Keychain) and your founder `chat_id` (to
   `config/allowlist.md`), then does a message round-trip to confirm delivery.
7. **Upstream remote** - `git remote add upstream <URL>` so engine updates can be pulled later.
8. **First agent** - lists `examples/agents/`, recommends `article-writer` for a no-secrets demo,
   copies it into `agents/`, sets `enabled: true`, and verifies the folder parses.
9. **Smoke run plus schedule** - runs the agent once, confirms a Telegram ping or journal entry,
   and offers to install a launchd plist if the agent is on a `cron` schedule.

It finishes with `pnpm build && pnpm test` as the green-state check.

The rest of this document is the **manual fallback**: the same steps, done by hand, if you would
rather not use the slash command (or want to understand what it does).

---

## Manual walkthrough

### 1. Prerequisites

- **macOS.** The framework is local-first: it stores secrets in the macOS Keychain and
  schedules itself with `launchd`. Both are macOS-specific.
- **Node.js 22 LTS.** The pinned version is in [`.nvmrc`](.nvmrc); `nvm use` picks it up.
- **pnpm.** The package manager for this repo (`corepack enable` is the simplest way to get it).
- **The `claude` CLI** - required for the `/setup` command. (Check with `which claude`.)
- **A way to talk to Claude** - in practice, an **Anthropic API key**:
  - **API key (default, recommended, supported).** Set `LLM_TRANSPORT=apikey` and put
    `ANTHROPIC_API_KEY` in `.env.local` (step 3). No Go, no gateway, no separate CLI login -
    this makes the whole walkthrough work end to end. Inference is billed per token to your account.
  - **OAuth (experimental, NOT endorsed, use at your own risk).** An optional mode that routes
    `call.ts` through a **local gateway you run yourself** (`LLM_GATEWAY_URL`; the gateway is
    **not shipped** with this repo) and runs sub-agents via the native `claude` CLI (its own login).
    Its purpose is to bill inference against a Claude.ai subscription instead of per token.
    **Routing inference around the standard API may conflict with your LLM provider's Terms of
    Service** - this mode is provided as-is and is not a supported path. Most forkers should use
    `apikey` and ignore this.

### 2. Install

```bash
# Fork on your Git host first, then clone your fork:
git clone <your-fork-url> ai-cofounder
cd ai-cofounder

# Use the pinned Node version
nvm use            # reads .nvmrc (Node 22 LTS)

# Install dependencies
pnpm install
```

`pnpm install` runs `prisma generate` as a `postinstall` step, so the Prisma client is ready.
Use `pnpm build` (not a bare `tsc`) when you build - the build runs Biome plus the bridge
bundle, and a Biome formatting error will fail it.

> **First-install heavyweights (all expected for a local-first app):** `pnpm install` downloads
> an Electron binary (~100-150 MB) used only by the optional `pnpm bridge:dev` 3D-office UI - set
> `ELECTRON_SKIP_BINARY_DOWNLOAD=1` if you only use the CLI. Do **not** pass `--no-optional` /
> `--omit=optional`: the Claude Agent SDK ships its `apikey`-path runtime as a platform-specific
> optional native dependency, and agent runs fail without it. Separately, the **first** time a
> `support-triage` / `db-morning-triage` agent runs, it downloads a ~120 MB local embedding model
> to `~/.cache/huggingface` (needs network once, then fully offline); the `example-noop` and
> `article-writer` paths do not.

### 3. Environment (`.env`)

Copy the template and edit it:

```bash
cp .env.example .env
```

The committed [`.env.example`](.env.example) documents every variable the code reads, grouped by
area. Public, non-secret defaults are pre-filled (for example `DATABASE_URL`, `LLM_TRANSPORT`,
`LLM_GATEWAY_URL`, and the bridge ports); secret-bearing variables are left blank for you to
fill. Fill in just the ones your setup needs.

```bash
# Local SQLite file; the path is resolved relative to prisma/schema.prisma
DATABASE_URL="file:./dev.db"
```

Set your transport here too:

- **API key (default, recommended):** `LLM_TRANSPORT=apikey`. Put the key in **`.env.local`**
  (git-ignored) as `ANTHROPIC_API_KEY=...`. The code reads this key from the environment, **not**
  the Keychain (the Keychain adapter for the Anthropic key is not wired in v1.0), so `.env.local`
  is the right place - git-ignored, never committed.
- **OAuth (experimental, NOT endorsed, at your own risk):** `LLM_TRANSPORT=oauth` routes `call.ts`
  through a **local gateway you run yourself** at `LLM_GATEWAY_URL` (not shipped with this repo)
  and runs sub-agents via the native `claude` CLI (which you must `claude login` first). It bills a
  Claude.ai subscription instead of per token. **This may conflict with your provider's Terms of
  Service**; it is provided as-is, not supported. Prefer `apikey`.

**`.env` holds only `DATABASE_URL` plus public defaults. Platform secrets (Telegram tokens) live
in the macOS Keychain; the one exception is the `apikey`-transport `ANTHROPIC_API_KEY`, which goes
in `.env.local`.** Both `.env` and `.env.local` are git-ignored - never commit them.

### 4. Database

Apply the migrations and initialize the vector extension:

```bash
pnpm db:migrate     # prisma migrate deploy + sqlite-vec init (scripts/init-vec.ts)
```

Make sure `DATABASE_URL` is visible to the process - it is read from `.env`.

### 5. Secrets in the macOS Keychain

Credentials never live in `.env` files - they live in the **macOS Keychain**, accessed through
`keytar`. The framework reads them by service name; the framework's own namespace prefix is
**`ai-cofounder.`**.

| Service name | Holds | How to store |
|---|---|---|
| `ai-cofounder.tg-bot` | Founder Telegram bot token (account `default`) | `pnpm pair` (step 6) |
| `ai-cofounder.support-bot` | Support Telegram bot token (account `default`) | `pnpm pair:support` |

The `apikey`-transport `ANTHROPIC_API_KEY` is the **exception**: the code reads it from the
environment, so put it in `.env.local` (git-ignored), **not** the Keychain. The general Keychain
pattern below is for the platform tokens in the table above (Telegram); never echo a secret into
shell history:

```bash
pnpm exec tsx -e "import('keytar').then(k => k.setPassword(SERVICE, 'default', VALUE))"
```

> An agent may only read secrets it lists in its `permissions.yml` `secrets:` array. That
> allowlist is enforced at the cross-project `syncEnv` boundary (the point where env keys are
> copied into an external repo). An agent with no `target.yml` runs self-contained and needs no
> secrets at all - the `article-writer` example ships with `secrets: []`.

### 6. Telegram

The co-founder talks to you over a Telegram bot. Each channel has an **allowlist** of chat ids
permitted to message it.

1. **Create a bot.** Message **@BotFather**, send `/newbot`, follow the prompts. BotFather
   returns a token shaped like `12345678:AA...`.
2. **Find your chat id.** Message **@userinfobot**; it replies with your numeric chat id (a
   positive number is a personal chat; a negative number is a group/channel).
3. **Pair.** The interactive pairing script stores the token in the Keychain under
   `ai-cofounder.tg-bot` and adds your chat id to the allowlist:

   ```bash
   pnpm pair        # asks for the bot token and your chat id
   ```

   If `config/allowlist.md` does not exist yet, create it from the committed example first:

   ```bash
   cp config/allowlist.example.md config/allowlist.md
   ```

   The founder chat id goes under the `## founder-bot` section, one `- <chat_id>` per line
   (optionally `- <chat_id> # comment`). Until the list has at least one id, the bot answers no
   one. The support bot is separate - its source list is `config/support-source.md` (copy from
   `config/support-source.example.md`), paired with `pnpm pair:support`.

### 7. Seed the founder and org layers

These two layers turn the generic engine into *your* co-founder. They ship empty from upstream;
seed them from the examples:

```bash
cp -R examples/ai-clone-seed/.  ai-clone/      # who the founder is
cp -R examples/org-seed/.       org/           # who the company is
```

- **`ai-clone/`** - the founder layer ("who is speaking and how I decide"). Edit
  `ai-clone/role.md`, `ai-clone/voice/`, `ai-clone/principles/`, and add lessons to
  `ai-clone/feedback/` in the `Rule -> Why -> How` format. This layer **travels with you** and is
  read *before* `org/`, so the agent learns *who* is speaking before *what* it works on. Make it
  Alex Rivera's voice.
- **`org/`** - the business layer ("what we are building"). Edit `org/identity.md`,
  `org/brand-voice.md`, and `org/audience.md` to describe Acme Academy: who you serve, how you
  sound, what you sell. This layer **stays with the project**.

### 8. Copy your first agent

An agent is a self-contained folder `agents/<id>/`. The minimum is two files: `AGENT.md` (YAML
frontmatter plus a short description) and `prompt.md` (the full instructions). Optional files:
`permissions.yml`, `rules.md`, `report.md`, and `target.yml`. The registry
(`src/routines/registry.ts`) loads both new `agents/*/AGENT.md` folders and any legacy
`routines/*.md` files; on an id collision the agent wins.

For your **first smoke run**, copy **`example-noop`** - the smallest working agent (haiku, ~60s,
zero tools, no Telegram and no project data; it uses the LLM key from step 3 and the dev DB from
step 4). It ships `enabled: true`, so once copied it runs immediately and proves the loader ->
dispatcher -> journal path end to end:

```bash
cp -R examples/agents/example-noop agents/example-noop
```

`examples/agents/` ships **seven** examples. The richer ones, which you enable after configuring:

- **`article-writer`** (flagship autonomous article factory) - picks an angle, scores it for
  virality, drafts, runs multi-stage QA / anti-AI / de-identification, and writes markdown +
  paste-ready HTML + a typography SVG cover (PNG if the optional `sharp` dep is installed) to
  `./content/`. **No project secrets and no DB by default** (beyond the baseline LLM key) - its stage-2 research makes one call to a
  public DuckDuckGo endpoint (which may occasionally captcha or return empty; it continues
  without it). It is a full **Opus** run, up to ~90 min: a richer second agent, not the first
  smoke. External publishing is opt-in via `target.yml.example`.
- **`financial-yesterday`, `db-morning-triage`, `metrics-weekly`, `support-triage`,
  `critical-alerts`** - analytics/ops examples. They query an **external** project database and
  read Telegram, so on a fresh fork they are **inert** (the synthetic `self` project has no DB
  connection) until you register a project in `config/projects.md` - see
  [`docs/AGENTS.md`](docs/AGENTS.md). They are demonstrations of shape, not turnkey on a fresh clone.

Apart from `example-noop`, examples ship `enabled: false`; you enable an agent after configuring
it (and, for a cron agent, install its launchd plist).

> **Language note:** the example agents' `prompt.md`/`rules.md` and the engine's Telegram report
> templates (`src/report/templates/`) are written in the maintainer's native language (Russian),
> and **an agent's prompt language drives its output language**. Before enabling an example,
> translate its `prompt.md`; to change report wording, override per agent with `agents/<id>/report.md`
> (or translate the engine templates). The README language note covers the docs; this covers runtime output.

The `AGENT.md` frontmatter (from the `article-writer` example):

```yaml
---
id: article-writer
displayName: Article Writer        # required
role: Content factory
avatar: "✍️"
color: "#9F7AEA"
model: opus                        # required: opus|sonnet|haiku alias, or a full claude-*/voyage-* id
enabled: false                     # required: set true to let it run
schedule: manual                   # required: manual | cron (";"-joined slots allowed)
output: both                       # required: telegram | journal | both
maxTokens: 32000
timeoutMs: 5400000
skills:                            # optional: shared library skills (skills/) or own namespaced ones
  - article-writing
  - research-serp
  - seo-audit
  - cover-design
---

Short description of what the agent does goes in the body.
```

The `opus` / `sonnet` / `haiku` aliases resolve to `claude-opus-4-7` / `claude-sonnet-4-6` /
`claude-haiku-4-5`. These ids are pinned to the maintainer's Claude access; if your account or API
key does not serve one (or Anthropic retires it), update the single alias map in
`src/routines/agent-loader.ts` plus the matching keys in `config/pricing.md` (see docs/AGENTS.md).

The optional `permissions.yml` controls what the agent may touch. **Absent = zero tools =
silence is safe.** Its `tools[]` must use real names from `src/routines/tool-registry.ts` (for
example `project.read`, `project.grep`, `project.glob`, `project.bash`, `project.db.query`,
`project.telegram.read`, `journal.search`, `report.send`). `bash[]` extends the default
whitelist (pipe, redirect, `&&`, and backtick are always forbidden); `secrets[]` lists the
Keychain keys the agent may read. `dbScopes`, `budget`, `telegram`, and `maxStepsPerRun` are
**declarative in v1.0** - they document intent and are not yet enforced at runtime.

Set `enabled: true` once you have reviewed it:

```yaml
enabled: true
```

To scaffold a brand-new agent instead of copying one, use the **`/scaffold-agent <id>`** slash
command - it creates `agents/<id>/` from `templates/agent/`, asks identity / model / tools /
schedule one question at a time, and validates that the folder parses.

### 9. Run it once

Run the agent manually and confirm it produces output (a journal entry, or a Telegram ping for
agents with `output: telegram`). `pnpm dev:run` refuses to run a disabled or unknown agent with a
clear message, so start with the always-enabled smoke:

```bash
pnpm dev:run example-noop              # the fast smoke: proves the pipeline in ~60s
# then, once a transport is configured, try the richer flagship:
pnpm dev:run article-writer --unique   # full Opus run (can take a while), like /run from Telegram
```

For a delayed one-shot:

```bash
pnpm exec tsx scripts/schedule-one-shot.ts article-writer 300   # run in 5 minutes
```

### 10. Schedule it (optional, for `cron` agents)

If the agent's `schedule` is a cron expression, install its launchd plist. The installer
**writes the plist but does not load it** - it prints the `launchctl` command so you stay in
control:

```bash
pnpm install:launchd:routines              # writes ~/Library/LaunchAgents/com.ai-cofounder.routine-<id>.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.ai-cofounder.routine-article-writer.plist

# useful flags:
pnpm install:launchd:routines -- --dry-run            # validate only, write nothing
pnpm install:launchd:routines -- --only article-writer

# remove later:
pnpm uninstall:launchd:routines
```

The folder name equals the frontmatter `id`, and launchd plists embed that id - so do not rename
a scheduled agent's folder without reinstalling its plist.

---

## The green check

After every configuration change, run the full check the engine ships with:

```bash
pnpm build && pnpm test
```

- `pnpm build` runs `biome check` + `prisma generate` + `tsc` (twice) + the Vite bridge bundle.
  A Biome formatting error fails the build.
- `pnpm test` runs Vitest; it needs `DATABASE_URL` (for example `file:./dev.db`).

A vitest proof (`tests/engine/engine-user-split.test.ts`) also asserts that **zero** user-layer
files are tracked in git and that all of them are git-ignored - so a green test run confirms your
customization stays separate from the engine.

---

## You're set

You now have the engine built, a transport chosen, secrets in the Keychain, Telegram paired, the
founder/org layers seeded, and your first agent running. From here:

- Add more agents with `/scaffold-agent <id>` (or by copying another `examples/agents/` folder).
- Pull engine updates without touching your layer: `git remote add upstream <URL>` once, then
  `pnpm update-engine` (see `docs/UPDATING.md`). It applies only the `engine[]` paths from
  `engine-manifest.json`, then re-runs install, migrate, build, and test.
- Have legacy `routines/<id>.md` files? Convert them to agent folders with
  `scripts/migrate-routines.ts` (dry-run by default; `--write` to apply, `--delete` to remove the
  old file).
