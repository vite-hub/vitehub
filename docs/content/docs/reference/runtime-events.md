---
title: Runtime events
description: The event, policy, approval, stream, and usage records that ViteHub packages share.
navigation.order: 57
navigation.group: Runtime and output
icon: i-lucide-activity
---

Runtime events record what happened across ViteHub packages. `@vite-hub/runtime` owns them, with capability handles and wait-until behavior. [Runtime Context](/docs/reference/runtime-context) carries them.

## Trace Event

`TraceEvent` is the shared event shape for logs and traces. It describes policy, approval, capability, error, lifecycle, or run activity.

```ts [@vite-hub/runtime]
interface TraceEvent {
  activity?: {
    owner: 'agent' | 'vitehub'
    phase: 'setup' | 'execution' | 'delivery' | 'teardown'
  }
  attributes?: Record<string, unknown>
  name: string
  payload?:
    | { value: unknown, visibility: 'public' }
    | { summary: string, visibility: 'summary' }
    | { visibility: 'redacted' | 'private' }
  timestamp?: Date | string
  trace?: {
    id: string
    parentId?: string
    sampled?: boolean
  }
  type: 'approval' | 'capability' | 'error' | 'lifecycle' | 'policy' | 'run'
}
```

`activity` says who did the work, the Agent or ViteHub, and in which phase. For example, writing Workspace files is `vitehub/setup`, a tool call is `agent/execution`, and posting the result is `agent/delivery`. Trace logs also show them as `vitehub.activity.owner` and `vitehub.activity.phase` attributes.

Use the tagged `payload` field for structured detail. The code that emits the event must choose its visibility:

| Visibility | Trace behavior |
| --- | --- |
| `public` | Keeps `value` in metadata and content traces. Use only for data that is safe in every trace sink. |
| `summary` | Keeps only the `summary`. It accepts no raw value. |
| `redacted` | Records that the payload was hidden on purpose. |
| `private` | Records only the private marker. Malformed payloads fall back to this. |

`payload` does not change `attributes`, which stay metadata-only by default. A trusted sink still needs the content policy to get inputs or outputs.

ViteHub reads only own data properties of attributes and never calls getters. In metadata mode, this applies to nested objects and arrays too: content keys are recorded as omitted, and other accessors are skipped. Content mode keeps nested values as they are.

## Runtime lifecycle hooks

The host calls these hooks to let you observe the runtime. They do not replace package hooks such as Agent Finish Hooks.

| Hook | Payload |
| --- | --- |
| `request` | Runtime Host Context before work. |
| `approval` | Approval Request and runtime context. |
| `trace` | Trace Event and runtime context. |
| `error` | Error and runtime context. |
| `finish` | Runtime Host Context after work. |

## Policy and approvals

A Policy Decision is one of four outcomes, not a boolean. ViteHub creates an Approval Request only when the policy needs outside approval. No policy means `allow`.

| Value | Meaning |
| --- | --- |
| `allow` | Continue the operation. |
| `deny` | Stop the operation. |
| `require-approval` | Stop until an Approval Decision allows it. |
| `retryable-failure` | Fail, but allow a retry. |

## Agent stream events

`@vite-hub/agent` owns the Agent stream. It sends these events:

| Event family | Use |
| --- | --- |
| `text-delta` | Assistant text. |
| `tool-call` and `tool-result` | A model tool call. `tool-result.durationMs` can report tool time. |
| `progress` | Progress outside tools, such as `workspace.prepare`. |
| `approval-request` and `approval-decision` | A tool policy that needs approval. |
| `data-agent-input` | Provider questions as `{ requestId, questions, status: "requested" }`. Replies use `{ requestId, answers }`. |
| `error` | Recoverable or terminal stream errors. |
| `finish` | The run is done. |
| `usage` | An Agent Usage Record, when the Driver reports usage. |

## Agent Usage Record

An Agent Usage Record gives usage in one shape for every Agent Driver (the backend that runs the Agent), when the Driver reports usage. Token fields appear only when the provider reports them or ViteHub can derive them safely. Model, execution provider, and transport are separate fields. Cost is the provider's cost, or a best-effort estimate when the Usage Capability matches catalog pricing.

Streams send it as `{ type: "usage", usageRecord }`. At the end, read it from `event.invocation.usage` in an Agent Finish Hook, or `context.invocation.usage` in a Channel Delivery finish effect. Your app formats it for text, UI, notes, billing, or comments.

## Related

- [Agent Evals](/docs/agents/evals)
- [CLI inspection](/docs/cli)
- [Errors and diagnostics](/docs/reference/errors-diagnostics)
