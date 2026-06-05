---
name: vc-publishing
description: Публикация готового черновика (status=ready) на vc.ru через persistent-сессию браузера. Принимает путь к draft-файлу, заполняет редактор и публикует. Не редактирует draft, не выбирает темы.
version: 1.0.0
category: publishing
displayName: vc.ru Publisher
icon: 📝
color: "#FF8800"
dependsOn: [browser-control]
requiresScopes: [vc.publish]
---

# vc-publishing

## Назначение
Ты публикуешь готовый draft на vc.ru. Драфт лежит в `content/drafts/vc/<filename>.md`
со статусом `status: ready` во frontmatter. Логика публикации (browser-сессия,
заполнение редактора, клик «Опубликовать») инкапсулирована в скрипте
`scripts/publish.ts` — ты его дёргаешь, парсишь JSON из stdout и отчитываешься.

## Алгоритм

1. Получи путь к draft-файлу из контекста (routine передаёт его, либо ты
   сам ищешь самый старый `status: ready` в `content/drafts/vc/`).
2. Запусти команду:
   ```
   pnpm exec tsx skills/vc-publishing/scripts/publish.ts <draft-path> --yes
   ```
   Флаг `--yes` обязателен — без него скрипт ждёт stdin-confirm, которого
   у тебя нет.
3. Распарси последнюю строку stdout как JSON:
   ```json
   {"status": "ok"|"failed", "url": "...", "draftPath": "...", "errors": []}
   ```
4. Сформируй отчёт фаундеру:
   - ok + url → «✅ Опубликовано: <url>»
   - ok без url → «⚠ Без URL (возможно модерация vc.ru)»
   - failed → «❌ Не получилось: <errors[0]>»

## Что не делать
- Не редактируй draft-файл (нет прав, не твоя работа).
- Не публикуй один draft дважды в один день.
- Не выдумывай URL — если в JSON `url=null`, так и пиши.
