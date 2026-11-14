---
title: Copy a page for an LLM
navigation.group: Coding agents
description: Copy, view, or open any ViteHub docs page as Markdown in ChatGPT, Claude, or another tool.
navigation.title: Markdown pages
navigation.order: 263
icon: i-vscode-icons-file-type-markdown
---

Every docs page has a raw Markdown version without the site shell. Use it to
give one page to a chat tool or a coding agent.

## Use the page actions

**Copy page** sits next to each page title. Its arrow opens more actions.

| Action | Result |
| --- | --- |
| Copy page | Copies the page Markdown to the clipboard. |
| View as Markdown | Opens the raw page in a new tab. |
| Copy Markdown URL | Copies the raw URL, for example `https://vitehub.dev/raw/docs/kv.md`. |
| Open in ChatGPT | Opens ChatGPT with a prompt that references the raw URL. |
| Open in Claude | Opens Claude with the same prompt. |
| Copy MCP server URL | Copies `https://vitehub.dev/mcp`. |
| Add MCP server to Cursor or VS Code | Opens the editor prompt to install the [docs MCP server](/docs/console/mcp). |

**Open in ChatGPT** and **Open in Claude** start a new chat with this prompt:

```txt [Prompt]
Read https://vitehub.dev/raw/docs/kv.md from the ViteHub documentation. Use it as context to answer my questions and to help me apply it in my project.
```

The chat tool fetches the published page from `vitehub.dev`. On a local or preview copy of the docs, **Copy page** and **View as Markdown** use that copy's raw page.

## Build a raw URL

Add `/raw` before the path and `.md` after it.

| Rendered route | Raw Markdown route |
| --- | --- |
| `/docs` | `/raw/docs.md` |
| `/docs/<section>` | `/raw/docs/<section>.md` |
| `/docs/<section>/<page>` | `/raw/docs/<section>/<page>.md` |

For example, `/docs/getting-started/ai-resources/markdown-pages` becomes `/raw/docs/getting-started/ai-resources/markdown-pages.md`.

Raw pages turn site components into plain Markdown. A callout starts with a quoted label such as `> **Tip**`, a tab label becomes a heading, and an interactive preview becomes a short note that links to the rendered page.

## Give an agent one page

Start with the compact index, pick one raw page, and keep its URL with the context.

```txt [Agent flow]
1. Fetch https://vitehub.dev/llms.txt.
2. Select one raw Markdown URL for the task.
3. Read that page and inspect the installed package contract.
4. Keep the URL in the final implementation report.
```

Add a second page only when the first links to a required concept or reference. Small context makes docs drift easier to find. Pick pages from the links in `https://vitehub.dev/llms.txt`.

## Paste context into another tool

Copy the section with its source URL, so the other tool knows where it came from and can fetch the current page for more context.

```txt [Prompt context]
Source: https://vitehub.dev/raw/docs/agents/instructions.md

<paste the relevant Markdown section>
```

## Read local source

Agents that contribute to this repository can read `docs/content/docs/` directly. When you build your own app, use the public raw URL so the context stays portable.

::note
Raw pages describe the current published docs. If an example disagrees with your installed exports or types, follow the installed package and report the difference.
::
