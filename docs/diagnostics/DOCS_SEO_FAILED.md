---
description: "Fix DOCS_SEO_FAILED in @vite-hub/docs. A prerendered page fails a search check, such as its title length or a sitemap redirect."
seo.title: "DOCS_SEO_FAILED: docs pages fail the search checks"
---

A prerendered page fails a search check. A production build logs it by default and stops on it when `seoAudit` is `"error"` or `true`. The limits are those of common site audits: a title of 10 to 60 characters with the site name, a description of 70 to 160, one `h1`, headings that go down one level at a time, at least 150 words, and a link from another page. Each sitemap URL must be a prerendered page that does not redirect. The message lists each page with its fix:

```txt [output/docs-seo-error.txt]
Docs pages fail the search checks:
- /guides is in the sitemap, but it redirects. List the page that it redirects to instead.
- /docs/kv/hosts has a description of 41 characters. Keep it between 70 and 160.
- /docs/mcp, /docs/agents/mcp share the title "MCP · Lumen". Give each page its own.
```

## Why it happens

Search engines and site audits flag these pages. A sitemap URL that redirects or a missing title is an error to them, and shared or cut titles make results hard to tell apart.

## Fix it

Set `seo.title` or `seo.description` in the frontmatter to change what search engines show and keep the heading. Pages with `noindex` or a canonical link to another page are left out.
