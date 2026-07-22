---
name: seo-audit
description: Аудит markdown-draft по SEO-правилам (H1, H2, lead-длина, internal links, title/meta). Возвращает JSON со списком issues и score 0-100. Не правит draft — предлагает правки текстом.
version: 1.0.0
category: analysis
displayName: SEO Auditor
icon: 📊
color: "#FFAA00"
dependsOn: []
requiresScopes: []
---

# seo-audit

## Когда использовать
После того, как writer сдал master-draft, и до публикации. Скилл прогонит
структурные SEO-проверки и вернёт список issues. Дешёвый (Haiku), быстрый —
запускать на каждый draft.

НЕ используй для семантического review (это writer-editor / fact-checker).

## Алгоритм

1. **Запусти скрипт:**
   ```
   pnpm exec tsx skills/seo-audit/scripts/audit.ts <draft-path>
   ```
   Скрипт парсит markdown, проверяет правила, возвращает JSON:
   ```json
   {
     "path": "...",
     "issues": [
       {"severity": "error"|"warning"|"info", "rule": "h1-count", "message": "..."},
       ...
     ],
     "score": 0-100
   }
   ```
2. **Интерпретируй issues:**
   - `severity: error` — обязательно к исправлению.
   - `severity: warning` — желательно.
   - `severity: info` — заметки, можно игнорировать.
3. **Сформируй отчёт** в output путь (markdown):
   ```markdown
   # SEO audit: <path>
   Дата: YYYY-MM-DD
   Score: <N>/100

   ## Errors
   - rule: message → предлагаемое исправление
   ...

   ## Warnings
   ...

   ## Approve / reject
   - approve если score ≥ 70 и errors нет
   - reject если errors > 0 → writer'у нужно вернуться к draft
   ```

## Правила (что проверяет скрипт)

- ровно один H1
- минимум 2 H2
- lead (первый абзац) длина 100–250 символов
- наличие хотя бы одной internal-ссылки
- title (frontmatter) длиной 40–70 символов
- meta description (frontmatter, если задан) длиной 140–160 символов
