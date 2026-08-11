---
name: article-writing
description: Превращает подтвержденный brief в статью сайта с HTML, обложкой и проверяемыми QA-артефактами.
version: 2.0.0
category: writing
displayName: Article Writer
icon: "✍️"
color: "#9F7AEA"
dependsOn: []
requiresScopes: []
---

# article-writing

Точка запуска рабочего writer contract. Оркестрация находится в
`agents/article-writer/prompt.md`, жесткие ограничения - в
`agents/article-writer/rules.md`, редакционная политика - в
`org/article-editorial-playbook.md`.

## Когда запускать

Запускай при подтвержденном `content/briefs/article-brief-latest.md` или явной
теме в `topics/article-writer-next.md`. `needs_human_review` останавливает run до
подтверждения. Skill не выбирает тему вместо researcher и не публикует наружу.

## Порядок

1. Прочитай runtime prompt и выполни стадии сверху вниз.
2. Создай `content/<slug>.checklist.md` и
   `content/<slug>.editorial-context.json` до полного черновика.
3. Сформируй и проверь editorial context командой
   `scripts/article-editorial-context.mjs`, включая `--validate-evidence`.
4. Создай Markdown, HTML, обложку и все QA-файлы, перечисленные в prompt.
5. Не закрывай run при ненулевом validator, незакрытом checklist или отсутствующем
   артефакте.

Этот skill не пересказывает редакционные правила. При расхождении всегда
действуют runtime prompt, rules и canonical playbook в их собственных областях.
