---
title: Learn to build with Agents
description: Run your first Agent, add a model and tools, then build a chat application.
navigation.title: Learning path
navigation.order: 2
navigation.group: Start
navigation.kind: guide
icon: i-lucide-rocket
---

Start with a working request, then add the behavior your application needs. These lessons use the `vite-hub` application setup from [Installation](/docs/getting-started/installation).

## Run an Agent without credentials

Follow [First Agent](/docs/getting-started/first-agent). You will define a function Driver, call it from `POST /api/greet`, and check the exact JSON response. It needs no model account and works in the Vite/Nitro or Nuxt app you already installed.

[Agent Definitions](/docs/agents/agent-definitions) explains the options in that first file. [Invocations](/docs/agents/invocations) covers result handling, streaming, and cancellation.

## Add a model and one tool

Use [Agent Drivers](/docs/agents/agent-drivers#use-a-model-backed-driver) to replace the function Driver with a model. Set its credential on the server and check the provider's pricing before sending a request. Keep the same route while you test the model's response.

Then add [Instructions](/docs/agents/instructions) and one [Capability](/docs/agents/capabilities). Choose a tool your application needs, such as reading a Workspace or searching documentation. The [official Capability catalog](/docs/agents/capabilities/official) links to each tool's setup and access contract.

## Build a complete chat application

[Build an AI chat app with Nuxt and ViteHub](/docs/agents/build-a-chat-app) connects the Agent to a streaming browser UI. It includes every source file, sign-in, saved conversations, and restart checks. Start in offline mode, then switch to a model when the application works.

The application owns user access and saved chat history. [History and sessions](/docs/agents/chat-history-sessions) explains how those choices differ from Agent State and invocation journals.

## Inspect a run before extending it

Use [Observability](/docs/agents/observability) to inspect work and [Evals](/docs/agents/evals) to check behavior. Add [invocation storage](/docs/agents/invocation-storage) when you need records that survive the request.

For an existing application, use the sidebar to open the task you need. [Agent presets](/docs/agents/agent-presets), [child invocations](/docs/agents/controlled-child-invocations), and [runtime policy](/docs/agents/runtime-policy) cover advanced composition.
