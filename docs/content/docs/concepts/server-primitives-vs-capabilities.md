---
title: Server Primitive vs Capability
description: Choose between a direct application runtime API and an Agent-facing ability.
navigation.group: Choose between
navigation.order: 40
icon: i-lucide-blocks
---

Use a Server Primitive when trusted application code should perform the operation directly. Use a Capability when an Agent should receive a selected, inspectable ability during an Agent Invocation.

## The distinction

| | Server Primitive | Capability |
| --- | --- | --- |
| Caller | Application server code | Agent Driver through an Agent Invocation |
| Access | Stable Runtime Helper | Tools, policy, requirements, or context contributed to an Agent |
| Selection | Installed and called by application code | Attached to the Agent Definition or resolved for an invocation |
| Model access | None by default | Explicitly model-facing |

Installing a primitive does not expose it to every Agent. Attach the matching Capability when the model should use it, and keep direct application operations as Runtime Helper calls.

Read [Server primitives](/docs/concepts/server-primitives-for-any-host) for application code and [Capabilities](/docs/concepts/capabilities-api) for Agent composition.
