---
title: ViteHub and Vercel AI SDK
description: Compare AI SDK model, Agent, and streaming APIs with the Agent Definitions and server services that ViteHub adds around them.
navigation.title: Vercel AI SDK
navigation.order: 4
navigation.group: Agent frameworks
icon: i-lucide-messages-square
---

Use AI SDK for model calls, structured output, tools, an Agent loop, or
streaming UI in an existing app. Use ViteHub when you also want Agents found
from files and server services picked for your host.

You can use both. ViteHub's model Driver takes a compatible AI SDK model. AI SDK does not need Vercel hosting.

## Separate model APIs from application services

| Task | AI SDK | ViteHub |
| --- | --- | --- |
| Call models through one TypeScript API. | Core model and provider APIs. | Model Drivers take the documented model forms. |
| Run a tool loop. | Agent APIs, including `ToolLoopAgent`. | Agent Drivers run Capability-contributed tools. |
| Stream a chat interface. | Streaming and UI APIs for several frameworks. | Agent chat contracts and Vue UI components. |
| Configure server storage and background jobs. | Combine the SDK with your server stack. | KV, Blob, Database, Queue, Workflow, and more. |

AI SDK includes Agent APIs. It is more than a set of model request helpers.

## Keep an existing AI SDK app when it fits

A chat app that already has routes, auth, storage, and deploys may need only
AI SDK. You do not need ViteHub for tools or streaming.

Try ViteHub for shared server APIs, explicit Agent Capabilities, file
Workspaces, or generated host setup. You can also add one ViteHub service and
keep your chat loop.

## Test the boundary between them

Pick the model and provider first, and put its credential in the server
environment. Then test one streamed response, one tool result, cancellation,
and errors through your app route.

Do not run two tool loops for the same Agent run. Decide if your app or the
ViteHub Driver owns the loop.

Sources checked on 29 October 2026:
[AI SDK introduction](https://ai-sdk.dev/docs/introduction) and
[AI SDK Agents](https://ai-sdk.dev/docs/agents/overview).
Read [ViteHub Agent Drivers](/docs/agents/agent-drivers) for model forms and
[Build a chat app](/docs/agents/build-a-chat-app) for a full example.
