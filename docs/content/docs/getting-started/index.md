---
title: Introduction
description: Choose the ViteHub layer that matches the first thing you need to build.
navigation.title: Introduction
navigation.order: 1
icon: i-lucide-rocket
---

ViteHub adds a server layer to Vite. Server Primitives give application code
APIs for storage, background work, auth, and other server features. Agents
combine those APIs with models, coding providers, or application code.

Agents can use Server Primitives. Server Primitives also work on their own.
Start with the path that matches the result your product needs today.

## Build your first result

Choose the path for the feature you need. Both work in the same application.

| You want to build | Start here |
| --- | --- |
| A route that saves and reads settings | [First Server Primitive](/docs/getting-started/first-server-primitive) |
| An Agent that runs a task and returns a result | [First Agent](/docs/getting-started/first-agent) |
| Storage, uploads, or background work | [Server Primitives](/docs/getting-started/server-primitives) |
| A Nuxt app that already uses NuxtHub | [Migrate from NuxtHub](/docs/getting-started/migrate-from-nuxthub) |

Start with [Installation](/docs/getting-started/installation) if you have not
added ViteHub to your app. Use [Guides](/guides) when you want a tutorial for a
specific feature.

## What ViteHub does

Most features use the same path:

| Part | What it does |
| --- | --- |
| Vite integration | Finds definitions and prepares the selected provider during development and build. |
| Definition | Declares named work or state, such as an Agent, Workspace, Queue, Workflow, or Schedule. |
| Server API | Lets application code call a feature through an import such as `kv`, `useWorkspace()`, or `runAgent()`. |
| Capability | Lets an Agent use a selected operation such as `workspaceShell()` or `kv()`. |

Application code uses ViteHub imports. The integration handles the
provider-specific routes, bindings, and files.

## Verify your setup

Check the ViteHub plugin in `vite.config.ts`, the definition file when the
feature needs one, and the ViteHub call in server code. Each first guide ends
with a response you can inspect before adding another feature.

## Find the next topic

Read [How ViteHub works](/docs/getting-started/concepts) for the terms used
across the packages. Open [Build and deploy](/docs/getting-started/build-and-deploy)
for framework setup, development tools, and deployment guides.

If you use a coding agent to build your application, the
[AI resources](/docs/getting-started/ai-resources) include the ViteHub skill,
docs MCP server, and Markdown pages.
