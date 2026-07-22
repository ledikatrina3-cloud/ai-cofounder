# Отделы — organizational unit

Отдел — это группа routine-сотрудников с общим бюджетом и pipeline. Лежит в
`departments/<id>/`. Файлы: `DEPARTMENT.md` (паспорт + бюджет) + `pipeline.yml`
(порядок работы сотрудников отдела).

Связано: [[employees]] (кто в отделе), [[cost-model]] (как считается бюджет).

## Активные отделы

### 📝 SEO Department (`marketing-content`)

**Что делает.** 6 платформенных писателей, каждый отвечает за свою площадку:
блог example-project, vc.ru, Дзен, Хабр, Reddit, LinkedIn. Каждый использует skill
`article-writing` (структура, голос) + специфичный skill для публикации
на свою площадку.

**KPI:**
- 1 пост в неделю на каждую активную площадку
- ≥ 100 reads / post на vc.ru
- Стоимость публикации ≤ $1.00

**Бюджет:**
- `perDayUsd: 5.00` — не сжигаем больше за день
- `perRunUsd: 1.00` — один цикл укладывается в $1

**Состояние сейчас.** Активен только Гайд-райтер example-project (см. [[employees]]).
Остальные 5 — placeholders, ждут publishing-skills для своих площадок.

Файлы:
- [`departments/marketing-content/DEPARTMENT.md`](../../departments/marketing-content/DEPARTMENT.md)
- [`departments/marketing-content/pipeline.yml`](../../departments/marketing-content/pipeline.yml)

## Pipeline — порядок работы отдела

`pipeline.yml` описывает граф работы сотрудников. Простейший случай (текущий
marketing-content): 6 независимых нод, каждая делает свой draft параллельно,
финальная нода `approve-publish` ждёт human-gate.

```yaml
nodes:
  - id: example-project
    employee: marketing-content-example-project
    output: content/drafts/example-project/${date}.md
    onFail: { retries: 1, then: continue }
  ...
  - id: approve-publish
    type: human-gate
    via: telegram
    timeout: 12h
    inputs: [example-project, vc, dzen, habr, reddit, linkedin]
```

В будущем — сложные DAG'и (master-draft → 5 platform-rewrites → approve).
Пока упрощённо.

## Бюджет на уровне отдела

Pre-call guard `src/llm/department-budget.ts` агрегирует spend всех routines
с тем же `departmentId`. Если за день перебрали `perDayUsd` — следующий
запуск routine из этого отдела сразу падает с `budget_exceeded`, не
тратя API-вызов.

См. [[cost-model]] для деталей экономики.

## Как добавить новый отдел

1. `departments/<id>/DEPARTMENT.md` — паспорт с budget'ом.
2. `departments/<id>/pipeline.yml` — граф работы.
3. У routines добавить `departmentId: <id>`.

Подробнее: [`plans/`](../../plans/)
(Фаза 5 — departments, budgets, pipelines).
