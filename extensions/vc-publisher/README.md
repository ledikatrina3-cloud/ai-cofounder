# vc.ru Publisher Extension

> ВНИМАНИЕ: автоматизирует НЕОФИЦИАЛЬНЫЙ (reverse-engineered) API сторонней
> площадки (vc.ru/Osnova). Может нарушать её Условия использования. Пример для
> справки, НЕ endorsed; используешь на свой риск.

Chrome Extension MV3 для автономной публикации статей на vc.ru через native
Editor.js API. Работает внутри твоего реального Chrome и использует его обычную
сессию (session cookies), как и при ручной публикации.

## Архитектура

```
AI-Cofounder routine  Bridge HTTP                Chrome Extension          vc.ru
                     localhost:7777
  ┌────────┐   POST   ┌────────────┐   GET    ┌──────────────────┐
  │ enqueue├─────────►│  queue     │◄─────────┤  background.js   │
  └────────┘ /enqueue └────────────┘ /next    │  (alarms 30s)    │
                                              └────────┬─────────┘
                                                       │ chrome.tabs
                                                       ▼
                                              ┌──────────────────┐
                                              │ content-bridge   │ (ISOLATED)
                                              └────────┬─────────┘
                                                       │ window.postMessage
                                                       ▼
                                              ┌──────────────────┐
                                              │ content-main     │ (MAIN world)
                                              │ - editor.blocks  │ ◄── vc.ru DOM
                                              │   .render()      │     Editor.js
                                              │ - cover drop     │
                                              │ - publish click  │
                                              └──────────────────┘
```

## Загрузка extension

1. Открой `chrome://extensions/`
2. Включи Developer mode (правый верхний угол)
3. Load unpacked → выбери папку `${PROJECTS_ROOT}/ai-cofounder/extensions/vc-publisher/`
4. Расширение появится в списке. Pin его (нажми иконку pin в Chrome).

## First-time setup

1. Залогинься на vc.ru в этом Chrome (если ещё нет): https://vc.ru/auth
2. Запусти bridge: `cd ${PROJECTS_ROOT}/ai-cofounder && pnpm tsx scripts/vc-publish-server.ts`
3. Открой popup extension → нажми "Проверить bridge". Должно показать `✓ bridge`.

## Тест публикации

```bash
cd ${PROJECTS_ROOT}/ai-cofounder
# Запусти bridge в одном терминале:
pnpm tsx scripts/vc-publish-server.ts

# В другом терминале - публикуй draft:
pnpm tsx scripts/vc-publish-cli.ts <path-to-your-draft.md>
```

Затем открой popup extension → "Опубликовать следующее". CLI будет polling
результат каждые 5 сек и распечатает URL когда extension вернёт.

Или включи "Авто-polling" в popup - extension будет сам polling каждые 30 сек.

## Debug

- Background console: `chrome://extensions/` → "vc.ru Publisher" → "service worker" link → DevTools.
- Content-script console: на vc.ru странице открой DevTools → Console (там
  логи `[vc-publisher:bridge]` и `[vc-publisher:main]`).
- Editor.js instance в DevTools: `window.__vcPublisherEditor`.

## Probe Editor.js (если не находится)

Открой vc.ru/?modal=editor в Chrome. В DevTools Console выполни:

```javascript
// Шаг 1: проверить есть ли уже привязка extension'а.
window.__vcPublisherEditor

// Шаг 2: если null - запустить probe вручную.
const el = document.querySelector('.editor-tool-input[contenteditable="true"]');
const fiberKey = Object.keys(el).find(k => k.startsWith('__reactFiber'));
let fiber = el[fiberKey];
let depth = 0;
while (fiber && depth < 50) {
  if (fiber.stateNode?.blocks?.insert) { console.log('FOUND at depth', depth, fiber.stateNode); break; }
  fiber = fiber.return;
  depth++;
}

// Шаг 3: protect-test - вставить блок и проверить formatting.
window.__vcPublisherEditor.blocks.insert('paragraph', { text: 'тест <b>жирный</b> и <code>код</code>' });
```

## Структура файлов

```
extensions/vc-publisher/
├── manifest.json         ← MV3 манифест
├── background.js         ← service worker (alarms + tab orchestration)
├── content-bridge.js     ← ISOLATED world, мост chrome.runtime <-> page
├── content-main.js       ← MAIN world, Editor.js access + publish flow
├── popup.html            ← UI
├── popup.js              ← popup logic
└── README.md             ← это
```

## Что делать если что-то не работает

1. **"bridge unreachable"** → проверь что `scripts/vc-publish-server.ts`
   запущен и слушает 7777.
2. **"editor.js instance not found"** → ручной probe (см. выше), возможно
   vc.ru изменили React fiber-keys. Опиши в `experiments/vc-ru/attempts/`.
3. **"publish button not found"** → vc.ru изменили DOM. Селектор:
   `button.button--type-primary.button--rounded` с текстом «Опубликовать».
4. **"publish redirect timeout"** → composer открыт, но не редиректит. Скорее
   всего vc.ru не приняли публикацию (модерация / нет cover / нет category).
   Посмотри на саму страницу - там может быть error toast.

## Безопасность

- Bridge слушает только `127.0.0.1:7777` (не наружу).
- Manifest позволяет host_permissions только `vc.ru` + `localhost:7777`.
- Без secrets - extension использует session cookies твоего Chrome (как и
  обычный пользователь).
