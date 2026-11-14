---
title: Give an Agent your first tool
description: Turn on the MCP server of your app, write one tool, and call it from Claude Code.
layout: tutorial
navigation.title: Get started
navigation.order: 2
icon: i-lucide-rocket
---

[MCP](https://modelcontextprotocol.io) (Model Context Protocol) is how Agents such as Claude Code, Codex, or ChatGPT call tools. Your app can serve its own MCP server. Each file in `server/mcp/tools/` is one tool, and the server answers at `/mcp`.

In this tutorial, you write a tool that adds two numbers, and you call it from Claude Code.

> [!NOTE] Before you start
> Use the app from [Installation](/docs/getting-started/installation). Run the commands from the root of the app. To connect an Agent, you need [Claude Code](https://code.claude.com) or another MCP client.

This is not the [ViteHub MCP](/docs/development/mcp) of the Console, which gives the operations of your apps to the people of your Console team.

::tutorial-step{title="Turn it on"}
## Turn it on

Install `@vite-hub/mcp`:

```bash pm [commands/install]
pnpm add @vite-hub/mcp
```

Turn on `mcp` in the ViteHub options. The MCP server needs sign-in by default. For this tutorial, `auth: false` turns sign-in off, so that you can connect without an account:

:::tabs{sync="framework"}
::::tabs-item{label="Nuxt"}
```ts [nuxt.config.ts]
export default defineNuxtConfig({
  modules: ['vite-hub/nuxt'],
  vitehub: { mcp: { auth: false } },
})
```
::::

::::tabs-item{label="Nitro"}
```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { nitro } from 'nitro/vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [vitehub({ mcp: { auth: false } }), nitro()],
})
```
::::

::::tabs-item{label="Vite"}
```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [vitehub({ mcp: { auth: false } })],
})
```
::::
:::

> [!WARNING]
> With `auth: false`, anyone who knows the URL can call every tool. Before you deploy, remove `auth: false` and [sign MCP clients in](/docs/mcp/configure#sign-in-with-mcp-oauth).

::

::tutorial-step{title="Write a tool"}
## Write a tool

Create `server/mcp/tools/add.ts`:

```ts [server/mcp/tools/add.ts]
import { defineMcpTool } from 'vite-hub/mcp'
import { z } from 'zod'

export default defineMcpTool({
  description: 'Add two numbers.',
  input: z.object({ a: z.number(), b: z.number() }),
  handler: ({ a, b }) => ({ sum: a + b }),
})
```

- The file name is the tool name, so this tool is `add`.
- `description` tells the Agent what the tool does and when to call it.
- `input` is a Standard Schema that also gives its JSON Schema, such as a Zod 4 object. The server checks the arguments before the handler runs.
- The handler returns an object, so the Agent gets it as JSON text and as `structuredContent`.

::

::tutorial-step{title="Inspect the tools"}
## Inspect the tools

List the tools that the build found:

```bash [commands/inspect]
vitehub inspect definitions --kind mcp-tool
```

::

::tutorial-step{title="Connect an Agent"}
## Connect an Agent

Start the dev server with `pnpm dev`. Then add the server to Claude Code:

```bash [commands/connect]
claude mcp add --transport http my-app http://localhost:3000/mcp
```

Ask Claude Code to add 2 and 3 with the `my-app` tools. It calls `add` and reads `{ "sum": 5 }`.

::

## In production

In production, the server answers at `/mcp` of your app, such as `https://app.example.com/mcp`. With `auth: false`, anyone who knows the URL can call every tool. Remove `auth: false`, set `auth` in the ViteHub options, and add `mcpOAuth()`, so that the server needs an access token. See [Sign in with MCP OAuth](/docs/mcp/configure#sign-in-with-mcp-oauth).

::card-group
:::card{title="Configure" icon="i-lucide-sliders-horizontal" to="/docs/mcp/configure"}
Change the route, and sign MCP clients in with OAuth.
:::

:::card{title="Server API" icon="i-lucide-code-2" to="/docs/mcp/server-api"}
Read every option of `defineMcpTool()` and what a handler returns.
:::

:::card{title="Limits and errors" icon="i-lucide-circle-alert" to="/docs/mcp/limits-and-errors"}
Know what the server supports, and fix its build errors.
:::
::
