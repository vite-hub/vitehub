---
title: Papercuts
description: Let an Agent report small failures and wasted work to an application-owned sink.
navigation.title: Papercuts
navigation.order: 127
navigation.group: External context
icon: i-lucide-bandage
---

`papercuts()` adds a `report_papercut` tool. The Agent can record non-blocking friction while it continues the user's task. Your application owns storage and review.

## Agent-visible tool contract

This definition is resolved from the real Capability during the docs build.

::agent-capability-tools{name="papercuts"}
::

## Store reports

Pass a callback that writes each report to your preferred store:

```ts [server/agents/support.ts]
import { defineAgent } from '@vite-hub/agent'
import { papercuts } from '@vite-hub/agent/capabilities'
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

ViteHub awaits `report`. A rejected callback fails the tool call, so use a durable application-owned adapter when losing a report is unacceptable.

## Tell the Agent when to report

This Capability is model-facing and requires instruction coverage. Add a Capability directive to Agent Driver Instructions:

```md [server/agents/support/instructions.md]
::capability{key="papercuts"}
Report unexpected failures, stale or missing guidance, and wasted turns when they happen. Continue the user's task after a non-blocking report.
::
```

The tool description asks for one or two sentences and forbids secrets or customer data. ViteHub trims the message and rejects empty text or more than 1,000 characters. Applications should still apply their own retention and access policy.

## Report contract

Each `PapercutReportEvent` contains the Capability runtime context and a `papercut` value:

```ts
interface Papercut {
  agent?: { name: string, workspace?: string }
  createdAt: string
  id: string
  message: string
  run?: AgentRunMetadata
  source: 'tool'
  trace?: TraceContext
}
```

The tool returns only `{ id, reported: true }`. Generic telemetry records the tool's owning `capability.id`, timing, and outcome. It does not add the papercut message to telemetry attributes.

## Related

- [OTLP](/docs/capabilities/otlp)
- [Agent instructions](/docs/agents/instructions)
- [Custom capabilities](/docs/capabilities/custom-capabilities)
