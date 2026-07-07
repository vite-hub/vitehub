---
title: Runtime events
description: Reference runtime event, policy, approval, stream, and usage records across ViteHub packages.
navigation.order: 55
icon: i-lucide-activity
---

Runtime events describe what happened across package boundaries.
The Runtime Package owns Trace Events, Policy Decisions, Approval Requests, runtime capability handles, and wait-until behavior.

## Trace Event

`TraceEvent` is the shared observability event shape.
It can describe policy, approval, capability, error, lifecycle, or run activity.

```ts [@vite-hub/runtime]
interface TraceEvent {
  attributes?: Record<string, unknown>
  name: string
  timestamp?: Date | string
  trace?: {
    id: string
    parentId?: string
    sampled?: boolean
  }
  type: 'approval' | 'capability' | 'error' | 'lifecycle' | 'policy' | 'run'
}
```

## Runtime lifecycle hooks

Runtime lifecycle hooks are host-provided callbacks for observing shared runtime behavior.
They do not replace package-owned hooks such as Agent Finish Hooks.

| Hook | Payload |
| --- | --- |
| `request` | Runtime Host Context before work starts. |
| `approval` | Approval Request and runtime context. |
| `trace` | Trace Event and runtime context. |
| `error` | Error and runtime context. |
| `finish` | Runtime Host Context after work finishes. |

## Policy and approvals

Policy Decisions are runtime outcomes, not generic booleans.
An Approval Request is created only when policy requires external approval.

| Value | Meaning |
| --- | --- |
| `allow` | Continue the operation. |
| `deny` | Stop the operation. |
| `require-approval` | Stop until an Approval Decision permits execution. |
| `retryable-failure` | Treat the operation as failed but retryable. |

## Agent stream events

Agent stream output is package-owned Agent behavior.
The current event stream includes text deltas, data parts, tool input and result events, progress events, approval events, errors, finish events, and usage events.

| Event family | Use |
| --- | --- |
| `text-delta` | Stream assistant text. |
| `tool-call` and `tool-result` | Represent model-facing tool execution. `tool-result.durationMs` can report elapsed tool time. |
| `progress` | Represent non-tool runtime progress such as `workspace.prepare`. |
| `approval-request` and `approval-decision` | Represent approval-shaped tool policy. |
| `error` | Represent recoverable or terminal stream errors. |
| `finish` | Mark completion. |
| `usage` | Carry an Agent Usage Record when telemetry is attached. |

## Agent Usage Record

Agent Usage Records normalize usage across model-backed, harness-backed, and custom-run-backed Agent Drivers when usage exists.
Token fields appear only when the provider reports them or ViteHub can derive them safely.

## Related

- [Agent Evals](/docs/development/agent-evals)
- [DevTools](/docs/development/devtools)
- [Errors and diagnostics](/docs/reference/errors-diagnostics)
