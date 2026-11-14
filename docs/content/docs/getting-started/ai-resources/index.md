---
title: Give your coding agent ViteHub context
navigation.group: Coding agents
description: Choose the skill, MCP server, page action, or index that gives a coding agent current ViteHub documentation.
navigation.title: Overview
navigation.order: 201
icon: i-lucide-file-text
---

Use these resources when a coding agent writes or changes your app. You do not
need them when you code by hand. An agent can use more than one: the skill
gives it a process, and the MCP server gives it live lookups.

## Choose by task

| Task | Resource | Setup |
| --- | --- | --- |
| Build or change a ViteHub application | ViteHub skill | [Add the ViteHub skill](/docs/getting-started/ai-resources/agent-instructions-skills) |
| Contribute to ViteHub itself | ViteHub Dev skill | `npx skills add https://vitehub.dev --skill vitehub-dev` |
| Let the agent search and read the docs as it works | Docs MCP server | [Connect the docs MCP server](/docs/getting-started/ai-resources/mcp-server) |
| Ask a chat tool about one page | Page actions and raw Markdown | [Copy a page for an LLM](/docs/getting-started/ai-resources/markdown-pages) |
| Give a tool without skills or MCP a documentation map | `llms.txt` indexes | [Load a documentation index](#load-a-documentation-index) |

## Start in Claude Code

Run both commands from the project root:

```bash [Terminal]
npx skills add https://vitehub.dev --skill vitehub --agent claude-code
claude mcp add --transport http vitehub https://vitehub.dev/mcp
```

Then ask for a result, not a package recipe:

```txt [Prompt]
Add durable rate limiting to this server route with ViteHub and prove it locally.
```

For Cursor, VS Code, Windsurf, and Codex, the [skill page](/docs/getting-started/ai-resources/agent-instructions-skills) and the [MCP page](/docs/getting-started/ai-resources/mcp-server) have a snippet for each.

## Load a documentation index

Each index links every docs page to its raw Markdown version. Raw pages, `llms-full.txt`, and the MCP server hold all the site text plus agent-only notes that the site hides: routing hints, exact commands, and common agent mistakes.

| URL | Content |
| --- | --- |
| `https://vitehub.dev/llms.txt` | Every docs page, plus trust and developer resources. Start here. |
| `https://vitehub.dev/llms-full.txt` | The complete documentation in one file. |

Give the agent the index and let it pick only the pages the task needs. An app that uses KV and Queue without Agents needs only those two pages:

```txt [Agent flow]
1. Read https://vitehub.dev/llms.txt.
2. Choose the smallest raw Markdown page for the task.
3. Inspect the application's installed ViteHub exports and types.
4. Keep the source URL with any copied context.
```

::tip
Use `llms-full.txt` for a broad audit, not routine work. One raw page usually gives a better signal.
::

## Find other machine-readable resources

| Resource | Use |
| --- | --- |
| [ViteHub OpenAPI document](https://vitehub.dev/openapi.json) | Describes the resources `vitehub.dev` serves. |
| [Skill index](https://vitehub.dev/.well-known/skills/index.json) | Lists the skills `vitehub.dev` publishes. The skills CLI reads it. |
| [ViteHub Agent Skill](https://vitehub.dev/.well-known/skills/vitehub/SKILL.md) | The entry file of the ViteHub skill. |
| [ViteHub MCP server](https://vitehub.dev/mcp) | Streamable HTTP endpoint for MCP clients. |
| [ViteHub CLI on npm](https://www.npmjs.com/package/vite-hub) | The `vite-hub` package includes the official `vitehub` command. |

The OpenAPI document describes `vitehub.dev`, not a hosted runtime API.
ViteHub runs inside your app, so your endpoints come from the Agent Definitions, Channels, and server routes you declare.

::note
The docs describe the current published release. When an example and the installed package differ, follow the installed exports and types, and ask the agent to report the difference.
::
