---
title: Papercuts
description: Let an Agent report small failures and wasted work to an application-owned sink.
navigation.title: Papercuts
navigation.order: 127
navigation.group: External context
icon: i-lucide-bandage
---

`papercuts()` gives the Agent a `report_papercut` tool. The Agent records small, non-blocking friction and then continues the user's task.
It does not wrap a Server Primitive. Your application owns storage and review through a `report` callback or a `backend`.
With `cli: true`, the Agent also receives a `papercuts report` Capability CLI command.

## Configure papercut reports

Pass a callback that writes each report to your store:

```ts [server/agents/support.ts]
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

To send reports to PostHog, pass the built-in backend instead of a callback:

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

This definition is resolved from the real Capability during the docs build.

::agent-capability-tools{name="papercuts"}
::

## How papercut reports work

ViteHub trims the message and rejects empty text or more than 1,000 characters.
It then creates a `Papercut` with an ID, a timestamp, and the Agent, run, and trace metadata of the current invocation.

With `report`, ViteHub awaits the callback. A rejected callback fails the tool call.
With `backend`, delivery is best effort. ViteHub tries up to 3 times with exponential backoff that starts at 100 ms. If all attempts fail, the tool call still succeeds. By default, a backend also skips a report when the same run already reported the same message.

When both are set, `report` is used and `backend` is ignored.

### Report contract

Each `PapercutReportEvent` contains the Capability runtime context and a `papercut` value. The Capability fills these fields:

```ts
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

The type also has optional `title`, `description`, `severity`, `category`, `consoleUrl`, `sourceMetadata`, and `reproduction` fields for custom backends.
The tool returns only `{ id, reported: true }`. Generic telemetry records the tool's owning `capability.id`, timing, and outcome. It does not add the papercut message to telemetry attributes.

### Durable delivery

`createPapercutReporter()` from `vite-hub/agent/capabilities` journals each report in persistent Agent Invocations before delivery. It replays pending reports after a restart, so delivery is at least once. The destination must deduplicate on the stable delivery `uuid`.
Pass `report: event => reporter.report(event)` to `papercuts()`, call `reporter.start()` when the server starts, and await `reporter.stop()` on shutdown.

### Tell the Agent when to report

Add a Capability directive to Agent Driver Instructions. ViteHub warns when a configured model-facing Capability has no instruction coverage.

```md [server/agents/support/instructions.md]
::capability{key="papercuts"}
Report unexpected failures, stale or missing guidance, and wasted turns when they happen. Continue the user's task after a non-blocking report.
::
```

## Requirements

`papercuts()` requires a `report` callback or a `backend` with a `report` function.
`cli` must be a boolean when set.
`posthogPapercuts()` requires an `apiKey`.

## Security and approval

The Agent can only send a short text message. It cannot read earlier reports or choose the destination.
The tool description asks the Agent to leave out secrets and customer data, but ViteHub does not filter the message content. Apply your own retention and access policy in the store.
`papercuts()` has no `policy` option. Reports run without an approval step.
`posthogPapercuts()` sends the full `Papercut` as PostHog event properties.

## Driver support

| Agent Driver | Support |
| --- | --- |
| Model-backed | Receives `report_papercut`. |
| Provider-backed | Receives `report_papercut` through the private MCP bridge. |
| Custom-run-backed | Receives the tool in the prepared run context; `driver.run` decides whether to call it. |

With `cli: true`, ViteHub exposes the `papercuts` CLI to compatible Agent Drivers and the Agent Dev Loop. See [Add a Capability CLI](/docs/capabilities/custom-capabilities#add-a-capability-cli).

## Verify papercut reports

Run `vitehub agent info --agent <name> --json` and confirm that `tools` contains a `papercuts` entry. Entries use the Capability id, not the tool name.
Ask the Agent to report one papercut, then confirm that your store or PostHog project received a record with the same `id` that the tool returned.

## Options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `report` | `(event) => void \| Promise<void>` | none | Stores each report. A rejection fails the tool call. Required unless `backend` is set. |
| `backend` | `PapercutBackend` | none | Best-effort delivery target, such as `posthogPapercuts()`. Used only when `report` is not set. |
| `retry.attempts` | `number` | `3` | Backend delivery attempts. |
| `retry.delayMs` | `number` | `100` | First backend retry delay in milliseconds. Each retry doubles it. |
| `dedupe` | `boolean` | `true` | Skips repeated backend reports with the same message in the same run. |
| `cli` | `boolean` | `false` | Adds the `papercuts report <message>` Capability CLI command. |

### `posthogPapercuts()` options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `apiKey` | `string` | required | Sent as the `Authorization` bearer token, and as the project key unless `projectApiKey` is set. |
| `projectApiKey` | `string` | `apiKey` | PostHog project API key for the `api_key` field. |
| `host` | `string` | `"https://us.i.posthog.com"` | PostHog host. ViteHub posts to `<host>/capture/`. |
| `distinctId` | `string` | Agent name, then `"vitehub-agent"` | PostHog `distinct_id`. |
| `fetch` | `typeof fetch` | `globalThis.fetch` | Custom fetch implementation. |

## Related pages

- [OTLP](/docs/capabilities/otlp)
- [Agent instructions](/docs/agents/instructions)
- [Observability](/docs/agents/observability)
- [Custom capabilities](/docs/capabilities/custom-capabilities)
- [Official capabilities](/docs/capabilities/official-capabilities)
