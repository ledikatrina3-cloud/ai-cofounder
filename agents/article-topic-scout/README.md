# Article Topic Scout

`article-topic-scout` is a pre-research editorial agent. It does not write a brief, draft, cover, or publication. Its job is to choose one strong topic and hand it to the existing article pipeline through `topics/article-writer-next.md`.

## Inputs

- `field-notes/` or any local `field-notes*.md` file - preferred live material: recent failures, decisions, founder reactions, customer observations, and concrete situations.
- `departments/marketing-content/shared/topics-backlog.md` - raw material, not a queue to consume blindly.
- `content/*.md` - recent article anti-repeat context.
- Public reference blogs listed in local notes, for example `https://smyslokod.ru/guides`.

## Outputs

- `content/topics/article-topic-scout-latest.json` - machine-readable selected topic, candidates, rejected items, evidence, and gates.
- `content/topics/article-topic-scout-latest.md` - founder-readable explanation of the choice.
- `topics/article-writer-next.md` - written only when all gates pass; this is the handoff consumed by researcher/writer.

## Safety

The example is disabled by default, manual-only, and has no secrets, no DB, no external publishing target, and no Telegram read permission. It may read local project files, run small whitelisted shell commands, use the shared `research-serp` skill for public SERP checks, and send a report.
