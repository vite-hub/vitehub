---
title: Papercuts
description: Let an Agent report small runtime and developer-experience friction to an application-owned sink.
navigation.title: Papercuts
navigation.order: 220
navigation.group: Decisions and output
icon: i-lucide-message-square-warning
---

`papercuts()` adds the `report_papercut` tool to an Agent.
Use it to capture small, non-blocking friction while the details are still available to the current Agent Invocation.

The Capability owns the reporting contract and provenance.
Your application owns persistence, redaction, retention, deduplication, and triage.

## Installation

Import the Capability factory from `@vite-hub/agent/capabilities` and add it to `defineAgent({ capabilities })`.
Provide a `report` callback that accepts each papercut before the tool reports success.

## What it adds

The Capability always adds `report_papercut`.
The tool accepts one trimmed message between 1 and 1000 characters and asks the Agent to describe what it was doing and what got in the way.

Each report includes an id, creation time, source, and available Agent, run, and trace provenance.
The callback also receives the current Capability runtime context for application-specific routing.

## Configuration

Persist the normalized `papercut` record and use `context` only when the sink needs invocation-specific information.

```ts [server/agents/support.ts]
import { defineAgent } from '@vite-hub/agent'
import { papercuts } from '@vite-hub/agent/capabilities'

export default defineAgent({
  driver: { model },
  capabilities: [
    papercuts({
      async report({ papercut, context }) {
        await savePapercut({
          ...papercut,
          actorId: context.actor.id,
        })
      },
    }),
  ],
})
```

Do not serialize the runtime `context` wholesale.
It is invocation-scoped and may contain request, actor, Workspace, or application values that do not belong in a papercut record; `workspace` and `fs` are absent on Agents without a Workspace.

## Add the Capability CLI

Set `cli: true` when agents and developers should also have a command-shaped reporting surface.
This adds the fixed `papercuts report` command without replacing `report_papercut`.

```ts [server/agents/support.ts]
papercuts({
  cli: true,
  report: ({ papercut }) => savePapercut(papercut),
})
```

Run the command through the Agent Dev Loop.

```bash [Terminal]
pnpm vitehub agent dev --agent support --cli papercuts -- report "The retry hid the original error."
```

Successful command output is `Papercut reported.`

## Runtime behavior

ViteHub trims and validates the message, generates the record, and awaits `report`.
The tool returns `{ reported: true, id }` only after the sink accepts the report; callback errors fail the tool call instead of returning a false success.

The normalized record contains:

| Field | Description |
| --- | --- |
| `id` | Generated `papercut_` identifier. |
| `createdAt` | ISO timestamp created when the report is submitted. |
| `message` | Trimmed report text. |
| `source` | `"tool"` or `"cli"`. |
| `agent` | Agent identity when the host provides one. |
| `run` | Agent Run metadata, including `runId`, when available. |
| `trace` | Runtime Trace Context when available. |

Attaching the Capability grants access to the developer-provided reporting sink, so `papercuts()` does not add an approval policy.
It does not provide a `when` option; attach the Capability only to Agent Definitions that should report papercuts.

## Requirements

`papercuts({ report })` requires a report callback.
The callback should complete only after its destination accepts the record.

The tool description tells the Agent not to include secrets or customer data, but the sink still owns redaction and data handling appropriate to the application.

## Driver support

| Agent Driver | Support |
| --- | --- |
| Model-backed | Receives `report_papercut` and the optional `papercuts` Capability CLI tool. |
| Provider-backed | Receives the same Capability tools through the Provider Agent tool bridge. |
| Custom-run-backed | Receives resolved tools in the run context; `driver.run` decides whether to call them. |

## Inspect and verify

Run one Agent Invocation that encounters obvious friction and inspect the `report_papercut` call and normalized sink record.
When `cli` is enabled, run `papercuts report` through the Agent Dev Loop and confirm the same sink receives a report with `source: "cli"`.

## Options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `report` | `(event: PapercutReportEvent) => void \| Promise<void>` | required | Application-owned sink for the normalized papercut and current Capability runtime context. |
| `cli` | `boolean` | `false` | Adds the fixed `papercuts report` Capability CLI while keeping `report_papercut`. |

## Reference

- [Agent Evals](/docs/agents/evals)
- [Custom capabilities](/docs/capabilities/custom-capabilities)
- Source: `packages/agent/src/capabilities/papercuts.ts`
