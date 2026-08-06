---
title: Runtime Context
description: Understand the host resources passed into a server operation or Agent request.
navigation.group: Runtime execution
navigation.order: 20
icon: i-lucide-waypoints
---

Runtime Context is the set of execution facts and trusted resources that a ViteHub operation receives from its host. It can include platform resources, request data, provider bindings, background work, memoization, and trace continuity.

Invocation input carries task data. Runtime Context carries the mechanisms used to run that task.

## Runtime Context comes from the host

Framework and provider integrations create Runtime Context in the generated route or handler. A custom server call passes the equivalent values explicitly because `runAgent()` does not read framework globals.

| Value | Used for |
| --- | --- |
| `runtime` and `platform` | Identifying the active runtime and platform. |
| `memo` | Resolving one value once in the current execution. |
| `waitUntil` | Continuing background work after the handler returns. |
| Provider context | Reading trusted host resources such as bindings. |
| `trace` and `traceLog` | Keeping trace identity and recording structured events. |

Keep portable behavior in Definitions, task data in invocation input, and deployment artifacts in Provider Output. Runtime Context is the handoff from the host to the operation.

## Runtime Context is not a Capability

A Runtime Capability handle carries a resolved implementation between packages. An Agent Capability grants a selected model-facing ability. A Capability can use Runtime Context without exposing the context itself to the model.

## Inspect the handoff

Inspect the generated route or custom server call that starts the operation. It should show which host supplies the runtime, background work, provider resources, and trace continuity.

Read [Runtime events](/docs/reference/runtime-events) for the records carried through Runtime Context and [Agent Invocations](/docs/concepts/agent-invocations) for the request record.
