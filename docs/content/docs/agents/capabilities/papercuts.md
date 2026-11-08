---
title: Papercuts
description: Let an Agent report small problems and wasted work to a store that your application owns.
navigation.title: Papercuts
navigation.order: 227
navigation.group: Capabilities
icon: i-lucide-bandage
---

`papercuts()` gives the Agent a `report_papercut` tool for papercuts: small problems that do not stop the work, such as a failed step or missing guidance. The Agent reports one and continues the task.

Your app stores reports through a `report` callback or a `backend`. No Server Primitive is wrapped. `cli: true` also adds a `papercuts report` Capability CLI command.

## Configure papercut reports

Pass a callback that stores each report:

```ts [server/agents/support.ts] fragment
import { defineAgent } from 'vite-hub/agent'
import { papercuts } from 'vite-hub/agent/capabilities'
import { reports } from '../storage/reports'

export default defineAgent({
  capabilities: [
    papercuts({
      report: event => reports.put(event.papercut.id, event.papercut),
    }),
  ],
  driver: { model: 'openai/gpt-5.1-mini' },
})
```

Or send them to PostHog with the built-in backend:

```ts [server/agents/support.ts]
import { defineAgent } from 'vite-hub/agent'
import { papercuts, posthogPapercuts } from 'vite-hub/agent/capabilities'

export default defineAgent({
  capabilities: [
    papercuts({
      backend: posthogPapercuts({ apiKey: process.env.POSTHOG_API_KEY! }),
    }),
  ],
  driver: { model: 'openai/gpt-5.1-mini' },
})
```

## Agent-visible tool contract

This comes from the real Capability at docs build time.

::agent-capability-tools{name="papercuts"}
::

## How papercut reports work

ViteHub trims the message and rejects it if empty or over 1,000 characters. It then creates a `Papercut` with an ID, timestamp, and the Agent, run, and trace metadata of the current Invocation (one Agent run).

Delivery:

- **`report`**: awaited. A rejection fails the tool call.
- **`backend`**: best effort, up to 3 tries with a delay that starts at 100 ms and doubles. If all fail, the call still succeeds. By default, it skips a message the same run already reported.

With both set, `report` wins.

### Report contract

Each `PapercutReportEvent` has the Capability runtime context and a `papercut` with these fields:

```ts
import type { TraceContext } from 'vite-hub/runtime'
import type { AgentRunMetadata } from 'vite-hub/agent'

interface Papercut {
  agent?: { name: string, workspace?: string }
  createdAt: string
  id: string
  message: string
  run?: AgentRunMetadata
  source: 'cli' | 'tool'
  trace?: TraceContext
}
```

Optional `title`, `description`, `severity`, `category`, `consoleUrl`, `sourceMetadata`, and `reproduction` fields serve custom backends.
The tool returns only `{ id, reported: true }`. Telemetry records the owning `capability.id`, timing, and result, never the message.

### Durable delivery

`createPapercutReporter()` from `vite-hub/agent/capabilities` saves each report to persistent Agent Invocations before delivery and resends pending ones after a restart, so each arrives at least once.

> [!NOTE]
> Reports can repeat. De-duplicate by the delivery `uuid`, which is stable across tries.

1. Pass `report: event => reporter.report(event)` to `papercuts()`.
2. Call `reporter.start()` when the server starts.
3. Await `reporter.stop()` when the server shuts down.

### Tell the Agent when to report

Add a Capability directive to the Driver Instructions so the model knows when to report. ViteHub warns when a tool has no covering instruction.

```md [server/agents/support/instructions.md]
::capability{key="papercuts"}
Report unexpected failures, stale or missing guidance, and wasted turns when they happen. Continue the user's task after a non-blocking report.
::
```

## Requirements

- A `report` callback or a `backend` with a `report` function.
- `cli`, when set, is a boolean.
- `posthogPapercuts()` needs an `apiKey`.

## Security and approval

The Agent only sends short text. It cannot read reports or pick the destination. There is no `policy` option, so reports need no approval.

> [!WARNING]
> The tool description forbids secrets and customer data, but ViteHub does not filter messages. Set retention and access rules in your store.

`posthogPapercuts()` sends the full `Papercut` as event properties.

## Driver support

| Agent Driver | Support |
| --- | --- |
| Model-backed | Receives `report_papercut`. |
| Provider-backed | Receives `report_papercut` through the private MCP bridge. |
| Custom-run-backed | Receives the tool in the run context. `driver.run` decides whether to call it. |

With `cli: true`, compatible Drivers and the Agent Dev Loop get the `papercuts` CLI. See [Add a Capability CLI](/docs/agents/capabilities/custom#add-a-capability-cli).

## Verify papercut reports

1. `vitehub agent info --agent <name> --json` has a `papercuts` entry in `tools` (keyed by Capability id, not tool name).
2. Report one papercut and find a record with the returned `id` in your store or PostHog.

## Options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `report` | `(event) => void \| Promise<void>` | none | Stores reports. A rejection fails the call. Required without `backend`. |
| `backend` | `PapercutBackend` | none | Best-effort target, such as `posthogPapercuts()`. Ignored when `report` is set. |
| `retry.attempts` | `number` | `3` | Backend delivery attempts. |
| `retry.delayMs` | `number` | `100` | First retry delay in milliseconds, doubled each retry. |
| `dedupe` | `boolean` | `true` | Skip repeated backend messages in one run. |
| `cli` | `boolean` | `false` | Add the `papercuts report <message>` CLI command. |

### `posthogPapercuts()` options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `apiKey` | `string` | required | `Authorization` bearer token, and project key unless `projectApiKey` is set. |
| `projectApiKey` | `string` | `apiKey` | Project key for the `api_key` field. |
| `host` | `string` | `"https://us.i.posthog.com"` | Posts to `<host>/capture/`. |
| `distinctId` | `string` | Agent name, then `"vitehub-agent"` | PostHog `distinct_id`. |
| `fetch` | `typeof fetch` | `globalThis.fetch` | Custom fetch implementation. |

## Related pages

- [OTLP](/docs/agents/capabilities/otlp)
- [Agent instructions](/docs/agents/instructions)
- [Observability](/docs/agents/observability)
- [Custom capabilities](/docs/agents/capabilities/custom)
- [Official capabilities](/docs/agents/capabilities/official)
