---
id: example-noop
displayName: example-noop
model: haiku
enabled: true
schedule: manual
output: journal
maxTokens: 1000
timeoutMs: 60000
---

Health-check агент: самый маленький рабочий агент в комплекте. Ничего не
анализирует и никуда не ходит - только подтверждает, что движок может загрузить
папку, запустить агента и записать результат в журнал. Нулевые tools (нет
permissions.yml - silence = safe), не требует Telegram и внешних/проектных
данных. Делает один минимальный LLM-вызов (нужен настроенный транспорт -
`ANTHROPIC_API_KEY` для apikey-режима) и пишет audit-запись в локальную dev-БД
(нужен прогнанный `pnpm db:migrate`). Это единственный пример, который ships
`enabled: true` - намеренно, чтобы `pnpm dev:run example-noop` реально
прогонялся как smoke свежего форка. Безопасно: `schedule: manual` означает, что
сам он не запускается по расписанию (никакого launchd-плиста), только по ручному
вызову.
