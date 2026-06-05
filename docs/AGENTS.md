# Agents

The definitive guide to creating and configuring an agent in AI Cofounder.

An **agent** is a self-contained folder `agents/<id>/` that says **WHAT** one
employee of your AI co-founder does, with which permissions, model, and
schedule. The engine in `src/` already knows **HOW** to think and act; `org/`
and `ai-clone/` say **WHO** (the company and the founder). The agent folder is
your main customization surface. Reconfigure the top layers and the same engine
becomes a co-founder for another business.

This page covers: the folder anatomy, the exact `AGENT.md` frontmatter, what
`permissions.yml` enforces vs declares in v1.0, `rules.md` and `@`-includes,
`report.md` precedence, skills, `target.yml` for opt-in cross-project work, how
to scaffold an agent, how to enable and schedule one, a fully worked example,
and how to validate that a folder parses.

---

## 1. Folder anatomy

A minimal agent is **two files**: `AGENT.md` plus `prompt.md`. Everything else
is optional, and the governing principle is **silence is safe**: if you do not
declare a capability, the agent does not have it.

```
agents/<id>/
├── AGENT.md          REQUIRED  frontmatter (YAML) + a one-paragraph description
├── prompt.md         REQUIRED  the agent's full instructions (its task / system prompt)
├── permissions.yml   optional  ABSENT = zero tools = the agent cannot touch anything
├── rules.md          optional  guardrails injected as a "## Guardrails" section
├── report.md         optional  per-agent Telegram template (first in the lookup order)
├── target.yml        optional  PRESENCE = opt-in cross-project; default is self-contained
└── skills/<name>/    optional  the agent's own namespaced skills (SKILL.md each)
```

| File / folder | Required? | If absent |
|---|---|---|
| `AGENT.md` | **Yes** | The folder does not parse. |
| `prompt.md` | **Yes** | The folder does not parse (it cannot be empty either). |
| `permissions.yml` | No | The agent gets **zero tools**. Safe default. |
| `rules.md` | No | No guardrails section is injected. |
| `report.md` | No | Reporting falls back to the shared templates (see section 6). |
| `target.yml` | No | The agent is **self-contained** and runs in-process. |
| `skills/` | No | The agent uses only shared-library skills it references. |

The folder name `<id>` is **load-bearing**: it **is** the agent id, the single
source of truth (launchd plists embed it as `com.ai-cofounder.routine-<id>`). An
`id:` field in `AGENT.md` is **optional** and, if present, **must equal the
folder basename** - it is only a redundant confirmation. A mismatch is **rejected
at load** with a hard parse error (see section 8).

---

## 2. AGENT.md frontmatter

`AGENT.md` is YAML frontmatter between `---` delimiters, followed by a body. The
body is a short description of the agent's role (it becomes part of the system
prompt). The frontmatter is parsed with a real YAML parser.

| Field | Type | Allowed values | Required? |
|---|---|---|---|
| `id` | string | kebab-case identifier | No (the id is always the folder name; if you set this field it **must equal the folder basename**, else load is rejected) |
| `displayName` | string | the employee's name in the 3D office | **Yes** |
| `role` | string | one-line role label | No |
| `avatar` | string | an emoji | No |
| `color` | string | a hex color, e.g. `"#9F7AEA"` | No |
| `logo` | string | path / label | No |
| `model` | string | `opus` / `sonnet` / `haiku`, or a full `claude-*` / `voyage-*` id | **Yes** |
| `enabled` | boolean | `true` / `false` | **Yes** |
| `schedule` | string | `manual`, or a cron expression (`;`-joined slots allowed) | **Yes** |
| `output` | string | `telegram` / `journal` / `both` | **Yes** |
| `maxTokens` | integer | positive integer | No (default `16000`) |
| `timeoutMs` | integer | positive integer | No (default `600000`) |
| `department` | string | a department id | No |
| `skills` | string[] | YAML list of skill references (see section 7) | No |
| `forceLoad` | string[] | YAML list of skills to load unconditionally | No |

### Model aliases

`model` accepts a short alias that the loader resolves to a pinned id:

| Alias | Resolves to |
|---|---|
| `opus` | `claude-opus-4-7` |
| `sonnet` | `claude-sonnet-4-6` |
| `haiku` | `claude-haiku-4-5` |

