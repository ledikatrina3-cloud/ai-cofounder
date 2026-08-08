# Writer mastery and publication contract

## Problem

The writer currently uses topical mastery, but does not prove that `mastery/redaktor` was applied after the draft. It may also treat a local `status: ready` article as published and invent a relative link. Public drafts may contain a service section named `Источники`.

## Approved design

1. Before drafting, the writer reads `mastery/INDEX.md` and at least one topical mastery file. The research artifact records exact paths and applied methods.
2. After drafting, the writer reads `mastery/redaktor/INDEX.md` and at least one file it routes to. The QA artifact records exact paths, applied edits, and a second voice check.
3. The website blog is the canonical publication source. Social adaptations are made later from the published website article.
4. A local writer artifact with `status: ready` is not published. Internal links are allowed only when a publication registry entry has `status: published` and an explicit public URL.
5. If no verified publication URL exists, the writer neither mentions the previous article as published nor inserts a link.
6. Research evidence stays in staff-only `.research.md` and QA files. The public Markdown and HTML must not contain an `Источники` section.

## Data contract

The registry is `content/published-articles.json`:

```json
{
  "articles": [
    {
      "slug": "example-slug",
      "title": "Example title",
      "status": "published",
      "publishedAt": "YYYY-MM-DD",
      "url": "https://site.example/blog/example-slug/"
    }
  ]
}
```

Until the site publishes its first article, the registry contains an empty `articles` array and the writer produces no internal article links.

## Verification

- Contract tests assert the prompt and skill require topical mastery and redaktor evidence.
- Contract tests assert only registry-backed `published` URLs may be linked.
- Content checks reject `## Источники` in public Markdown.
- The latest Markdown and HTML are corrected without changing staff-only research evidence.

