# launchd routine plist: только node + tsx CLI напрямую, без pnpm и без sh-обёртки

## Rule

В `ProgramArguments` для launchd-плистов, запускающих TS-скрипты репо, **обязательно**:

```
<string>/абс/путь/к/node</string>                ← Mach-O бинарь вне ~/Documents
<string>/абс/путь/к/node_modules/.pnpm/tsx@*/node_modules/tsx/dist/cli.mjs</string>
<string>scripts/cron-run-routine.ts</string>     ← относительный путь от WorkingDirectory
<string>routineId</string>
```

**Никогда** в launchd-плистах: `pnpm <script>`, `tsx <script>` (через `node_modules/.bin/tsx`), `npx tsx ...`.

## Why

Поймано при настройке cross-project routine (план [`2026-05-22-cross-project-runner.md`](../../plans/)). Старый шаблон `pnpm --silent cron:run:routine <id>` тихо падал 2 дня — `.err` копил стектрейсы, `.log` был пустой, фаундер видел только что routine не отрабатывает.

Две ловушки сразу:

1. **pnpm 10.x + Node 25 под launchd → `EINTR: interrupted system call, uv_cwd`** в `pnpm.cjs` внутри `get-source` / `stacktracey` (трейс при попытке `process.cwd()`). Воспроизводимо при каждом launchd-fire. `pnpm` запускается, но крашится в bootstrap-фазе до того как успеет позвать наш скрипт.

2. **macOS TCC блокирует `/bin/sh` от чтения shebang-скрипта в `~/Documents`** при exec из launchd-контекста. `node_modules/.bin/tsx` это `#!/bin/sh`-обёртка; kernel читает shebang → exec'ит `/bin/sh tsx args` → sh ловит `Operation not permitted` при open(tsx). Скомпилированный Mach-O бинарь (например `dist/<helper>`) в том же `~/Documents` запускается **нормально** - TCC блокирует именно interpreter-loading через sh, не exec Mach-O. node, запущенный из вне `~/Documents` (например `~/.nvm/.../bin/node`), читает `.mjs`/`.ts` стандартным file-IO и проходит TCC.

Поэтому node-direct + cli.mjs обходит обе ловушки сразу.

## How to apply

- Любой новый launchd plist для TS-скрипта → бери шаблон из [`src/routines/cron.ts:generateRoutinePlistXml`](../../src/routines/cron.ts). Он уже резолвит `node` и `tsxCli` через [`scripts/install-routines-launchd.ts`](../../scripts/install-routines-launchd.ts) (`resolveTsxCli()` ищет cli.mjs в `node_modules/.pnpm/tsx@*`).
- Если делаешь one-off plist руками (без install-скрипта) — `which node` даст путь, `find node_modules/.pnpm -path '*/tsx/dist/cli.mjs'` даст cli.
- Не ставь `WorkingDirectory` вне репо: scripts/cron-run-routine.ts резолвит модули из cwd.
- Если `.log` пустой а `.err` есть `EINTR uv_cwd` или `Operation not permitted` — это эти же ловушки, не лезь в код routine, чини plist.
- Морнинг-детектив [`infrastructure/launchd/com.ai-cofounder.morning-detective.plist`](../../infrastructure/launchd/com.ai-cofounder.morning-detective.plist) ещё на старом `pnpm tick:cron` шаблоне — если когда-нибудь активируешь, сначала переведи на node-direct.

## Trigger key idempotency

Связанное: [`triggerCronRoutine`](../../src/core/triggers.ts) теперь даёт ключ `routine:<id>:<date>:<HHMM>` (а не только `:<date>`). Раньше несколько cron-слотов в день одной routine коллидировали в `audit.repeat` и фактически отрабатывал только первый. Если добавляешь routine с >1 слотом в день — это сразу работает, дедуп держится в пределах одной минуты одного дня.
