---
title: ViteHub and Vercel AI SDK
description: Compare AI SDK model, Agent, and streaming APIs with the Agent Definitions and server services that ViteHub adds around them.
navigation.title: Vercel AI SDK
navigation.order: 4
navigation.group: Agent frameworks
icon: i-lucide-messages-square
---

Use AI SDK when you need model calls, structured output, tools, an Agent loop,
or streaming UI in an existing application. Use ViteHub when you also want
discovered Agent Definitions and host-selected server services.

The two can work together. ViteHub's model-backed Driver accepts a compatible
AI SDK model. AI SDK does not require Vercel hosting.

## Separate model APIs from application services

| Task | AI SDK | ViteHub |
| --- | --- | --- |
| Call models through one TypeScript API. | Core model and provider APIs. | Model Drivers use the documented model forms. |
| Run a tool loop. | Agent APIs, including `ToolLoopAgent`. | Agent Drivers run Capability-contributed tools. |
| Stream a chat interface. | Streaming and UI APIs for several frameworks. | Agent chat contracts and Vue UI components. |
| Configure server storage and background jobs. | Compose the SDK with the application's server stack. | Configure services such as KV, Blob, Database, Queue, and Workflow. |

AI SDK includes Agent APIs. Describing it as only a set of model request
helpers leaves out a substantial part of the current library.

## Keep an existing AI SDK app when it fits

A chat app that already has routes, authentication, storage, and deployment
may need only AI SDK. Adding ViteHub is a separate application architecture
choice, not a requirement for tools or streaming.

Evaluate ViteHub when the app needs shared server APIs, explicit Agent
Capabilities, file Workspaces, or generated host integration. You can also
use a ViteHub server service without replacing the existing chat loop.

## Test the boundary between them

Choose the model and provider first. Configure its credential in the server
environment. Then test one streamed response, one tool result, cancellation,
and error handling through the application route.

Do not run two independent tool loops for the same Agent invocation. Decide
whether the application or the ViteHub Driver owns that loop.

Sources checked on 29 October 2026:
[AI SDK introduction](https://ai-sdk.dev/docs/introduction) and
[AI SDK Agents](https://ai-sdk.dev/docs/agents/overview).
Read [ViteHub Agent Drivers](/docs/agents/agent-drivers) for supported model
forms and [Build a chat app](/docs/agents/build-a-chat-app) for the complete
ViteHub example.
