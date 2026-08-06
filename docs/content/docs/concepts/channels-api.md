---
title: Channels
description: Understand how messages reach an Agent Invocation.
navigation.order: 15
navigation.lanes: [agents]
icon: i-lucide-message-square
---

A Channel describes a message's origin and delivery. It carries the message, sender, attachments, reply target, delivery facts, and host commands around an Agent Invocation.

The Channel is the transport record. The Agent Invocation is the request that runs the Agent. Keeping them separate lets one Agent Definition work behind different adapters.

## Message and command facts stay separate

| Term | Carries |
| --- | --- |
| Message | Content, sender, attachments, reply target, and Channel metadata. |
| Command | A host action such as stop, retry, or inspect. |
| Agent Invocation | The resolved identity, Capabilities, context, execution, and result. |
| Chat Session | The history boundary used to select messages for an invocation. |

A message can start an Invocation. A host command can affect a session or a running Invocation without becoming model input.

## Treat Channel metadata as input from the adapter

Use verified Channel metadata to resolve an Agent Invoker, choose a Capability, or select a Workspace Scope. Inspect the Channel beside the Invocation when a message reaches the wrong Agent, carries the wrong identity, or loses delivery data.

Read [Channels](/docs/agents/channels), [Chat history and sessions](/docs/agents/chat-history-sessions), and [Agent Invocations](/docs/concepts/agent-invocations) for the operational APIs.
