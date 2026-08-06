---
title: Channel vs Agent Invocation
description: Understand the difference between where a message came from and the Agent request it starts.
navigation.group: Choose between
navigation.order: 43
icon: i-lucide-message-circle-code
---

Use a Channel to describe message origin, delivery facts, and host commands. Use an Agent Invocation to describe the resolved execution of an Agent Definition for one input.

## The distinction

| | Channel | Agent Invocation |
| --- | --- | --- |
| Describes | Transport and message context | Identity, Capabilities, context, execution, and output |
| Lifetime | Can surround many messages and invocations | One request |
| Owns | Delivery metadata and channel commands | Agent execution state and result |
| Can exist without the other | Yes, a channel can receive messages without invoking an Agent | Yes, a route or schedule can start an invocation without a message Channel |

A Channel can start many Agent Invocations. The invocation should retain the trusted channel facts it needs, but it should not become the transport adapter.

Read [Channels](/docs/concepts/channels-api) for the vocabulary and [Agent Invocations](/docs/concepts/agent-invocations) for the execution lifecycle.
