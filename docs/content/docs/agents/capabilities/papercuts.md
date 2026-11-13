---
title: Papercuts
description: Let an Agent report small problems and wasted work to a store that your application owns.
navigation.title: Papercuts
navigation.order: 227
navigation.group: Capabilities
icon: i-lucide-bandage
---

`papercuts()` gives the Agent a `report_papercut` tool for papercuts: problems outside the Agent's control that cost it work, such as a missing tool or wrong guidance. The Agent reports one and continues the task. When a report repeats a recent one, ViteHub counts it and tells the Agent the problem is already known.

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
- **`backend`**: best effort, up to 3 tries with a delay that starts at 100 ms and doubles. If all fail, the call still succeeds.

With both set, `report` wins.

### Repeated reports

Agents often report the same problem many times, in different words, in one run and across runs. Before delivery, ViteHub compares the message with the papercuts that the same Agent reported in the last 7 days:

1. It lowercases the message and removes URLs, UUIDs, hashes, numbers, directory prefixes, and common words.
2. It compares the remaining terms with each known papercut. When at least 40% of the terms are shared (Dice similarity), the report is a repeat.
3. A repeat increments the count of the known papercut. ViteHub does not call `report` or `backend`, and the tool returns:

```json
{
  "id": "papercut_<id of the first report>",
  "reported": false,
  "count": 3,
  "since": "2026-11-05T09:12:44.000Z",
  "message": "Already known: 3 reports since 2026-11-05. Do not report it again. Continue the task."
}
```

A new report returns `{ id, reported: true }`. When delivery of a new report fails, ViteHub forgets it, so the next similar report is delivered.

The default index is in memory, one for each `papercuts()` call, so it resets when the server restarts. To keep counts in your own store, pass a `PapercutIndex` as `dedupe`. To deliver every report, set `dedupe: false`.

```ts
import type { Papercut } from 'vite-hub/agent/capabilities'

interface PapercutIndex {
  /** Count the papercut against a recent similar report, or remember it as new with `count: 1`. */
  record: (papercut: Papercut) => PapercutOccurrence | Promise<PapercutOccurrence>
  /** Forget a new report that was not delivered. */
  forget: (id: string) => void | Promise<void>
  /** Known papercuts, most reported first. */
  list: () => PapercutOccurrence[] | Promise<PapercutOccurrence[]>
}

interface PapercutOccurrence {
  id: string // first report
  message: string // first report
  fingerprint: string // sorted normalized terms
  agent?: string
  count: number
  firstReportedAt: string
  lastReportedAt: string
}
```

`createPapercutIndex({ windowMs, similarity, maxEntries })` creates the built-in index with other limits.

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
The tool returns `{ id, reported: true }`, or the repeat result above. Telemetry records the owning `capability.id`, timing, and result, never the message.

### Durable delivery

`createPapercutReporter()` from `vite-hub/agent/capabilities` saves each report to persistent Agent Invocations before delivery and resends pending ones after a restart, so each arrives at least once.

> [!NOTE]
> Reports can repeat. De-duplicate by the delivery `uuid`, which is stable across tries.

1. Pass `report: event => reporter.report(event)` and `dedupe: reporter.index` to `papercuts()`.
2. Call `reporter.start()` when the server starts.
3. Await `reporter.stop()` when the server shuts down.

`reporter.status()` has `known`, the number of distinct papercuts, and `repeats`, the reports counted instead of delivered. For a digest, read `reporter.index.list()` on your own schedule. Each entry has the first message, its `count`, and when it was first and last reported. ViteHub does not send digests.

### Tell the Agent when to report

Add a Capability directive to the Driver Instructions so the model knows when to report. ViteHub warns when a tool has no covering instruction.

```md [server/agents/support/instructions.md]
::capability{key="papercuts"}
Report a tool, command, or permission that failed outside your control, and guidance that is missing or wrong. Do not report your own mistakes or expected results. When the result says the problem is already known, do not report it again. Continue the user's task after a report.
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
| `dedupe` | `boolean \| PapercutIndex` | `true` | Count repeats of a recent similar report instead of delivering them. `true` uses an in-memory index. |
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
