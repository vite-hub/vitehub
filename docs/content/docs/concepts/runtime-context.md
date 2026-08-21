---
title: Runtime Context
description: Understand the host resources passed into a server operation or Agent request.
navigation.order: 20
icon: i-lucide-waypoints
---

Runtime Context contains the trusted host resources available to one ViteHub operation. It can include platform resources, request data, provider bindings, background work, memoized values, and trace information.

Invocation input describes the task. Runtime Context provides the host resources needed to run it.

## Runtime Context comes from the host

Framework and provider integrations create Runtime Context in the generated route or handler. A custom server call passes the same values itself because `runAgent()` does not read framework globals.

| Value | Used for |
| --- | --- |
| `runtime` and `platform` | Identifying the active runtime and platform. |
| `memo` | Resolve one value once during the current execution. |
| `waitUntil` | Continue background work after the handler returns. |
| Provider context | Reading trusted host resources such as bindings. |
| `trace` and `traceLog` | Keeping trace identity and recording structured events. |

Keep reusable behavior in Definitions and task data in invocation input. Runtime Context passes host resources to the operation.

## Runtime Context is not a Capability

A Runtime Capability handle passes an implementation between packages. An Agent Capability gives an Agent a selected ability. It can use Runtime Context without exposing that context to the model.

## Inspect the handoff

Inspect the generated route or custom server call that starts the operation. It shows which host supplies the runtime, background work, provider resources, and trace information.

Read [Runtime events](/docs/reference/runtime-events) for the records carried through Runtime Context and [Agent Invocations](/docs/concepts/agent-invocations) for the request record.
