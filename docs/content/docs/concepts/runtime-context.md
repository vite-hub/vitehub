---
title: Runtime Context
description: Understand the host-owned execution facts ViteHub passes into a server operation or Agent Invocation.
navigation.group: Runtime execution
navigation.order: 20
icon: i-lucide-waypoints
---

Runtime Context carries the execution facts that a ViteHub operation needs from its host. It can include runtime identity, platform resources, memoization, background work, request objects, provider bindings, and trace continuity.

Invocation input carries task data. Runtime Context carries the mechanisms and trusted resources used to execute that task.

## Runtime Context is host-owned

Framework and provider integrations construct Runtime Context at generated host boundaries. A custom route passes the equivalent values explicitly because `runAgent()` does not read framework globals.

| Value | Purpose |
| --- | --- |
| `runtime` and `platform` | Identify the active runtime and platform. |
| `memo` | Resolve one value once within the current execution boundary. |
| `waitUntil` | Continue background work after the immediate handler returns. |
| Provider context | Expose trusted host resources such as bindings. |
| `trace` and `traceLog` | Preserve trace identity and record structured behavior. |

Runtime Context should contain execution facts and trusted resources. Put portable behavior in Definitions, task data in invocation input, and deployment artifacts in Provider Output.

## Runtime Context and Capabilities are different

A Runtime Capability handle carries a resolved implementation between packages. An Agent Capability grants selected model-facing abilities to one Agent Definition. A Capability can use a Runtime Context handle without exposing the context itself to the model.

## Inspect the handoff

Inspect the generated route or custom server call that starts the operation. It should show which host owns `runtime`, `memo`, `waitUntil`, provider resources, and trace continuity, while the Definition and invocation input remain host-independent.

Read [Runtime events](/docs/reference/runtime-events) for the records carried through Runtime Context and [Agent Invocations](/docs/concepts/agent-invocations) for the request boundary.
