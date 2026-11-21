---
title: Learn to build with Agents
description: Run your first Agent, add a model and tools, then build a chat application.
navigation.title: Learning path
navigation.order: 2
navigation.group: Start
navigation.kind: guide
icon: i-lucide-rocket
---

An Agent is server code that runs a task for your app. You give it a prompt, and it can call an AI model, use tools, and return a result.

This guide walks through the Agent lessons in order. You start with an Agent that runs without an AI model, add a model and a tool, and finish by building a full chat app.

> [!NOTE] Before you start
> Use the app from [Installation](/docs/getting-started/installation). The first lesson needs no account or API key. Models cost money from the second step on, so check your provider's pricing before sending requests.

## Run an Agent without credentials

Start with [First Agent](/docs/getting-started/first-agent). You write a small Agent, call it from `POST /api/greet`, and check the JSON response. It works in the Vite and Nitro app or the Nuxt app from Installation.

That lesson uses a function Driver. A Driver is the part that does the work of an Agent. A function Driver is plain code, so it needs no model.

Read [Agent Definitions](/docs/agents/agent-definitions) to see how that first file works. To read results, stream output, or cancel a run, see [Invocations](/docs/agents/invocations).

## Add a model and one tool

Swap the function Driver for a model as shown in [Agent Drivers](/docs/agents/agent-drivers#use-a-model-backed-driver). Put the model API key on the server and keep the same route while you test the model's replies.

Then add [Instructions](/docs/agents/instructions) and one [Capability](/docs/agents/capabilities). A Capability gives the Agent a tool it can call, such as reading files in a Workspace or searching docs. Pick one from the [official Capability catalog](/docs/agents/capabilities/official), which shows how to set up each tool and what it can access.

## Build a complete chat application

[Build an AI chat app with Nuxt and ViteHub](/docs/agents/build-a-chat-app) connects an Agent to a streaming chat page. It includes every source file, sign-in, saved conversations, and checks after a restart. Build it in offline mode first, then switch to a live model once it works.

Your app controls who can use the chat and stores the conversation history. [History and sessions](/docs/agents/chat-history-sessions) explains how chat history differs from Agent State and the invocation journal.

## Inspect a run before extending it

Use [Observability](/docs/agents/observability) to see what an Agent did, and [Evals](/docs/agents/evals) to test its answers. Add [invocation storage](/docs/agents/invocation-storage) when you need to keep run records after a request ends.

Already have an app? Pick the task you need from the sidebar. [Agent presets](/docs/agents/agent-presets), [child invocations](/docs/agents/controlled-child-invocations), and [runtime policy](/docs/agents/runtime-policy) cover advanced setups.

## Next steps

::card-group
:::card{title="First Agent" icon="i-lucide-bot" to="/docs/getting-started/first-agent"}
Run an Agent with no model and no API key.
:::

:::card{title="Build a chat app" icon="i-lucide-messages-square" to="/docs/agents/build-a-chat-app"}
Connect an Agent to a chat page with sign-in and saved chats.
:::
::
