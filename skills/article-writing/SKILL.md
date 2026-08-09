---
name: article-writing
description: Пишет длинную статью по текущему контракту AI-Cofounder: brief -> draft -> HTML/cover -> deterministic QA artifacts. Не выбирает тему вместо researcher и не публикует во внешний мир без отдельного target.
version: 1.1.0
category: writing
displayName: Article Writer
icon: "✍️"
color: "#9F7AEA"
dependsOn: []
requiresScopes: []
---

# article-writing

Этот skill - тонкая точка входа к рабочему writer contract. Source of truth:

- runtime prompt: `agents/article-writer/prompt.md`
- tracked template: `examples/agents/article-writer/prompt.md`
- `agents/article-writer/rules.md`
- `article-writer-prompt.md` как root-копия для тестов и ручного аудита

Не используй старый outline-only workflow. Полная логика статьи живёт в prompt:
brief, бизнесовый вход, анти-повтор, SERP hard-gate, viral scoring,
humanization loop, cover, HTML и Telegram artifacts contract.

## Когда использовать

Используй, когда есть подтверждённый brief от `article-brief-researcher` или
явно заданная тема в `topics/article-writer-next.md`. Если
`content/briefs/article-brief-latest.md` существует и имеет
`Status: needs_human_review`, статья не пишется до человеческого подтверждения.

## Обязательный контракт

1. Сначала прочитай `agents/article-writer/prompt.md` полностью.
2. До драфта создай `content/<slug>.checklist.md`; каждый `[x]` закрывается
   только реальным файлом, JSON-вердиктом или проверяемой строкой в драфте.
3. Не подменяй публичный бизнес статьями про внутренний AI-Cofounder, если тема
   явно не про него.
4. Используй `mastery/INDEX.md` и минимум один релевантный файл mastery под тему.
5. Не закрывай SERP, если результат пустой или слабый: следуй fallback-запросам
   из `agents/article-writer/prompt.md`.
6. Не добавляй числа, скриншоты, "мемные" фразы или пафос только ради viral gate.
7. Перед финалом создай реальные QA artifacts:

```bash
python3 tools/article-writing/ai-cadence-check.py content/<slug>.md --json > content/<slug>.qa/ai-cadence.json
python3 tools/article-writing/read-aloud-check.py content/<slug>.md --json > content/<slug>.qa/read-aloud.json
python3 tools/article-writing/structure-check.py content/<slug>.md > content/<slug>.qa/structure.txt
node scripts/article-diversity-check.mjs content/<slug>.md --content-dir content --recent 5 --json > content/<slug>.diversity.json
node scripts/article-business-readability-check.mjs content/<slug>.md --json > content/<slug>.business-readability.json
```

Пустой `humanization.json` без этих файлов не считается проверкой. Если
`read-aloud` вернул `REVIEW`, исправь флаги или явно перечисли оставленные
исключения с причиной в `content/<slug>.qa/humanization.json`.

## Стоп-условия

- brief требует `needs_human_review`;
- SERP не дал минимум релевантных источников после fallback-запросов;
- чек-лист имеет незакрытые `[ ]`;
- `ai-cadence`, `structure`, `diversity`, `business-readability`,
  confidentiality или форматный gate не прошёл.

## Mastery, редактура и публикации

- До первого полного драфта открыть `mastery/INDEX.md`,
  `mastery/copywriting/INDEX.md`, `mastery/copywriting/igor-ledohovsky.md` и
  минимум один профильный mastery-файл по теме. По Ледоховскому выбрать задачу
  влияния, метафору аудитории и конструкцию истории без выдуманного кейса.
  В research записать точные пути, применённые методы и место их применения.
- После драфта открыть `mastery/redaktor/INDEX.md` и минимум один рекомендованный
  им файл. В QA записать точные пути, применённые методы, изменения и повторную
  сверку с голосом Екатерины.
- Перед внутренней ссылкой прочитать `content/published-articles.json`. Ссылка
  допустима только при `status: published` и явном публичном URL `https://...`.
  `status: ready` не означает `published`; URL по slug или имени файла не угадывать.
- Если подтверждённого URL нет, прошлую статью не упоминать как опубликованную и
  ссылку не добавлять.
- В публичные Markdown/HTML запрещено добавлять `## Источники`. Evidence хранится
  только в research и QA.
