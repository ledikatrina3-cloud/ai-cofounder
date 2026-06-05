---
name: build-before-push
description: `pnpm build` перед `git push`. Не `tsc`, не `vite build` отдельно — полный `build` с biome и prisma.
type: feedback
---

Перед каждым `git push` запустить `pnpm build` локально и убедиться
что вышло чисто. Не достаточно `tsc --noEmit` — biome тоже валит build.

**Why:** `pnpm build` запускает связку: prisma generate → tsc →
biome check → vite build (frontend). Любой из шагов может упасть.
Самый частый источник провалов — biome formatter (не функциональный
linter, а форматтер): он считает длинные template strings или особый
стиль скобок ошибкой и валит build, хотя `tsc` пройдёт.

Push без локального build = поиметь упавший CI и потом разгребать
через 5 минут на чужом железе. Локально починка 30 секунд.

**How to apply:**
- В CLI workflow перед каждым `git push`: `pnpm build` → если ok →
  push. Если упало — fix → build retry → push.
- Если build падает из-за biome — `pnpm exec biome check --write <files>`
  обычно решает (auto-fix).
- Если есть pre-push hook через lefthook — он автоматизирует, но не
  заменяет локальную проверку (hook может быть отключён).
