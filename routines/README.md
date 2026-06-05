# routines/ — legacy-формат (до OSS v1.0)

В v1.0 «сотрудник» — это самодостаточная папка [`agents/<id>/`](../docs/AGENTS.md), а не
один flat-файл. Примеры новых агентов лежат в [`examples/agents/`](../examples/agents/),
`/setup` копирует выбранные в `agents/`.

Эта папка оставлена для **обратной совместимости**: движок (`src/routines/registry.ts`)
читает и `agents/*/AGENT.md`, и legacy `routines/*.md`. При коллизии id агент из `agents/`
побеждает, legacy молча игнорируется.

## Мигрируешь со старого формата?

Если у тебя есть свои `routines/<id>.md`, переведи их в папки-агенты кодмодом:

```bash
pnpm exec tsx scripts/migrate-routines.ts            # dry-run, покажет план
pnpm exec tsx scripts/migrate-routines.ts --write    # создаст agents/<id>/
pnpm exec tsx scripts/migrate-routines.ts --write --delete   # + удалит flat-файлы
```

ВАЖНО: имя папки агента = `id` из frontmatter (не имя файла) — launchd-плисты вшивают
именно `id`. Для cron-агентов после миграции переустанови плист (см. docs/AGENTS.md).
