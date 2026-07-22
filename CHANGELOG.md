# Changelog

All notable changes to AI-Cofounder are documented here. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/); this project uses semantic versioning.

## [1.1.0] - 2026-06-24

### Added
- **Browser control panel** - full CRUD for agents, departments and skills directly
  in the bridge 3D-office, so a self-hosted user can author and run autonomous agents
  from the browser without editing files by hand.
  - `agents/<id>/` authoring: serializer + write module (create/edit/delete), routed
    via `POST`/`PATCH`/`DELETE /routines`. Self-contained agents attach to the
    built-in `self` project and need no `config/projects.md`.
  - Departments and skills CRUD (write modules + editor UI).
  - launchd schedule apply from the UI (macOS) with explicit confirmation.
  - `RoutineEditor` / `Teams` / `SkillEditor` components; office Create button,
    department selector, and drawers with Run/Edit/Delete/Schedule.

### Security
- `parser`: kebab-case id validation (`ROUTINE_ID_RE`) as an XML-injection guard.

### Tests
- Serializer round-trip, write-path, and agent-authoring tests.

## [1.0.0] - 2026-06-04

First open-source release. A local-first, proactive AI co-founder framework with a
clean engine/user separation so engine updates never overwrite your customization.

### Added
- **Self-contained agents** - an agent is now a folder `agents/<id>/` (AGENT.md +
  prompt.md, with optional permissions.yml / rules.md / report.md / target.yml /
  skills/). Minimum is two files; an absent permissions.yml means zero tools
  (silence is safe). See [docs/AGENTS.md](docs/AGENTS.md).
- **Dual loader** - the engine reads both `agents/*/AGENT.md` and legacy
  `routines/*.md`; on an id collision the agent wins and the legacy routine is
  skipped. A synthetic built-in `self` project owns all agents.
- **Model/output aliases** - `opus`/`sonnet`/`haiku` and `telegram`/`journal`/`both`
  resolve in the loader, so a model bump upgrades every fork for free.
- **Guided starter** - `/setup` (onboarding) and `/scaffold-agent <id>` slash
  commands, plus `templates/agent/`.
- **Example agents** under `examples/agents/`: the flagship `article-writer`
  (autonomous, de-identified, self-contained - writes to `./content/` with no
  network or secrets), plus analytics/ops examples (financial-yesterday,
  db-morning-triage, metrics-weekly, support-triage, critical-alerts). All ship
  `enabled: false`.
- **Engine/user split** - `git pull` of engine updates never touches the user
  layer (`agents/ org/ ai-clone/` + user config), enforced by absence: upstream
  ships zero files at those paths, they are gitignored, and `/setup` materializes
  them from `examples/` + `config/*.example.md`. Boundary in
  [`engine-manifest.json`](engine-manifest.json); flow in
  [docs/UPDATING.md](docs/UPDATING.md) via `pnpm update-engine`.
- **Migration tooling** - `scripts/migrate-routines.ts` converts legacy
  `routines/<id>.md` into `agents/<id>/` folders; `pnpm migrate` is the
  version-gated user-file schema seam.
- **Cross-project** is now opt-in per agent via `target.yml` (default is
  self-contained); `syncEnv` only copies env keys also declared in `secrets[]`.
- Docs: README, SETUP, AGENTS, UPDATING, CONTRIBUTING.

### Notes
- `permissions.yml` enforces `tools[]`, `bash[]`, and `secrets[]` (at the
  cross-project sync boundary). `dbScopes`/`budget`/`telegram`/`maxStepsPerRun`
  are declarative in v1.0 and documented as such; deeper enforcement is planned.
