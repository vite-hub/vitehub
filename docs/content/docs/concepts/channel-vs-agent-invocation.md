---
title: Channel vs Agent Invocation
description: Choose between message transport and Agent execution.
navigation.order: 43
navigation.lanes: [agents]
icon: i-lucide-message-circle-code
---

Use a Channel to describe where a message came from and how it was delivered. Use an Agent Invocation to describe the request that runs an Agent Definition for one input.

## The records have different jobs

| | Channel | Agent Invocation |
| --- | --- | --- |
| Describes | Transport and message context | Identity, Capabilities, context, execution, and result |
| Lifetime | Can surround many messages and invocations | One request |
| Contains | Delivery metadata and host commands | Agent execution state and output |
| Can exist alone | Yes, a Channel can receive a message without starting an Agent | Yes, a route or schedule can start an Invocation without a message Channel |

A Channel can start many Agent Invocations. The Invocation keeps the trusted Channel facts it needs, but it does not become the transport adapter.

Read [Channels](/docs/concepts/channels-api) for the vocabulary and [Agent Invocations](/docs/concepts/agent-invocations) for the execution lifecycle.