A full `claude-*` or `voyage-*` id passes through as written. Using an alias
means a future model bump upgrades every fork for free.

The alias targets (`claude-opus-4-7` / `claude-sonnet-4-6` / `claude-haiku-4-5`)
are pinned to the maintainer's Claude access. If your subscription tier or API
key does not serve one of these ids (or Anthropic retires it), edit the single
`MODEL_ALIASES` map in `src/routines/agent-loader.ts` plus the matching keys in
`config/pricing.md`. A model your provider does not recognize fails the run with
a raw provider error, not a friendly message.

### Output aliases

`output` accepts `telegram`, `journal`, or `both`. Internally `telegram`
becomes the Telegram thread output and `journal` becomes journal-only; `both`
sends to Telegram and logs to the journal.

`schedule` is either the literal `manual` (you trigger the run by hand) or a
cron expression. Multiple cron slots can be joined with `;`.

---

## 3. permissions.yml: enforced vs declarative

`permissions.yml` is **optional**. Its absence means the agent has **zero
tools** and can do nothing except produce text - silence is safe. Add the file
only to grant capabilities, and grant only what the agent needs.

```yaml
tools:
  - report.send

# bash:
#   - git log
#   - git diff

# secrets:
#   - MY_API_KEY

# dbScopes:
#   read: []
#   write: []

# budget:
#   perRunUsd: 0.25
```

### Enforced in v1.0

- **`tools[]`** - the agent may use **only** the tools listed here. The runtime
  checks each tool call against this list. Names must be **real tool names from
  `src/routines/tool-registry.ts`** (see section 4). An unknown name is treated
  as unsupported, not invented.
- **`bash[]`** - extends the engine's `DEFAULT_WHITELIST` with additional
  command prefixes (for example `git log`, `git diff`). Internal spaces inside a
  prefix are allowed. The engine's `FORBIDDEN_SUBSTRINGS` - pipe `|`, redirect
  `>` / `<`, `&&`, backticks - are **always blocked**, regardless of what you
  whitelist.
- **`secrets[]`** - the Keychain keys this agent is allowed to read. This is
  **enforced at the cross-project `syncEnv` boundary**: only keys that appear in
  `secrets[]` can be synced into a target repo's `.env.local` (section 9). An
  undeclared secret cannot leak.

### Declarative in v1.0 (parsed, documents intent, not yet enforced at runtime)

- `dbScopes` (`read` / `write`)
- `budget` (`perRunUsd`)
- `telegram`
- `maxStepsPerRun`

These are parsed and document your intent, but the runtime does not yet tighten
behavior based on them in v1.0. Do not rely on them as a security boundary; full
enforcement is planned for v1.1. Be honest about this when designing an agent:
if an agent must not write to the database, do not give it a DB write tool -
do not lean on `dbScopes`.

---

## 4. Tool names (the only valid `tools[]` values)

The valid entries for `tools[]` are exactly the names defined in
`src/routines/tool-registry.ts`. Do not invent names.

| Tool name | What it does |
|---|---|
| `project.read` | Read files (maps to the SDK `Read` builtin). |
| `project.grep` | Search file contents (maps to `Grep`). |
| `project.glob` | Match file paths (maps to `Glob`). |
| `project.bash` | Run whitelisted shell commands (maps to `Bash`). |
| `project.db.query` | Query the database. Data is pre-fetched into the system prompt. |
| `project.telegram.read` | Read Telegram context. **Declarative in v1.0 - no data is injected yet** (no prefetch path), so agents that rely on reading Telegram are inert in v1.0. |
| `journal.search` | Search the journal. **Declarative in v1.0 - no data is injected yet** (`fetchJournalContext` is planned, not wired up). |
| `report.send` | Send the agent's output to Telegram / the journal per `output`. |

`project.read` / `project.grep` / `project.glob` / `project.bash` resolve to
Claude Agent SDK builtins directly. `project.db.query`, `report.send`, and
`journal.search` are handled by pre-fetch / the dispatcher: their data is
injected into the system prompt (or the dispatcher delivers the report) rather
than exposed as a live tool call. The agent still works; it just receives the
data up front. An unknown name degrades gracefully (the run still starts) but
grants nothing - so spell tool names exactly.

