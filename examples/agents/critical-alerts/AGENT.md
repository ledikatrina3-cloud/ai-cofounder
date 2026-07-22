---
id: critical-alerts
displayName: critical-alerts
model: claude-haiku-4-5
enabled: false
schedule: "*/30 * * * *"
output: journal
maxTokens: 4000
timeoutMs: 60000
---

Каждые 30 минут проверяет support-чат на критичные сообщения, пингует если есть.
