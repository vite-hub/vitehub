---
title: Give your coding agent ViteHub context
description: Choose the skill, MCP server, page action, or index that gives a coding agent current ViteHub documentation.
navigation.title: AI resources
navigation.order: 60
icon: i-lucide-file-text
---

ViteHub publishes its documentation for coding agents as well as for people.
Choose the resource that matches the task. A coding agent can use more than one: the skill gives it a process, and the MCP server gives it live lookups.

## Choose by task

| Task | Resource | Setup |
| --- | --- | --- |
| Build or change a ViteHub application | ViteHub skill | [Add the ViteHub skill](/docs/ai-resources/agent-instructions-skills) |
| Let the agent search and read the docs while it works | Docs MCP server | [Connect the docs MCP server](/docs/ai-resources/mcp-server) |
| Ask a chat tool about one page | Page actions and raw Markdown | [Copy a page for an LLM](/docs/ai-resources/markdown-pages) |
| Give a tool without skills or MCP a documentation map | `llms.txt` indexes | [Load a documentation index](#load-a-documentation-index) |

## Start in Claude Code

Run both commands from the project root:

```bash [Terminal]
npx skills add https://vitehub.dev --skill vitehub --agent claude-code
claude mcp add --transport http vitehub https://vitehub.dev/mcp
```

Then ask for the result you want, not for a package recipe:

```txt [Prompt]
Add durable rate limiting to this server route with ViteHub and prove it locally.
```

Cursor, VS Code, Windsurf, and Codex use other commands and configuration files. The [skill page](/docs/ai-resources/agent-instructions-skills) and the [MCP page](/docs/ai-resources/mcp-server) have a snippet for each.

## Load a documentation index

Each index lists documentation pages and links every page to its raw Markdown version.

| URL | Content |
| --- | --- |
| `https://vitehub.dev/llms.txt` | Every docs page, plus blog, trust, and developer resources. Start here. |
| `https://vitehub.dev/llms/agents.txt` | Only the pages in the Agents lane of the sidebar. |
| `https://vitehub.dev/llms/server-primitives.txt` | Only the pages in the Server Primitives lane of the sidebar. |
| `https://vitehub.dev/llms-full.txt` | The complete documentation in one file. |

Give the agent the smallest index that covers the task.
For example, an application that uses KV and Queue without Agents needs only the Server Primitives index:

```txt [Agent flow]
1. Read https://vitehub.dev/llms/server-primitives.txt.
2. Choose the smallest raw Markdown page for the task.
3. Inspect the application's installed ViteHub exports and types.
4. Keep the source URL with any copied context.
```

::tip
Use `llms-full.txt` for a broad audit, not for routine implementation. One raw page usually gives a coding agent a better signal.
::

## Find other machine-readable resources

| Resource | Use |
| --- | --- |
| [ViteHub OpenAPI document](https://vitehub.dev/openapi.json) | Describes the resources that `vitehub.dev` serves. |
| [Skill index](https://vitehub.dev/.well-known/skills/index.json) | Lists the skills that `vitehub.dev` publishes. The skills CLI reads this file. |
| [ViteHub Agent Skill](https://vitehub.dev/.well-known/skills/vitehub/SKILL.md) | The entry file of the ViteHub skill. |
| [ViteHub MCP server](https://vitehub.dev/mcp) | Streamable HTTP endpoint for MCP clients. |
| [ViteHub CLI on npm](https://www.npmjs.com/package/vite-hub) | The `vite-hub` package includes the official `vitehub` command. |

The OpenAPI document describes `vitehub.dev`, not a hosted runtime API.
ViteHub runs inside your application, so the application endpoints depend on the Agent Definitions, Channels, and server routes that the application declares.

::note
The documentation describes the current published release. When an example and the installed package differ, the installed exports and types control the implementation. Ask the agent to report the difference.
::
