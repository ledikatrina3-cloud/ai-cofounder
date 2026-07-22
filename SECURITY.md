# Security Policy

## Supported versions

This project is released as a framework you run yourself. Security fixes land on
`main` and in tagged releases. Only the latest tagged release is supported.

| Version | Supported |
|---|---|
| `1.0.x` | ✅ |
| `< 1.0` | ❌ |

## Threat model — read this before running agents

AI Cofounder is a **local-first agent runtime**. On your own machine, under your own
user account, it can:

- execute shell commands (`project.bash`),
- read and write files in a project directory (`project.files`),
- query a local database (`project.db`),
- send messages over Telegram (`project.telegram`),
- call the Claude API (and, optionally, other model providers) using **your** keys.

That power is the product. It also means **an agent is code you are trusting**. Its
`prompt.md`, `rules.md`, `skills/`, and `permissions.yml` define what it may do — treat
them with the same care you would treat a script that runs on a cron with your
credentials.

### What the engine does to reduce blast radius

- **Per-agent permissions.** Each `agents/<id>/permissions.yml` declares the tools, the
  bash-command allowlist, the secrets, and the DB scopes that agent may use. Tools, the
  bash allowlist, and secrets are enforced at runtime in v1.0.
- **Bash sandbox.** `project.bash` runs only allowlisted command prefixes, blocks a
  denylist of dangerous substrings, and rejects path traversal that would escape the
  agent's working directory.
- **Read-only file tool by default.** `project.files` is constrained to the agent's
  project directory; destructive file operations are not exposed implicitly.
- **Secret isolation.** Secrets are read from the OS keychain (via `keytar`) or a
  git-ignored `.env.local`. They are never committed, and the bridge UI redacts them
  from its event stream. Nothing under the user layer (`agents/`, `org/`, `ai-clone/`,
  `config/*.md`, the database, `.env*`) is tracked by the public engine repository.
- **Anti-leak guard.** A test (`tests/anti-leak.test.ts`, run in CI and as a pre-commit
  hook) scans the engine surface for personal markers and real token shapes, so private
  data cannot drift into a public commit.
- **Frozen agent contract.** `AGENT.md` carries a `schemaVersion`; an agent authored for
  a newer engine fails fast with a clear "update the engine" error instead of silently
  mis-parsing.

### Risks you own as the operator

- **Prompt injection.** An agent that reads untrusted external content (web pages, search
  results, support messages, email) can be steered by text in that content. Tool
  allowlists and the bash sandbox bound the damage, but do not eliminate it. Give
  externally-exposed agents the **narrowest** permissions that let them do their job, and
  never grant an internet-reading agent broad bash or write access to sensitive paths.
- **Over-broad permissions.** A wide bash allowlist or a long `secrets` list on one agent
  widens what a single compromised run can reach. Scope minimally.
- **The bridge server.** The 3D-office bridge is intended to bind to `127.0.0.1`. Do not
  expose it to a network you do not trust; it has no built-in authentication.
- **Your keys, your bill.** Autonomous agents call paid APIs on a schedule. Use the
  per-agent `budget` field and your provider's spend limits.

### Hardening checklist

- Review an agent's `prompt.md`, `rules.md`, and `skills/` before you set `enabled: true`.
- Keep the bridge bound to localhost.
- Store secrets in the keychain or `.env.local`, never in an agent folder or a commit.
- Rotate API keys periodically; use separate keys per machine.
- Run untrusted or experimental agents with `enabled: false` and trigger them manually
  first.

## Reporting a vulnerability

**Please do not open a public issue for a security vulnerability.**

Report it privately through GitHub's **"Report a vulnerability"** flow on this
repository's **Security → Advisories** tab (private vulnerability reporting). Include:

- a description of the issue and its impact,
- steps to reproduce or a proof of concept,
- affected version / commit.

You can expect an initial acknowledgement within a few days. Once a fix is available and
released, the advisory will be published with credit to the reporter (unless you prefer
to remain anonymous).
