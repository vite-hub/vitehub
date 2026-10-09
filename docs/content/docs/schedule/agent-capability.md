---
title: Schedule capability
description: Declare Agent Schedules or let an Agent manage Runtime Schedules through one cronjob tool.
navigation.title: Agent capability
navigation.order: 5
icon: i-lucide-calendar-clock
---

`schedule()` has two forms. With `schedules`, it declares fixed Agent Schedules as Capability metadata and adds no tool. With `mode`, it gives the Agent one `cronjob` tool for Runtime Schedules.
The `cronjob` tool calls the Runtime Schedule client of the configured [Schedule primitive](/docs/schedule).
The [Schedule server API](/docs/schedule/server-api) covers application code. This page covers the Agent tool.

## Configure schedules

Use static schedules to run the Agent on known cron entries.
ViteHub derives a stable id from the cron expression when you do not provide one.

```ts [server/agents/support.ts]
import { defineAgent } from 'vite-hub/agent'
import { schedule } from 'vite-hub/agent/capabilities'

export default defineAgent({
  driver: { model },
  capabilities: [
    schedule({
      schedules: ['0 9 * * 1'],
    }),
  ],
})
```

To let the Agent read or manage Runtime Schedules, set `mode`. Use `targets` to limit the Schedule Targets that the Agent can see and use.

```ts [server/agents/support.ts]
schedule({ mode: 'write', targets: ['reports'], policy: 'require-approval' })
```

The two forms use different options. To use both, add two `schedule()` Capabilities.

To let an Agent create recurring turns for itself, enable self-targeting. ViteHub derives the target from the discovered Agent name and stores the prompt with a metadata-free copy of the resolved invoker identity. Every run passes through the Agent's normal Capability policies and `agent:input` hooks again. When `invoker.resolve` is configured, ViteHub also reruns it and continues only when the resolved `id` and `kind` still match. Without a resolver, ViteHub restores the durable identity. It does not perform external authentication automatically.

```ts [server/agents/mini.ts]
import { defineAgent } from 'vite-hub/agent'
import { schedule } from 'vite-hub/agent/capabilities'

export default defineAgent({
  driver: { model },
  capabilities: [
    schedule({
      allowSelfTarget: true,
      delivery: 'origin',
      mode: 'write',
      timeZone: 'Asia/Bangkok',
    }),
  ],
})
```

The Agent can now create a cron job with a `prompt`, such as a daily report. Only an Agent Invocation with the same resolved invoker `id` and `kind` can inspect or manage that scheduled turn. `delivery: 'origin'` sends the result back to the Channel thread where the schedule was created.

## Agent-visible tool contract

Runtime Schedule mode adds one tool, `cronjob`. Its `operation` field selects the action and defaults to `list`. The input schema lists only the operations that the configured mode allows.

| Operation | Mode | Input | Result |
| --- | --- | --- | --- |
| `targets` | read | none | `{ targets }`: the `targets` allowlist plus the self target when allowed. `targets` is `undefined` when no allowlist is set. |
| `list` | read | none | Visible Runtime Schedules. |
| `get` | read | `id` | One visible Runtime Schedule, or `undefined`. |
| `create` | write | `cron` and `target`, or `cron` and `prompt` for a self-scheduled turn. Optional `id`, `enabled`, `timeZone`. | The created schedule. |
| `edit` | write | `id`. Optional `cron`, `enabled`, `target` or `prompt`, `timeZone`. | The updated schedule. |
| `pause`, `resume` | write | `id` | The disabled or enabled schedule. |
| `run` | write | `id` | The result of the run. |
| `delete` | write | `id` | The result of the delete. |

Returned schedules do not include the stored `input`. For a scheduled Agent turn, the result shows its `prompt`.

## How schedules work

Static schedules add `{ kind: 'schedule', schedules: [{ cron, id }] }` metadata that framework integrations and schedule-aware runtime behavior can inspect. Each cron must have five fields and is evaluated in UTC. A derived id replaces non-alphanumeric runs with `-`. For example, `0 9 * * 1` becomes `schedule-0-9-1`.

Runtime Schedule mode adds a Capability with id `runtime-schedule`:

