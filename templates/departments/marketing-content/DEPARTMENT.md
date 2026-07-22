---
name: Marketing Content
description: Отдел маркетинга для контентного pipeline'а — research → outline → approve → draft → SEO/cover → adapt → approve → publish (vc/Дзен/TG) → analytics.
budget:
  perDayUsd: 5.00
  perRunUsd: 1.00
---

# Отдел: Marketing Content

## Что делает
Каждое утро (по cron) запускается pipeline: researcher берёт тему из
`shared/topics-backlog.md`, writer-editor пишет outline, фаундер одобряет
тему, writer-editor пишет draft, SEO-аудитор + cover-дизайнер дополняют,
publisher'ы адаптируют под vc / Дзен / Telegram, фаундер одобряет публикацию,
publisher'ы публикуют параллельно, analytics через 24ч присылает отчёт.

## KPI
- 1 пост на vc.ru + Дзен + Telegram в неделю.
- ≥ 100 reads/post на vc.ru.
- Стоимость публикации ≤ $1.00.

## Бюджет
- `perDayUsd: 5.00` — больше не сжигаем за день (защита от глюка researcher'а).
- `perRunUsd: 1.00` — один цикл pipeline'а укладывается в $1.

## Команда
См. `routines/marketing-content-*.md` (создаются `pnpm dept:instantiate marketing-content`).

## Артефакты
- `outputs/research/${date}.md` — research-pack
- `outputs/outlines/${date}.md` — outline
- `content/drafts/master/${date}.md` — master draft
- `outputs/seo-audits/${date}.json` — SEO-аудит
- `content/drafts/master/${date}-cover.png` — обложка
- `content/drafts/vc/${date}.md` / `dzen/${date}.md` — адаптированные драфты
- `outputs/analytics/${date}.json` — трафик-отчёт
