---
name: browser-control
description: Базовые примитивы управления браузером (persistent profiles + patchright session). Используется как dependency для publishing-скиллов (vc-publishing, dzen-publishing, etc.). Сам по себе не вызывается — это internal-модуль.
version: 1.0.0
category: internal
displayName: Browser Control
icon: 🌐
---

# browser-control

## Prerequisite
This skill uses patchright (a Playwright fork) and needs a Chromium binary that
`pnpm install` does NOT fetch. Before using it once, run:

```
pnpm exec patchright install chromium
```

Otherwise patchright fails with "Executable doesn't exist". The default
article-writer path does NOT need this - it is only for the opt-in
browser / vc.ru publishing path.

## Назначение
Низкоуровневые примитивы из `src/browser/`:
- `resolveProfile(platform, account)` — резолвит directory persistent profile
  (хранится в `~/Library/Application Support/AI-Cofounder/profiles/` на macOS).
- `openSession(...)` — открывает patchright-сессию с этим профилем.

Этот скилл — **dependency** для publishing-скиллов. Когда vc-publishing
запускает свой скрипт, он использует `openSession` внутри. Тебе как
агенту не нужно вызывать browser-control напрямую — он невидим в
сценариях верхнего уровня.

## Health-check
`scripts/healthcheck.ts` — простой smoke-test: проверяет что директория
профилей резолвится корректно (это разворачивается в реальный
DOM-check для каждого platform-скилла в Фазе 7 плана).
