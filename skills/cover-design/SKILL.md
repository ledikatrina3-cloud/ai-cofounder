---
name: cover-design
description: Генерирует обложку для статьи из SVG-шаблона с подстановкой заголовка. Не использует AI-генерацию изображений (это premium вариант). Возвращает .svg (опционально .png если установлен sharp).
version: 1.0.0
category: automation
displayName: Cover Designer
icon: 🎨
color: "#FF00AA"
dependsOn: []
requiresScopes: []
---

# cover-design

## Когда использовать
Когда draft готов и нужна обложка для публикации (vc.ru, Telegram, превью
в SERP). Скилл генерит SVG из библиотеки шаблонов, подставляя title статьи.

НЕ используй для премиум-картинок (DALL-E / Midjourney) — это отдельная
история, для MVP хватает SVG.

## Алгоритм

1. **Выбери template** по типу статьи. Доступные:
   - `gradient` — фиолетовый градиент, центрированный текст. Универсальный.
   - `dark-stripe` — тёмный фон с яркой акцентной полосой. Для tech/serious.
   - `geometric` — геометрический паттерн. Для аналитики / отчётов.
   - `minimal` — чисто-белый, чёрный текст. Для long-read / эссе.
   - `accent` — цветной solid + крупный заголовок. Для манифестов / громких заявлений.
2. **Запусти скрипт:**
   ```
   pnpm exec tsx skills/cover-design/scripts/generate.ts --title "<title>" --template <name> --out <path>
   ```
   Output stdout (последняя строка):
   ```json
   {"status": "ok"|"failed", "svgPath": "...", "pngPath": "..."|null, "errors": []}
   ```
3. **Если sharp установлен** — скрипт автоматически конвертит SVG → PNG (1200×630
   под Open Graph). Иначе только SVG.

## Ограничения

- Title до 80 символов рекомендовано (длиннее — обрезается в layout).
- Кириллица поддерживается, шрифт system-default.
- Файлы для publishers — оба формата если есть (publisher сам выберет
  подходящий под платформу).
