---
title: Raw Markdown pages
description: Load one canonical ViteHub documentation page as clean Markdown.
navigation.order: 61
icon: i-vscode-icons-file-type-markdown
---

Raw Markdown pages expose canonical ViteHub content without the rendered site shell.
Use them after `llms.txt` identifies the smallest page that answers the current task.

## Route patterns

| Rendered route | Raw Markdown route |
| --- | --- |
| `/docs` | `/raw/docs.md` |
| `/docs/<section>` | `/raw/docs/<section>.md` |
| `/docs/<section>/<page>` | `/raw/docs/<section>/<page>.md` |

For example, the rendered page `/docs/ai-resources/markdown-pages` is available as `/raw/docs/ai-resources/markdown-pages.md`.

## Give an agent one page

Start with the compact index, select one raw page, and preserve its URL with the supplied context.

```txt [Agent flow]
1. Fetch https://vitehub.dev/llms.txt.
2. Select one raw Markdown URL for the task.
3. Read that page and inspect the installed package contract.
4. Keep the URL in the final implementation report.
```

Add a second page only when the first page links to a required concept or reference.
This keeps task context focused and makes documentation drift easier to identify.

## Copy context into another tool

Copy the relevant section with its source URL.
The receiving tool can then preserve provenance and fetch current context when needed.

```txt [Prompt context]
Source: https://vitehub.dev/raw/docs/agents/instructions.md

<paste the relevant Markdown section>
```

## Inspect local source

Agents contributing to this repository can inspect `docs/content/docs/` directly.
Use the public raw URL when building an external application so the context remains portable.

::important
Raw pages describe the current published documentation. If their examples disagree with an application's installed exports or types, use the installed contract and report the mismatch.
::

## Choose another format

Use [AI-readable documentation](/docs/ai-resources) to choose between the public skill, `llms.txt`, `llms-full.txt`, raw Markdown, and rendered pages.
