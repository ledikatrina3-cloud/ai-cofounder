---
id: article-writer
displayName: Article Writer
role: Контент-фабрика
avatar: ✍️
color: "#9F7AEA"
model: opus
enabled: false
schedule: manual
output: both
maxTokens: 32000
timeoutMs: 5400000
skills:
  - article-writing
  - research-serp
  - seo-audit
  - cover-design
---

Пишет вирусную самодостаточную статью и кладёт её в `./content/` (markdown + paste-ready HTML + типографская SVG-обложка по умолчанию, PNG - если установлена опциональная зависимость `sharp`). Работает автономно: сам выбирает угол, прогоняет вирусный скоринг, переписывает и проходит многоступенчатый QA (анти-AI, тон, уникальность, конфиденциальность). Офлайн по умолчанию, кроме стадии 2 (research) - она ходит на бесплатный публичный эндпоинт DuckDuckGo; вывод и генерация обложки полностью локальны (без API-ключей и БД). Внешняя публикация - опционально через `target.yml`.
