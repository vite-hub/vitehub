---
title: Channels
description: Understand how messages reach an Agent Invocation.
navigation.order: 15
navigation.group: Application model
navigation.lanes: [agents]
icon: i-lucide-message-square
---

A Channel records where a message came from and how to reply. It carries the message, sender, attachments, reply target, delivery facts, and host commands around an Agent Invocation.

A Channel handles message transport. An Agent Invocation runs the Agent for one input. One Agent Definition can run behind several Channel adapters because these records stay separate.

## Channel and Invocation have different jobs

| | Channel | Agent Invocation |
| --- | --- | --- |
| Describes | Message origin and delivery | Identity, Capabilities, execution, and result |
| Lifetime | Can contain many messages and Invocations | One request |
| Can exist alone | Yes, a Channel can receive a message without starting an Agent | Yes, a route or schedule can start an Invocation without a Channel |

## Message and command facts stay separate

| Term | Carries |
| --- | --- |
| Message | Content, sender, attachments, reply target, and Channel metadata. |
| Command | A host action such as stop, retry, or inspect. |
| Agent Invocation | The resolved identity, Capabilities, context, execution, and result. |
| Chat Session | The message history selected for an invocation. |

A message can start an Invocation. A host command can affect a session or a running Invocation without becoming model input.

## Treat Channel metadata as input from the adapter

Use verified Channel metadata to identify the Agent Invoker, choose a Capability, or select a Workspace Scope. Inspect the Channel and Invocation together when a message reaches the wrong Agent, carries the wrong identity, or loses delivery data.

Read [Channels](/docs/agents/channels), [Chat history and sessions](/docs/agents/chat-history-sessions), and [Agent Invocations](/docs/concepts/agent-invocations) for the operational APIs.
