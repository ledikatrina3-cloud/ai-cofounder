---
name: no-silent-fallback
description: Silent try/catch вокруг финального step'а pipeline — антипаттерн. Если step упал, бросай.
type: feedback
---

Не оборачивать критические step'ы pipeline в `try { ... } catch { use fallback; warn(...) }`
если fallback продуцирует валидный-по-виду, но broken output, который
уходит дальше (в БД, S3, на прод). Бросай ошибку — pipeline падает,
вышестоящий gate видит fail, исправляешь сразу.

**Why:** прецедент — `composeHeadlineOverlay` в hero-pipeline (генерация
обложек) был обёрнут в silent try/catch. Когда sharp/librsvg
не находил Cyrillic-шрифт (в Docker не было `fonts-dejavu`), overlay
выпускал tofu-боксы → catch не срабатывал (sharp не бросал), функция
возвращала «успешный» buffer с tofu-headline. heroImage уходил в S3,
DB обновлялась, контент-routine рапортовал success в Telegram. Фаундер
открыл список гайдов через 2 недели — 12 из 14 последних обложек битые.
Silent fallback превратил «упало сразу» в «тихо сломанные обложки
2 недели в проде».

**How to apply:**
- В pipeline где есть retry-loop, critical step (composition, validation)
  должен быть ВНУТРИ loop'а, не после. Тогда fail триггерит retry с
  refined input, а не hard-stop.
- В pipeline без retry — bare throw, без try/catch. Gate уровнем выше
  ловит и репортит.
- `console.warn(...)` в Docker не виден никому, и никогда не превращается
  в alert. Если хочется warning — пиши в БД (status='warning') или в
  Telegram (заметку фаундеру), не в stdout.
- Code review checklist: при виде `try/catch` вокруг любого step'а,
  отличного от network/IO с явным retry — спроси «что если catch
  сработает? Куда уходит fallback? Есть ли downstream check который
  это поймает?». Если ответ «никто не поймает» — убирай catch.
- Применяется ко ВСЕМУ pipeline-коду: cover-gen, vc-publish, контент-runner,
  обработка LLM-ответов с structured output.
