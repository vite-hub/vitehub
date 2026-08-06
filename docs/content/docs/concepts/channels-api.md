---
title: Channels
description: "Understand how message origin, delivery facts, and host commands surround Agent Invocations."
navigation.group: Core vocabulary
navigation.order: 15
icon: i-lucide-message-square
---

A Channel describes how a message-shaped Agent Invocation can be reached. It carries origin, message, delivery, and command facts without becoming the Agent Invocation itself.

Channels keep transport behavior separate from Agent behavior. The same Agent Definition can be reached from a web route, chat adapter, schedule, webhook, or CLI entry point.

## Message and command facts are different

| Concept | Carries |
| --- | --- |
| Message | Content, sender, attachments, reply target, and channel metadata. |
| Command | A host-owned action such as stop, retry, or inspect. |
| Agent Invocation | The resolved request that executes the Agent Definition. |
| Chat Session | The history boundary that selects messages for an invocation. |

A message can start an invocation, but a host command can affect a session or running invocation without being model input.

## Keep channel metadata trusted

Channel metadata comes from the adapter or host. Use it to resolve an Agent Invoker, select a Capability, or choose a Workspace Scope only after the entry surface has verified the data it provides.

Inspect the Channel alongside the Agent Invocation when a message reaches the wrong Agent, carries the wrong identity, or loses delivery metadata.

Read [Channels](/docs/agents/channels), [Chat history and sessions](/docs/agents/chat-history-sessions), and [Agent Invocations](/docs/concepts/agent-invocations) for the operational surfaces.
