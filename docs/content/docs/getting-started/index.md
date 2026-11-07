---
title: Introduction
description: Add storage to your app or run your first Agent with ViteHub.
navigation.title: Introduction
navigation.order: 1
navigation.group: Get started
icon: i-lucide-rocket
---

ViteHub adds server APIs to Vite and Nuxt apps. Server Primitives store data
or run background work. Agents run your code, call a model, or use a coding
provider. You can use either part alone.

## Start with one result

Follow [Installation](/docs/getting-started/installation) to pick Vite or Nuxt
and check a server route. Then continue in the same app:

- [First Server Primitive](/docs/getting-started/first-server-primitive) saves a theme setting in local KV and reads it back.
- [First Agent](/docs/getting-started/first-agent) calls a function Driver and returns a greeting through HTTP.

Neither needs provider credentials. The Agent tutorial starts with an offline
function, so you can check the run before you pay for a model call.

[Build a chat app](/docs/agents/build-a-chat-app) is a complete model-backed
project. It connects an Agent to a chat UI, streams replies, and keeps
history. Its offline mode needs no credentials. A model can cost money.

The server APIs work with any frontend. [ViteHub UI](/docs/ui) gives Vue and
Nuxt components; [Built for the Vue ecosystem](/docs/getting-started/built-for-vue)
explains why.

## Add the feature your app needs

Next, pick a [Server Primitive](/docs/getting-started/server-primitives) for
uploads, relational data, or background jobs. Its tutorial shows setup, a
server call, and the result. Its Hosts page lists provider requirements.

Agents use these APIs through [Capabilities](/docs/agents/capabilities). Give
an Agent only the operations it needs. Start with
[Agent Definitions](/docs/agents/agent-definitions) to select a Driver.

## Work with a coding agent

[AI resources](/docs/getting-started/ai-resources) gives you the ViteHub
skill, the docs MCP server, and Markdown pages. Give your coding agent the
tutorial for your feature so it uses current imports and commands.

## Understand or deploy the app

Read [How ViteHub works](/docs/getting-started/concepts) for shared terms and
[Build and deploy](/docs/getting-started/build-and-deploy) for host setup.
For a NuxtHub app, use [Migrate from NuxtHub](/docs/getting-started/migrate-from-nuxthub).
