# Где мы сейчас — стадия проекта

Снэпшот по состоянию **2026-05-22**. Обновлять после каждого крупного релиза
или закрытия milestone'а.

Связано: [[../products/capabilities]] (что инфраструктурно работает),
[[mission]] (куда идём долгосрочно).

## Milestone-карта

| # | Milestone | Дата | Статус |
|---|---|---|---|
| **M1** | Фундамент: routine-движок + dispatcher + audit + Telegram + launchd | апр 2026 | ✅ закрыт |
| **M2** | Утренний детектив: SQL-обзор БД + sub-agent + утренний отчёт | начало мая 2026 | ✅ закрыт (~80%) |
| **M3** | Pivot: AI-кофаундер с routines (вместо «утреннего детектива») | май 2026 | 🟡 в работе |
| ↳ M3.1 | Skills-архитектура v3 (Anthropic-compat, discovery layer, deps) | 2026-05-21 | ✅ Фаза 0-8 закрыты |
| ↳ M3.2 | Departments + budgets + pipelines | 2026-05-21 | ✅ marketing-content |
| ↳ M3.3 | Cross-project runner (`targetProject`) | 2026-05-22 | ✅ Гайд-райтер запущен, гайд опубликован в example-project |
| ↳ M3.4 | Office UI: countdown, progress bar, documents pile, live activity | 2026-05-22 | ✅ |
| ↳ M3.5 | Org-knowledge layer (ai-clone + business) | 2026-05-22 | 🟡 в работе (этот документ) |
| **M4** | Полный SEO-отдел (6 платформенных писателей × publishing skills) | июнь 2026 | ⏳ ожидание |
| **M5** | Open-source готовность | июль-август 2026 | ⏳ план есть, см. [`plans/`](../../plans/) §8 |

## Что работает прямо сейчас (на 2026-05-22)

**Активные routines** (по cron'у, без участия фаундера):
- Гайд-райтер example-project - публикация гайдов в блог (например, первый:
  «Как запустить первый онлайн-курс за выходные»).
- Финансовый аналитик — выручка вчера, утром.
- Critical-alerts — support-чат каждые 30 мин.
- Support-triage / DB morning triage / Weekly metrics.
- Маркетолог vc.ru — публикует ready-черновики.

**Боевой первый успех:** гайд опубликован на проде
(`https://acme.example.com/guides/kak-zapustit-pervyy-onlayn-kurs`).
Прогон уложился в один цикл, ~25 минут. См. ретроспективы в репозитории
example-project.

## Над чем работаем (active focus)

1. **Org-knowledge layer** (этот документ + соседи в `org/` и `ai-clone/`) —
   накатить методологию Второго мозга на репо AI-кофаундера.
2. **Office UI расширения** — анимации работы, бумаги, прогресс, walking.
   Большая часть уже есть, дошлифовать.
3. **Второй прогон Гайд-райтера** - пилот на 22:00 несколько раз, потом
   перевести на `0 7 * * 2,5` (вт+пт утром).

## Что отложено (известный backlog)

- **Полный SEO-отдел.** 5 placeholder-routines (vc/habr/dzen/reddit/linkedin)
  ждут публикационные skills в example-project. Делать по очереди после первой
  успешной серии блог-гайдов.
- **Автолинковка концептов в CMS example-project.** Этап кросс-линковки
  делается руками - нужен cron-endpoint в CMS проекта.
- **Email-канал.** Категория `communication` объявлена, реализации нет.
- **Recovery после crash.** 90-мин workflow без checkpoint'ов. Temporal-runner
  как escape-hatch если failure rate >5%.
- **`.claude/settings.json`** для hard-security gate (не CLAUDE.md). См.
  [[../../CLAUDE]] §12 — пункт чек-листа провален.

## Стадия = «один-пользовательский MVP с прод-боевыми routine'ами»

Не альфа (есть прод-публикации), не бета (нет другого пользователя кроме
фаундера). Промежуточная — рабочая система, проверенная на одном бизнесе
(example-project). Следующий шаг — стабилизация + второй downstream-проект.

## Pivot-история

| Дата | Был фокус | Стал фокус | Причина |
|---|---|---|---|
| 2026-04-30 | «Утренний детектив» — single routine, sub-agent для DB | — | Стартовый scope |
| 2026-05-01 | — | «AI-кофаундер с N routines» | M2 показал что одна routine = детектив. Нужен набор сотрудников. |
| 2026-05-21 | Inline routine prompts | Skills-архитектура v3 | Промты дублировались между routines. Skill = разделяемая единица работы. |
| 2026-05-22 | Routines работают только в HQ | Cross-project (`targetProject`) | Skill `build-guide` живёт в example-project; HQ должен уметь спавнить там. |

## Известные риски

См. текущие планы для развёрнутых рисков. Главные
эксплуатационные:

1. **Markdown parse-failures Telegram** — теперь fallback на plain (закрыто
   2026-05-22). См. [[../../ai-clone/feedback/telegram-plain-fallback]].
2. **Mac asleep во время cron-tick** — launchd не разбудит. Митигация:
   ставим long-running на 22:00 когда заведомо awake. `pmset wake` —
   опция для 7-утренних запусков.
3. **API-ключ протух / превышен лимит** - нужен pre-call health-check перед
   спавном unattended-прогона. В TODO для Фазы 4 cross-project-runner.
