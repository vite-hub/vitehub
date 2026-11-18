---
title: ViteHub Console
description: Inspect and run your app from console.vitehub.dev, the vitehub CLI, or an agent on the ViteHub MCP. All three call one signed route of your app.
navigation.title: Overview
navigation.order: 1
navigation.group: Start
icon: i-lucide-monitor-dot
---

The ViteHub Console at [console.vitehub.dev](https://console.vitehub.dev) shows what your apps run, such as their Agents, KV keys, Blob objects and Content, in one place for your whole team.

Your app serves no Console page, MCP or sign-in of its own. It serves one route, and three clients call it:

| Client | Use it to |
| --- | --- |
| Console | Browse sessions, data and Definitions, and edit Content. |
| [`vitehub` CLI](/docs/cli) | Run the same actions from a terminal or CI, also against a development server. |
| [ViteHub MCP](/docs/console/mcp) | Let a coding agent run them with your Console account. |

Each action is an **operation**, such as `kv.list` or `content.publish`, so an operation that you define becomes a Console action, a CLI command and an MCP tool at once.

## The route of your app

| Route | Use |
| --- | --- |
| `POST /_vitehub/rpc` | The Operations endpoint. Each request carries one operation call, and only [signed requests](/docs/console/signed-requests) get in. |
| `GET /_vitehub/rpc?ticket=<ticket>` | Opens a [one-time link](/docs/console/site-access#one-time-links), such as a Content preview, in the browser. |
| `/_vitehub/.well-known/skills/` | Public files of the [ViteHub skill](/docs/getting-started/ai-resources/agent-instructions-skills#install-from-your-app) for `npx skills add`. |

The build includes routes and server code only for the sections that the app turns on, so an app without Agents has no Agent routes.

::warning
Console data can hold user prompts, model output, tool activity, Blob metadata and KV values. Protect the endpoint before the app goes on a production URL. See [Console access](/docs/console/access).
::

## Next steps

| Page | Read it to |
| --- | --- |
| [Get started](/docs/console/get-started) | Turn on the endpoint and link your app. |
| [Sections](/docs/console/sections) | Know what each section shows and changes. |
| [Agents in the Console](/docs/console/agents) | Start, inspect and cancel Agent sessions. |
| [Operations](/docs/console/operations) | Add your own actions to the Console, the CLI and MCP. |
| [Limits and errors](/docs/console/limits-and-errors) | Fix a failed call. |
