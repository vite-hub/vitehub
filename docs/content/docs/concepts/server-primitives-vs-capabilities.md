---
title: Server Primitive vs Capability
description: Choose between an application API and an Agent ability.
navigation.group: Choose between
navigation.order: 40
icon: i-lucide-blocks
---

Use a Server Primitive when server code should call the operation directly. Use a Capability when an Agent should receive a selected ability during an Agent Invocation.

## The caller decides the surface

| | Server Primitive | Capability |
| --- | --- | --- |
| Caller | Application server code | Agent Driver during an Agent Invocation |
| Access | Runtime Helper | Tools, policy, requirements, or context contributed to an Agent |
| Selection | Installed and called by application code | Attached to an Agent Definition or resolved for an invocation |
| Model access | None by default | Explicitly model-facing |

Installing a primitive does not expose it to every Agent. Attach the matching Capability when the Agent should use it; keep direct application work in the Runtime Helper.

Read [Server primitives](/docs/concepts/server-primitives-for-any-host) for application code and [Capabilities](/docs/concepts/capabilities-api) for Agent composition.
