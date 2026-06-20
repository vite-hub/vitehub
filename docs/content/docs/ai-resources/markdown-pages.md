---
title: Markdown pages
description: Treat docs Markdown files as the canonical page source for AI-readable ViteHub documentation.
navigation.order: 61
icon: i-vscode-icons-file-type-markdown
---

Markdown pages are the canonical source for ViteHub documentation content.
The docs app renders them into public routes, while agents can inspect the source files directly in a local checkout.

## Source layout

| Source path | Public route pattern | Notes |
| --- | --- | --- |
| `docs/content/docs/index.md` | `/docs` | Root docs page. |
| `docs/content/docs/<section>/index.md` | `/docs/<section>` | Section landing page or first page. |
| `docs/content/docs/<section>/<page>.md` | `/docs/<section>/<page>` | Normal page route. |
| `docs/content/docs/<section>/.navigation.yml` | Sidebar metadata | Section title, icon, and order. |

## Authoring rules

Markdown pages should define the subject in the first sentence and keep examples small.
Use complete sentences, active voice, present tense, and file-labeled code blocks.

```md [docs/content/docs/development/generated-files.md]
# Generated files

Generated files prove how ViteHub resolved Definitions, Runtime Registries, stable imports, and Provider Output.
Application code should use Stable ViteHub Import Paths instead of importing generated files directly.
```

## Public raw Markdown

Raw public per-page Markdown routes are planned.
Until that exists, the local source tree remains the reliable Markdown source for agents working inside the repository.

| Feature | Status |
| --- | --- |
| Local Markdown source | Available |
| Rendered docs routes | Available |
| Raw Markdown route per docs page | Planned |
| Markdown manifest with page metadata | Partially available through generated docs artifacts |

## Next steps

- Use [llms.txt](/docs/ai-resources) for the page index.
- Use [File conventions](/docs/reference/file-conventions) for source layout rules.
- Use [MCP docs server](/docs/ai-resources/mcp-docs-server) for the planned remote access path.
