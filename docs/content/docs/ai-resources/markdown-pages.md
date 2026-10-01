---
title: Copy a page for an LLM
description: Copy, view, or open any ViteHub docs page as Markdown in ChatGPT, Claude, or another tool.
navigation.title: Markdown pages
navigation.order: 63
icon: i-vscode-icons-file-type-markdown
---

Every ViteHub docs page has a raw Markdown version without the site shell.
Use it when you give one page to a chat tool or a coding agent.

## Use the page actions

Each docs page shows **Copy page** next to its title. The arrow beside it opens more actions.

| Action | Result |
| --- | --- |
| Copy page | Copies the Markdown of the page to the clipboard. |
| View as Markdown | Opens the raw Markdown page in a new tab. |
| Copy Markdown URL | Copies the raw URL, for example `https://vitehub.dev/raw/docs/server-primitives/kv.md`. |
| Open in ChatGPT | Opens ChatGPT with a prompt that references the raw URL. |
| Open in Claude | Opens Claude with the same prompt. |
| Copy MCP server URL | Copies `https://vitehub.dev/mcp`. |
| Add MCP server to Cursor or VS Code | Opens the editor prompt that installs the [docs MCP server](/docs/ai-resources/mcp-server). |

**Open in ChatGPT** and **Open in Claude** start a new chat with this prompt:

```txt [Prompt]
Read https://vitehub.dev/raw/docs/server-primitives/kv.md from the ViteHub documentation. Use it as context to answer my questions and to help me apply it in my project.
```

The chat tool fetches the published page from `vitehub.dev`. On a local or preview copy of the docs, **Copy page** and **View as Markdown** use the raw page of that copy.

## Build a raw URL

Add `/raw` before the path and `.md` after it.

| Rendered route | Raw Markdown route |
| --- | --- |
| `/docs` | `/raw/docs.md` |
| `/docs/<section>` | `/raw/docs/<section>.md` |
| `/docs/<section>/<page>` | `/raw/docs/<section>/<page>.md` |

For example, the rendered page `/docs/ai-resources/markdown-pages` is available as `/raw/docs/ai-resources/markdown-pages.md`.

Raw pages keep the Markdown content and change site components into plain Markdown.
A callout starts with a quoted label such as `> **Tip**`, a tab label becomes a heading, and an interactive preview becomes a short note that points to the rendered page.

## Give an agent one page

Start with the compact index, select one raw page, and keep its URL with the supplied context.

```txt [Agent flow]
1. Fetch https://vitehub.dev/llms.txt.
2. Select one raw Markdown URL for the task.
3. Read that page and inspect the installed package contract.
4. Keep the URL in the final implementation report.
```

Add a second page only when the first page links to a required concept or reference.
This keeps the task context small and makes documentation drift easier to find.
For a smaller index, use `https://vitehub.dev/llms/agents.txt` or `https://vitehub.dev/llms/server-primitives.txt`.

## Paste context into another tool

Copy the relevant section with its source URL.
The receiving tool can then keep the provenance and fetch the current page when it needs more context.

```txt [Prompt context]
Source: https://vitehub.dev/raw/docs/agents/instructions.md

<paste the relevant Markdown section>
```

## Read local source

Agents that contribute to this repository can read `docs/content/docs/` directly.
Use the public raw URL when you build an external application, so that the context stays portable.

::note
Raw pages describe the current published documentation. If their examples disagree with the installed exports or types of an application, use the installed contract and report the difference.
::
