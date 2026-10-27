---
title: Introduction
description: Add storage to your app or run your first Agent with ViteHub.
navigation.title: Introduction
navigation.order: 1
navigation.group: Get started
icon: i-lucide-rocket
---

ViteHub adds server APIs to Vite and Nuxt apps. Use Server Primitives to store
data or run background work. Use Agents to run application code, call a model,
or use a coding provider. You can use either part on its own.

## Start with one result

Follow [Installation](/docs/getting-started/installation) to choose Vite or
Nuxt and check a server route. Then continue in the same app:

- [First Server Primitive](/docs/getting-started/first-server-primitive) saves a theme setting in local KV and reads it back.
- [First Agent](/docs/getting-started/first-agent) calls a function Driver and returns a greeting through HTTP.

Both first results work without provider credentials. The Agent tutorial starts
with an offline function so you can check the invocation before paying for a
model call.

For a complete model-backed project, follow
[Build a chat app](/docs/agents/build-a-chat-app). It connects an Agent to a
chat UI, streams replies, and keeps conversation history. Its offline mode
needs no credentials. Switching to a model can incur provider charges.

The server APIs work independently of your frontend. [ViteHub UI](/docs/ui)
provides Vue and Nuxt components. Read [Built for the Vue ecosystem](/docs/getting-started/built-for-vue)
for the UI package's design choices.

## Add the feature your app needs

After the first result, choose a [Server Primitive](/docs/getting-started/server-primitives)
for uploads, relational data, or background jobs. The feature's tutorial shows
its setup, a server call, and an expected result. Its Hosts page explains the
provider requirements.

Agents can use these APIs through [Capabilities](/docs/agents/capabilities).
Give an Agent only the operations it needs. Start with
[Agent Definitions](/docs/agents/agent-definitions) to select a Driver.

## Work with a coding agent

[AI resources](/docs/getting-started/ai-resources) provides the ViteHub skill,
docs MCP server, and Markdown pages. Give your coding agent the tutorial for
the feature you are building so it can use the current imports and commands.

## Understand or deploy the app

Read [How ViteHub works](/docs/getting-started/concepts) for the shared terms
and [Build and deploy](/docs/getting-started/build-and-deploy) for host setup.
If you have a NuxtHub app, use [Migrate from NuxtHub](/docs/getting-started/migrate-from-nuxthub).
