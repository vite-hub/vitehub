---
title: schedule()
description: Declare Agent Schedules or expose Runtime Schedule tools to an Agent.
navigation.title: schedule()
navigation.order: 110
icon: i-lucide-calendar-clock
---

`schedule()` covers two schedule-related Agent abilities.
It can declare fixed Agent Schedules as Capability metadata, or it can expose Runtime Schedule read and edit tools when configured with a mode.

## What it adds

Static Agent Schedule mode records one or more five-field UTC cron expressions on the Capability.
Runtime Schedule mode contributes `schedule_read` and, in write mode, `schedule_edit`.

## Minimum attach example

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
Runtime Schedule mode reads visible Runtime Schedules and can create, update, enable, disable, or delete scoped schedules when write mode is enabled.

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
For Runtime Schedule mode, inspect the tool list and verify `schedule_edit` appears only in write mode.

Run a schedule with a six-field cron expression during development.
The Capability should reject it before the Agent starts.

## Reference

- [Schedule primitive](/docs/server-primitives/schedule)
- [Agent triggers](/docs/agents/triggers)
- Source: `packages/agent/src/capabilities/schedule.ts`
