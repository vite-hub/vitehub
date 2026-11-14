---
title: MCP server
layout: landing
navigation.title: Overview
description: Serve your app's own MCP server, so Agents such as Claude Code, Codex, or ChatGPT call your code. One file is one tool.
navigation.order: 1
icon: i-lucide-plug-zap
---

::product-hero{tagline="Give Agents the tools of your app. Write one file for each tool, and connect the Agent to /mcp."}
  :::code-tree
  ```ts [server/mcp/tools/add.ts]
  import { defineMcpTool } from 'vite-hub/mcp'
  import { z } from 'zod'

  // The file name is the tool name: add
  export default defineMcpTool({
    description: 'Add two numbers.',
    input: z.object({ a: z.number(), b: z.number() }),
    handler: ({ a, b }) => ({ sum: a + b }),
  })
  ```

  ```bash [terminal]
  # Connect Claude Code to the server of your app
  claude mcp add --transport http my-app https://app.example.com/mcp

  # List the tools that the build found
  vitehub inspect definitions --kind mcp-tool
  ```
  :::
::

::product-features
  :::product-feature-item{title="One file is one tool" icon="i-lucide-file-code" to="/docs/mcp/get-started#write-a-tool"}
  Each file in `server/mcp/tools/` is one tool. The file name is the tool name.
  :::

  :::product-feature-item{title="Arguments are checked" icon="i-lucide-shield-check" to="/docs/mcp/server-api#define-a-tool"}
  `input` is a Standard Schema, such as Zod or Valibot. The server checks the arguments before the handler runs.
  :::

  :::product-feature-item{title="Sign in with MCP OAuth" icon="i-lucide-key-round" to="/docs/mcp/configure#sign-in-with-mcp-oauth"}
  With Auth, the server needs an access token. The handler knows the user and the client.
  :::

  :::product-feature-item{title="No MCP SDK" icon="i-lucide-feather" to="/docs/mcp/limits-and-errors#protocol"}
  ViteHub's own stateless Streamable HTTP server. It keeps no session between requests.
  :::

  :::product-feature-item{title="Prompts and resources" icon="i-lucide-files" to="/docs/mcp/server-api#define-a-prompt"}
  Each file in `server/mcp/prompts/` is one prompt, and each file in `server/mcp/resources/` is one resource.
  :::

  :::product-feature-item{title="Inspect the tools" icon="i-lucide-search" to="/docs/mcp/get-started#inspect-the-tools"}
  `vitehub inspect definitions --kind mcp-tool` lists the tools that the build found.
  :::
::

::agent-only
Use the MCP server when the app must give its own tools to Agents. Install `@vite-hub/mcp`, set `auth` and `mcp: true` in the ViteHub options, add `mcpOAuth()` from `vite-hub/auth/mcp` to `server/auth.ts`, and add one `defineMcpTool()` default export for each file in `server/mcp/tools/`. Import it from `vite-hub/mcp`. Add prompts with `defineMcpPrompt()` in `server/mcp/prompts/` and resources with `defineMcpResource()` in `server/mcp/resources/`. Set `mcp.instructions` and `mcp.serverInfo` to name the server.

`mcp: true` without `auth` fails the build with `VITE_HUB_R0141`. Set `mcp: { auth: false }` only when anyone may call every tool.

This is not the ViteHub MCP of the Console at `https://console.vitehub.dev/mcp`. Do not add an MCP SDK. Throw an error with a 4xx `status` to tell the Agent what to fix.

Prove it with `vitehub inspect definitions --kind mcp-tool`, then with a real `tools/list` and `tools/call` request to `/mcp`.
::