- `cronjob` shows only records that pass the scope checks. A record must use an allowed target. A scheduled Agent turn must also belong to the current invoker `id` and `kind`.
- `edit`, `pause`, `resume`, `run`, and `delete` load the record first and fail when it is outside the scope.
- `edit` can change the `prompt` only of a scheduled Agent turn, and it cannot retarget a scheduled Agent turn.
- A self-scheduled turn targets `agent/<name>`. Creating it requires `allowSelfTarget: true` and a discovered Agent name. A `target` equal to the owning Agent fails without a `prompt`.
- With `delivery: 'origin'`, creating a self-scheduled turn requires a `channelId` and `threadId` from a named run origin, and the `channelId` must match a configured Agent Channel.
- The `cronjob` tool is not available inside a scheduled Agent turn.

The `cronjob` tool accepts an optional IANA `timeZone` on create and edit. Schedules without one use UTC. A configured `timeZone` provides the default for new schedules. Edits change it only when the tool supplies a new value.

## Requirements

- Static schedules require at least one five-field cron expression. Entries accept only `cron` and `id`. Duplicate ids in one Capability fail.
- Runtime Schedule mode requires a `schedule` runtime handle. Generated Agent routes provide `{ schedules }` when the Schedule integration is active. Without a handle, tool resolution fails with `Capability "schedule" requires the schedule primitive to be configured.`
- The Runtime Schedule client must expose `get()` and `list()` in read mode. Write mode also requires `create()`, `update()`, `delete()`, `enable()`, `disable()`, and `run()`.
- Runtime Schedules still require a provider wake or a long-running Schedule runner to execute when due.

## Security and approval

- Read mode allows only `targets`, `list`, and `get`. A write operation in read mode fails with `cronjob <operation> requires Schedule Capability write mode.`
- `targets` limits which targets the Agent can read, create, and edit. Without `targets`, the Agent can use any target name except the owning Agent.
- Targeting the owning Agent requires `allowSelfTarget: true` (Self Schedule Permission).
- Scheduled Agent turns are private to the invoker that created them.
- `policy` applies only to mutating operations: `create`, `edit`, `pause`, `resume`, `run`, and `delete`. Read operations always run.
- `policy` accepts `'allow'`, `'require-approval'`, `'deny'`, `'retryable-failure'`, or a function that receives `{ name, input }` and returns one of these values.
- Without `policy`, mutations run when the Agent calls them.
- `'require-approval'` stops the call with `APPROVAL_REQUIRED` and an Approval Request. See [Runtime policy, approvals, and traces](/docs/agents/runtime-policy).

## Driver support

| Agent Driver | Support |
| --- | --- |
| Model-backed | Receives `cronjob` when `mode` is set. Static schedules add no tool. |
| Provider-backed | Receives `cronjob` through the provider MCP bridge when `mode` is set. Static schedules add no tool. |
| Custom-run-backed | `driver.run` receives `cronjob` in `context.tools` when `mode` is set and decides whether to call it. |

## Verify schedules

1. Start the Vite development server.
2. Run `vitehub agent info --agent support --json`.
3. For static schedules, confirm that `capabilities` contains `{ id: "schedule", metadata: { kind: "schedule", schedules: [...] } }` with the expected ids and cron expressions.
4. For Runtime Schedule mode, confirm that `capabilities` contains `{ id: "runtime-schedule" }` with the expected `mode`, `targets`, and `allowSelfTarget`, and that `tools` contains an entry with `name: "runtime-schedule"`.
5. Pass a six-field cron expression to `schedule({ schedules })`. Confirm that the Agent Definition fails to load.

## Options

Static Agent Schedules:

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `schedules` | `Array<string \| { cron: string; id?: string }>` | required | Declares fixed five-field UTC Agent Schedules. |

Runtime Schedule tool:

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `mode` | `"read" \| "write"` | required | Selects the Runtime Schedule form and the allowed `cronjob` operations. |
| `targets` | `string[]` | any target except the owning Agent | Allowlist of Runtime Schedule target names. |
| `allowSelfTarget` | `boolean` | `false` | Lets the Agent create scheduled turns for itself. ViteHub derives the target from the discovered Agent name. |
| `delivery` | `"origin"` | none | Delivers a scheduled Agent turn to the Channel thread where it was created. Requires `allowSelfTarget: true`. |
| `timeZone` | `string` | none (UTC fallback) | Default IANA time zone for Runtime Schedules created by the tool. |
| `policy` | `AgentToolPolicyDecision \| (context) => AgentToolPolicyDecision \| Promise<AgentToolPolicyDecision>` | none (calls run) | Policy for mutating `cronjob` operations. Read operations always run. |

## Related pages

- [Schedule primitive](/docs/schedule)
- [Agent triggers](/docs/agents/triggers)
- [Channel delivery](/docs/channels/agent-capability)
- [Official capabilities](/docs/agents/capabilities/official)