---

## 5. rules.md and @-includes

`rules.md` is optional. Its content is injected into the system prompt as a
`## Guardrails` section - hard rules the agent must not break.

`rules.md` supports `@<relative-path>` includes so you can pull in shared text,
but the path must stay **inside the agent's folder**. Any `@`-include that
contains `..`, or that resolves outside the agent directory, is **rejected** at
load time with a parse error. There is no traversal out of `agents/<id>/`. If
you want to reference company-level voice or brand, restate it inline (as the
flagship example does) rather than reaching up the tree.

---

## 6. report.md precedence

When the engine renders the Telegram message for a run, it looks up a template
in this order:

1. `agents/<id>/report.md` - the per-agent template (highest precedence).
2. `templates/<id>.md` - a shared per-id template.
3. `default.md` - the shared default template.
4. A built-in hardcoded fallback.

So dropping a `report.md` into the agent folder overrides everything else for
that agent. Omit it and the agent uses the shared default.

---

## 7. Skills

`skills:` (and `forceLoad:`) in the frontmatter are YAML lists that reference
skills two ways:

- **Shared-library skills** - a bare name that resolves to a skill in the
  repo's top-level `skills/` directory (for example `article-writing`,
  `research-serp`, `seo-audit`, `cover-design`).
- **The agent's own namespaced skills** - a `<id>.<skill>` name (a dot is
  allowed in the list, spaces are not) that resolves to a private skill living
  under the agent's own `agents/<id>/skills/<skill>/SKILL.md`.

Use the shared library for capabilities many agents reuse; use a namespaced
private skill when the behavior belongs only to this agent. `forceLoad:` loads
the listed skills unconditionally rather than on demand.

---

## 8. target.yml: opt-in cross-project

By **default an agent is self-contained**: it has no `target.yml`, runs
in-process, and only touches its own folder and whatever its tools allow.

Adding a `target.yml` is how you **opt in** to cross-project work - the agent
drives an adapter that lives in an **external repository**. Presence of the file
is the switch.

```yaml
cwd: "~/projects/your-site-repo"   # absolute path to the external repo (REQUIRED)
skills:                            # allowlist of skills the agent may call there
  - article-writing
  - cover-design
syncEnv:                          # env keys to copy into the target's .env.local
  - PUBLISH_TOKEN
```

The parser reads only `cwd`, `host`, `skills`, `maxTurns`, and `syncEnv`. There
is no `adapter` field here: which publisher adapter to run is decided by the
target repo itself (the platform is encapsulated on its side), not via this file.

| Field | Required? | Meaning |
|---|---|---|
| `cwd` | **Yes** | Absolute path to the external repo the agent runs in. |
| `host` | No | Optional host descriptor. |
| `skills` | No | Allowlist of skills the agent may call in the target repo. |
| `maxTurns` | No | Cap on turns for the cross-project run. |
| `syncEnv` | No | Env keys to copy into the target's `.env.local` before running. |

`syncEnv` is the security-sensitive one: it copies named env values into the
target repo's `.env.local` so a skill running in a foreign `cwd` can see them.
**Only keys that are also listed in `secrets[]` in `permissions.yml` are
synced** - this is the enforced boundary that stops an undeclared secret from
leaking into another repo. The values themselves are never stored in
`target.yml`; only the names. Keep a `target.yml.example` in the folder so
forkers know the shape, and copy it to `target.yml` only when they want to turn
cross-project on.

---

## 9. Creating an agent

### Option A: /scaffold-agent (recommended)

Run the slash command and answer one question at a time:

```
/scaffold-agent <id>
```

It walks you through: id and uniqueness check (it refuses an id already used in
`agents/` or in legacy `routines/`), identity (`displayName`, `role`,
`avatar`), model (`opus` / `sonnet` / `haiku`), what the agent does (becomes
`prompt.md`), permissions (it reads `src/routines/tool-registry.ts` and shows
the real tool names rather than inventing them; default is just `report.send`),
schedule (`manual` or a validated cron expression), output (`telegram` /
`journal` / `both`), and an advanced opt-in cross-project step that creates
`target.yml` only if you say yes. It then materializes the files from
`templates/agent/` with `enabled: false`, and finally validates that the folder
parses - it never leaves an unparseable folder behind.

