---
title: ViteHub Console
description: Inspect and run your app from console.vitehub.dev, the vitehub CLI, or an agent on the ViteHub MCP. All three call one signed route of your app.
navigation.title: Overview
navigation.order: 1
navigation.group: Start
icon: i-lucide-monitor-dot
---

The ViteHub Console is a web app at [console.vitehub.dev](https://console.vitehub.dev). It shows the primitives that your app turned on, such as Agents, KV, Blob, and Content, and it opens many apps from one team.

Your app does not serve a Console page, a Console MCP, or a Console sign-in. It serves one route, and three clients call it:

| Client | Use it for |
| --- | --- |
| [Console](https://console.vitehub.dev) | Browse sessions, data, and Definitions in a browser, and edit Content. |
| [`vitehub` CLI](/docs/development/cli) | Run the same actions from a terminal or a CI job, also against a development server. |
| [ViteHub MCP](/docs/console/mcp) | Let a coding agent run them, with your Console account. |

Each action is an [operation](/docs/console/operations), such as `kv.list` or `content.publish`. Define one in your app, and it is a Console action, a CLI command, and an MCP tool.

## The route of your app

| Route | Use |
| --- | --- |
| `POST /_vitehub/rpc` | The Operations endpoint. Each request carries one operation call. Only [signed requests](/docs/console/signed-requests) get in. |
| `GET /_vitehub/rpc?ticket=<ticket>` | Opens a [one-time link](/docs/console/site-access#one-time-links), such as a Content preview. The browser opens it. |
| `/_vitehub/.well-known/skills/` | Public files of the [ViteHub skill](/docs/getting-started/ai-resources/agent-instructions-skills#install-from-your-app) for `npx skills add`. |

The build includes only the routes and server code of the sections that the app turns on. An app without Agents has no Agent routes.

> [!WARNING]
> Console data can contain user prompts, model output, tool activity, Blob metadata, and KV values. Protect the endpoint before you put the app on a production URL. See [Console access](/docs/console/access).

## Next steps

| Page | Read it to |
| --- | --- |
| [Get started](/docs/console/get-started) | Turn on the endpoint and link your app. |
| [Sections](/docs/console/sections) | Know what each section shows and changes. |
| [Agents in the Console](/docs/console/agents) | Start, inspect, and cancel Agent sessions. |
| [Console access](/docs/console/access) | Give each person or key only some sections. |
| [Signed requests](/docs/console/signed-requests) | Make keys for the CLI and CI, and rotate them. |
| [Operations](/docs/console/operations) | Add your own actions to the Console, the CLI, and MCP. |
| [Limits and errors](/docs/console/limits-and-errors) | Fix a failed call. |
