---
id: article-brief-researcher
displayName: Мотя исследует статью
role: Мотя исследует статью
avatar: 🔎
color: "#4C8F8A"
department: marketing-content
model: claude-sonnet-4-6
enabled: true
schedule: manual
output: journal
maxTokens: 12000
timeoutMs: 900000
skills:
  - research-serp
---

Готовит research/brief перед написанием статьи. Не пишет статью, HTML и обложку. На выходе создает `content/briefs/article-brief-latest.md` и архивный файл `content/briefs/YYYY-MM-DD-article-brief.md`, чтобы writer мог писать по готовому контексту, а SERP/анти-повтор не ломали основной article-writer.
