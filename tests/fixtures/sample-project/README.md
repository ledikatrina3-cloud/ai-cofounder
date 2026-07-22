# sample-project

Mini-проект для тестов фазы 2.3a (`tests/investigate-run.test.ts`).
Симулирует репозиторий «Acme Academy» с заведомо известным багом в `src/payment.ts`
(try/catch проглатывает ошибку оплаты — клиент не видит проблемы, платёж не
проходит) и чистым `src/login.ts`.

Тест в setUp копирует эту папку в tempdir и делает `git init` + одиночный
коммит — не вкладывая `.git/` в репозиторий AI-Cofounder.
