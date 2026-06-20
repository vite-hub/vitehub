---
title: Raw Markdown pages
description: Use public raw Markdown routes for page-level AI-readable ViteHub documentation.
navigation.order: 61
icon: i-vscode-icons-file-type-markdown
---

Raw Markdown pages expose ViteHub docs content without the rendered docs shell.
Use them when an AI tool or coding agent needs copyable page content with a stable URL.

## Route patterns

| Rendered route | Raw Markdown route |
| --- | --- |
| `/docs` | `/raw/docs.md` |
| `/docs/<section>` | `/raw/docs/<section>.md` |
| `/docs/<section>/<page>` | `/raw/docs/<section>/<page>.md` |

For example, the rendered page `/docs/ai-resources/markdown-pages` is available as `/raw/docs/ai-resources/markdown-pages.md`.

## Local source layout

Agents working inside this repository can inspect the authoring files directly.

| Source path | Purpose |
| --- | --- |
| `docs/content/docs/index.md` | Root docs page. |
| `docs/content/docs/<section>/index.md` | Section landing page. |
| `docs/content/docs/<section>/<page>.md` | Normal page source. |
| `docs/content/docs/<section>/.navigation.yml` | Sidebar metadata. |

## Authoring rules

Markdown pages should define the subject in the first sentence and keep examples small.
Use complete sentences, active voice, present tense, and file-labeled code blocks.

```md [docs/content/docs/development/generated-files.md]
# Generated files

Generated files prove how ViteHub resolved Definitions, Runtime Registries, stable imports, and Provider Output.
Application code should use Stable ViteHub Import Paths instead of importing generated files directly.
```

## Public raw Markdown

Public raw Markdown routes are available for each docs page.
Use local source files when you are editing the repo; use raw routes when you are feeding published docs to an external tool.

| Feature | Status |
| --- | --- |
| Local Markdown source | Available |
| Rendered docs routes | Available |
| Raw Markdown route per docs page | Available |
| Markdown manifest with page metadata | Partially available through generated docs artifacts |

## Copy and paste usage

When sharing docs context with an AI tool, paste the smallest relevant section and include the raw URL above it.
For repo-local work, include the local source path instead.

```txt [External AI context]
Source: https://vitehub.dev/raw/docs/ai-resources/markdown-pages.md

<paste the relevant Markdown section>
```

## Next steps

- Use [llms.txt](/docs/ai-resources) for the page index.
- Use [File conventions](/docs/reference/file-conventions) for source layout rules.
- Use [MCP docs server](/docs/ai-resources/mcp-docs-server) for the planned remote access path.