### Option B: by hand

1. `mkdir -p agents/<id>`.
2. Copy `templates/agent/AGENT.md`, `templates/agent/prompt.md`, and (if you
   need tools) `templates/agent/permissions.yml` into the folder.
3. Replace the `{{...}}` placeholders in `AGENT.md` and write the real
   instructions in `prompt.md`.
4. Keep `enabled: false` until you have tested it.
5. Add `rules.md`, `report.md`, `skills/`, or `target.yml` only as needed.
6. Validate that the folder parses (section 11).

The template `AGENT.md` defaults to `model: sonnet`, `enabled: false`,
`schedule: manual`, `output: telegram`; the template `permissions.yml` grants
only `report.send`.

---

## 10. Enabling and scheduling

1. Set `enabled: true` in `AGENT.md` once the agent is configured and tested.
2. Register or refresh it via `/setup` (or by copying the folder into the active
   `agents/` directory of your installation).

**Manual** (`schedule: manual`) - you trigger the run yourself; nothing is
installed. This is the safest starting point and what the example agents use.

**Cron** (`schedule: <cron expression>`) - the run is scheduled. **launchd
note:** launchd plists embed the agent **id**. That is why the folder name must
equal the id (the folder-name = id invariant). If you change a cron agent's id
or add a new cron agent, you must reinstall the launchd plist for the schedule
to take effect. Do not enable a cron agent and assume the schedule is live until
the plist is reinstalled.

### The dual loader and id collisions

The registry (`src/routines/registry.ts`) loads **both** new-format
`agents/*/AGENT.md` folders and legacy flat `routines/*.md` files for backward
compatibility. On an **id collision**, the **agent wins** and the legacy routine
with the same id is silently skipped. All agents are owned by a synthetic
built-in project `self` whose path is the repo root, so `config/projects.md` is
**optional** - a self-contained fork that does no cross-project work does not
need it.

### Migrating legacy routines

If you have old flat `routines/<id>.md` files, convert them with:

```
pnpm exec tsx scripts/migrate-routines.ts                  # dry-run (default)
pnpm exec tsx scripts/migrate-routines.ts --write          # write the folders
pnpm exec tsx scripts/migrate-routines.ts --write --delete # write + remove the flat file
```

The new folder name is the frontmatter **id** (not the file name), because
launchd plists embed the id.

---

## 11. A fully worked example: financial-yesterday

This is the smallest realistic agent - a read-only daily money report for the
example company "Acme Academy". It has exactly three files.

`agents/financial-yesterday/AGENT.md`:

```yaml
---
id: financial-yesterday
displayName: Финансовый аналитик
role: Финансовый аналитик
avatar: 💰
color: "#c4a747"
model: claude-sonnet-4-6
enabled: false
schedule: manual
output: telegram
maxTokens: 16000
timeoutMs: 120000
---

Reads yesterday's purchases from the Acme Academy database and sends a short
financial report.
```

`agents/financial-yesterday/permissions.yml`:

```yaml
tools:
  - project.db.query
  - report.send
```

