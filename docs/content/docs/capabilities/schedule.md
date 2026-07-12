---
title: Schedule
description: Declare Agent Schedules or let an Agent manage Runtime Schedules through one cronjob tool.
navigation.title: Schedule
navigation.order: 110
navigation.group: Runtime primitives
icon: i-lucide-calendar-clock
---

`schedule()` covers two schedule-related Agent abilities.
It can declare fixed Agent Schedules as Capability metadata, or it can expose one `cronjob` tool for Runtime Schedules when configured with a mode.

## Installation

Import the Capability factory from `@vite-hub/agent/capabilities` and add it to `defineAgent({ capabilities })`.
Use the configuration example below as the starting point, then tighten modes, policies, stores, and providers for the Agent boundary.

## What it adds

Static Agent Schedule mode records one or more five-field UTC cron expressions on the Capability.
Runtime Schedule mode contributes one `cronjob` tool. Read mode supports `targets`, `list`, and `get`. Write mode also supports `create`, `edit`, `pause`, `resume`, `run`, and `delete`.

## Configuration

Use static schedules when the Agent should run on known cron entries.
ViteHub derives a stable id from the cron expression when you do not provide one.

```ts [server/agents/support.ts]
import { defineAgent } from '@vite-hub/agent'
import { schedule } from '@vite-hub/agent/capabilities'

export default defineAgent({
  driver: { model },
  capabilities: [
    schedule({
      schedules: ['0 9 * * 1'],
    }),
  ],
})
```

## Runtime behavior

Static schedules add metadata that framework integrations and schedule-aware runtime behavior can inspect.
Runtime Schedule mode reads visible Runtime Schedules and can create, edit, pause, resume, run, or delete scoped schedules when write mode is enabled. The `cronjob` tool accepts an optional IANA `timeZone` on create and edit, while schedules without one continue to use UTC.

## Requirements

Static schedules require at least one five-field UTC cron expression.
Runtime Schedule mode requires a configured `schedule` primitive.

Runtime Schedule edits require write mode and approval by default.
Self-targeting requires explicit self-target permission.

## Driver support

| Agent Driver | Support |
| --- | --- |
| Model-backed | Receives Runtime Schedule tools when mode is configured; static schedules are runtime metadata. |
| Harness-backed | Runtime metadata and requirements apply; model-facing schedule tools are not passed by default. |
| Custom-run-backed | Receives prepared metadata and context; `driver.run` decides how to use schedule context. |

## Inspect and verify

Inspect Capability metadata for static schedule ids and cron expressions.
For Runtime Schedule mode, inspect the tool list and verify it contains only `cronjob` for scheduling. Its schema exposes only read operations in read mode.

Run a schedule with a six-field cron expression during development.
The Capability should reject it before the Agent starts.

## Options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `schedules` | `Array<string \| { cron: string; id?: string }>` | required for Agent Schedules | Declares fixed five-field UTC Agent Schedules. |
| `mode` | `"read" \| "write"` | required for Runtime Schedule tools | Selects read or write Runtime Schedule tools. |
| `targets` | `string[]` | all visible targets | Allowlist of Runtime Schedule target names. |
| `selfTarget` | `string` | none | Target name of the owning Agent. |
| `allowSelfTarget` | `boolean` | `false` | Allows Runtime Schedule tools to target the owning Agent. |
| `policy` | `AgentToolPolicyDecision \| function` | `"require-approval"` | Policy for mutating `cronjob` operations. Read operations remain allowed. |

## Reference

- [Schedule primitive](/docs/server-primitives/schedule)
- [Agent triggers](/docs/agents/triggers)
- Source: `packages/agent/src/capabilities/schedule.ts`
