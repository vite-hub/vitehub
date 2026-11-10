---
title: Learn to build with Agents
description: Run your first Agent, add a model and tools, then build a chat application.
navigation.title: Learning path
navigation.order: 2
navigation.group: Start
navigation.kind: guide
icon: i-lucide-rocket
---

An Agent is server code that does a task for your app. You give it a prompt. It can ask an AI model, use tools, and send back a result.

This page is a path through the Agent lessons, in order. You start with an Agent that needs no AI model. Then you add a model and a tool. At the end, you build a full chat app.

> [!NOTE] Before you start
> Use the app from [Installation](/docs/getting-started/installation). The first lesson needs no account and no API key. A model costs money from the second step on: read the pricing of your model provider before you send a request.

## Run an Agent without credentials

Follow [First Agent](/docs/getting-started/first-agent). You write a small Agent, call it from `POST /api/greet`, and check the JSON that it sends back. It works in the Vite and Nitro app or in the Nuxt app from Installation.

The Agent in that lesson uses a function Driver. A Driver is the part that does the work of an Agent. A function Driver is plain code, so it needs no model.

To learn more about that first file, read [Agent Definitions](/docs/agents/agent-definitions). To use the result, stream it, or cancel a run, read [Invocations](/docs/agents/invocations).

## Add a model and one tool

Replace the function Driver with a model. [Agent Drivers](/docs/agents/agent-drivers#use-a-model-backed-driver) shows how. Put the model API key on the server. Keep the same route while you test what the model says.

Then add [Instructions](/docs/agents/instructions) and one [Capability](/docs/agents/capabilities). A Capability is a tool that the Agent can use, such as reading files in a Workspace or searching docs. Choose one that your app needs. The [official Capability catalog](/docs/agents/capabilities/official) shows how to set up each tool and what it can access.

## Build a complete chat application

[Build an AI chat app with Nuxt and ViteHub](/docs/agents/build-a-chat-app) connects the Agent to a chat page that streams the answer. It includes every source file, sign-in, saved conversations, and checks after a restart. Start in offline mode. Switch to a model when the app works.

Your app decides who can use the chat and keeps the chat history. [History and sessions](/docs/agents/chat-history-sessions) explains how chat history is different from Agent State and the invocation journal.

## Inspect a run before extending it

Use [Observability](/docs/agents/observability) to see what an Agent did. Use [Evals](/docs/agents/evals) to test its answers. Add [invocation storage](/docs/agents/invocation-storage) when you must keep a record of each run after the request ends.

Do you already have an app? Open the task that you need from the sidebar. [Agent presets](/docs/agents/agent-presets), [child invocations](/docs/agents/controlled-child-invocations), and [runtime policy](/docs/agents/runtime-policy) cover advanced setups.

## Next steps

::card-group
:::card{title="First Agent" icon="i-lucide-bot" to="/docs/getting-started/first-agent"}
Run an Agent with no model and no API key.
:::

:::card{title="Build a chat app" icon="i-lucide-messages-square" to="/docs/agents/build-a-chat-app"}
Connect an Agent to a chat page with sign-in and saved chats.
:::
::