`agents/financial-yesterday/prompt.md` (abridged) - the full task: run **one**
SQL `SELECT` over `purchases` for yesterday (counts by status, paid revenue,
top payment providers), compare against the day before for a baseline, and send
a short Telegram report via `report.send`. The hard constraints live in the
prompt: read-only (`SELECT` only, never `UPDATE` / `DELETE` / `INSERT`), at most
two queries per run, and an honest fallback ("no purchases yesterday, all
clean") when the table is empty.

This agent declares only the two tools it needs, no `secrets`, no `target.yml`
(self-contained), no `bash` (no shell needed), and `manual` scheduling.

**Honesty note (fresh fork):** these analytics examples (`financial-yesterday`,
`metrics-weekly`, `db-morning-triage`) query an **external project database**
via `project.db.query`, and that data is pre-fetched into the system prompt. On
a fresh fork the synthetic `self` project has **zero DB connections**, so their
DB preload is empty and they have nothing to report. They stay **inert** until
you (1) register a project in `config/projects.md`, (2) add db-connection
details in `projects/<id>/map.md`, and (3) store a **read-only** DSN in the
Keychain. Only `article-writer` and `example-noop` work with no external data.

### The flagship: article-writer

For a larger example, `examples/agents/article-writer/` is an autonomous
content factory. It uses every optional file: `permissions.yml`
(`project.read` / `project.grep` / `project.glob` / `project.bash` /
`report.send`, `secrets: []`), `rules.md` (headline, link, anti-AI, and
de-identification guardrails, all inline - no `@`-includes that leave the
folder), a `content/` output directory, and a `target.yml.example` that is
**not** active until copied to `target.yml`. It references four shared-library
skills (`article-writing`, `research-serp`, `seo-audit`, `cover-design`), ships
`enabled: false`, and by default writes a markdown draft, paste-ready HTML, and
a typography PNG cover to `./content/` with **no network and no secrets** -
external publishing is strictly opt-in.

---

## 12. Validating that a folder parses

Never leave an unparseable folder. After creating or editing an agent, load it
through the parser:

```
pnpm exec tsx -e "import('./src/routines/agent-loader.js').then(m=>m.parseAgentFolder(process.cwd()+'/agents/<id>').then(r=>console.log('OK',r.id,r.model,r.outputType)))"
```

If it prints `OK <id> <resolved-model> <output-type>`, the folder is valid. If
it throws a parse error, the message names the file and the problem. Common
causes:

- `AGENT.md` does not start with a `---` frontmatter delimiter, or the
  frontmatter is not a YAML mapping.
- A required field is missing (`displayName`, `model`, `enabled`, `schedule`,
  `output`).
- `prompt.md` is missing or empty.
- A `tools[]` name is not in `src/routines/tool-registry.ts`.
- A `skills` / `forceLoad` entry contains a space.
- An `id:` field is present but does not equal the folder basename.
- A `rules.md` `@`-include contains `..` or escapes the agent folder.
- An **unknown field** appears in `AGENT.md`, `permissions.yml`, or
  `target.yml` (see section 13).

Fix the named file and re-run the loader until it prints `OK`.

---

## 13. The frozen contract: `schemaVersion` and unknown fields

The agent format is **frozen** at a known set of fields. The loader rejects
anything it does not recognise instead of silently dropping it - so a typo like
`maxtoken:` (instead of `maxTokens:`) fails loudly at load time rather than
quietly falling back to the default.

**The accepted fields are exactly:**

- `AGENT.md` frontmatter: `schemaVersion`, `id`, `displayName`, `role`,
  `avatar`, `color`, `logo`, `department`, `model`, `enabled`, `schedule`,
  `output`, `maxTokens`, `timeoutMs`, `skills`, `forceLoad`.
- `permissions.yml`: `tools`, `bash`, `dbScopes`, `secrets`, `telegram`,
  `maxStepsPerRun`, `budget`.
- `target.yml`: `cwd`, `host`, `skills`, `maxTurns`, `syncEnv`.

Any other key is a parse error naming the file, the bad key, and the full list
of valid keys. The frozen sets live in `src/routines/agent-loader.ts`
(`FROZEN_AGENT_SCHEMA`, `PERMISSIONS_SCHEMA`, `TARGET_SCHEMA`) and are exported
for tooling.

### `schemaVersion` and forward compatibility

`schemaVersion` is **optional**. If you omit it, the loader treats the file as
the engine's current schema version. You normally never write it by hand. If you
do, **always quote it** (`schemaVersion: "1.0"`) - an unquoted YAML number is
mangled (`1.10` parses as `1.1`), so the loader rejects a bare number outright.

It exists for **forward compatibility**. When a future engine release changes
the agent format in a breaking way, it bumps `CURRENT_AGENT_SCHEMA_VERSION`. If
you then try to load an agent whose `schemaVersion` is **newer** than the engine
understands, the loader stops with a clear message - *"schemaVersion 'X' is
newer than this engine understands; run `pnpm update-engine`"* - instead of
misinterpreting fields it does not know. The version check runs **before** the
unknown-field check, so a genuinely newer agent tells you to update the engine
rather than complaining about its new (legitimate) fields.

In short: omit `schemaVersion`, keep the engine current with `pnpm
update-engine`, and the freeze protects you from both typos (unknown fields) and
version drift (an agent from a newer engine).
