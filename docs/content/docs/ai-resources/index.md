---
title: AI-readable documentation
description: Give coding agents the smallest reliable ViteHub context for the task.
navigation.title: AI-readable docs
navigation.order: 60
icon: i-lucide-file-text
---

ViteHub publishes a coding-agent skill, a compact documentation index, and raw Markdown pages.
Use the smallest resource that gives your agent enough context to complete the task.

## Public resources

| ViteHub resource | Use |
| --- | --- |
| [ViteHub coding-agent skill](/docs/ai-resources/agent-instructions-skills) | Give Cursor, Claude Code, Codex, and other coding agents a repeatable ViteHub process. |
| [`/llms.txt`](https://vitehub.dev/llms.txt) | Discover the current documentation map. |
| [Raw Markdown pages](/docs/ai-resources/markdown-pages) | Load one canonical page without the rendered site shell. |
| [`/llms-full.txt`](https://vitehub.dev/llms-full.txt) | Load the complete documentation set when a broad audit genuinely needs it. |
| [ViteHub OpenAPI document](https://vitehub.dev/openapi.json) | Discover the machine-readable resources served by the documentation host. |
| [ViteHub MCP server](https://vitehub.dev/mcp) | Search the documentation from an MCP client over Streamable HTTP. |
| [ViteHub CLI on npm](https://www.npmjs.com/package/vite-hub) | Install the official `vitehub` command with the framework distribution. |

The OpenAPI document describes `vitehub.dev`, not a shared hosted runtime API.
ViteHub runs inside your application, so its application endpoints depend on the Agent Definitions, Channels, and server routes that application declares.

## Install the skill

The public skill is the recommended entry point for a coding agent that edits a ViteHub application.
Install it through the skills CLI:

```bash [Terminal]
npx skills add https://vitehub.dev
```

Ask the agent for the application outcome rather than a package recipe.
The skill chooses the Server Primitives or Agents lane, checks the installed package contract, and proves the result.

```txt [Prompt]
Add durable rate limiting to this server route with ViteHub and prove it locally.
```

## Work without the skill

An AI tool that cannot install skills can use the same public sources directly.
Keep the context narrow so current task details remain prominent.

```txt [Agent flow]
1. Read https://vitehub.dev/llms.txt.
2. Choose the single smallest raw Markdown page for the task.
3. Inspect the application's installed ViteHub exports and types.
4. Keep the source URL with any copied context.
```

::tip
Use `llms-full.txt` for broad analysis, not routine implementation. One raw page usually gives a coding agent better signal.
::

## Choose the rendered site

Use rendered pages when navigation, diagrams, or visual examples matter.
Use raw Markdown when an agent needs source context or when you copy documentation into another tool.
