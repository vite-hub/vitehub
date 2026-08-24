---
title: OTLP
description: Export live Agent Invocation events and completed traces to an OpenTelemetry receiver.
navigation.title: OTLP
navigation.order: 125
navigation.group: External context
icon: i-lucide-activity
---

`otlp()` exports Agent Invocation telemetry using OTLP/HTTP JSON. It is a transport Capability, so the same Agent Definition works with any receiver that accepts ordinary OpenTelemetry logs and traces.

## Configuration

Import the Capability from `@vite-hub/agent/capabilities` and pass the receiver's OTLP base endpoint. ViteHub appends the conventional `/v1/logs` and `/v1/traces` signal paths.

```ts [server/agents/support.ts]
import { defineAgent } from '@vite-hub/agent'
import { otlp } from '@vite-hub/agent/capabilities'

export default defineAgent({
  capabilities: [
    otlp({
      endpoint: process.env.OTLP_ENDPOINT!,
      headers: {
        authorization: `Bearer ${process.env.OTLP_TOKEN!}`,
      },
      resource: {
        'service.namespace': 'support',
      },
      live: true,
    }),
  ],
  driver: { model: 'openai/gpt-5.1-mini' },
  name: 'support',
})
```

## Trace contract

ViteHub always exports one completed trace. Its ordinary OTLP spans carry structural timing and `gen_ai.*` attributes. Without `live`, the root span also contains the invocation's Trace Events, including one `vitehub.agent.configured` event with sanitized Agent Definition metadata: Agent identity, Capability metadata, Driver and model identity when resolved, tool names, runtime, and Workspace name, mode, and Sources.

With `live: true`, each Trace Event is exported once as a correlated OTLP LogRecord while the invocation runs. LogRecords use the same trace and span IDs as the completed trace and carry `agent.invocation.id` plus `vitehub.event.sequence` for deduplication. ViteHub batches for up to five seconds or 512 new Trace Events, whichever comes first, and flushes immediately when the invocation ends. After all records are delivered, the completed trace omits span events because those events were already sent as logs. If a live batch fails, the completed trace retains its span events so the terminal export does not lose that evidence.

This is append-only export, not polling: ViteHub never resends an evolving in-progress span snapshot. OTLP's HTTP and gRPC exports are request/response protocols, so ViteHub does not add a receiver-specific SSE or WebSocket channel.

The configuration event is not a user message. User prompts and model or tool content remain governed by trace content policy and are metadata-only in this exporter.

Agent instructions are prompt content, so they are excluded by default. Opt in explicitly when the receiver is trusted:

```ts
otlp({
  endpoint: process.env.OTLP_ENDPOINT!,
  content: {
    inputs: true,
    instructions: true,
    outputs: true,
  },
})
```

Secret-shaped Capability metadata keys are replaced with `[redacted]`. Keep receiver credentials in `headers`; `otlp()` does not expose its endpoint or headers in Agent metadata.

## Custom Capability metadata

Every Capability contributes its public `metadata` automatically. A custom Capability can add invocation-resolved facts without knowing which exporter is installed:

```ts
import { defineCapability } from '@vite-hub/agent'

export const repository = defineCapability({
  id: 'repository',
  metadata: { provider: 'github' },
  async resolve(context) {
    const installation = await resolveInstallation(context)
    context.telemetry.metadata({ installation: installation.slug })
  },
})
```

This contribution belongs to the Capability's entry in the configuration event. It does not create another invocation stream or require a receiver-specific integration.

## Delivery behavior

The exporter retries transient HTTP failures and honors `Retry-After`. Export is best effort and runs through the host's `waitUntil()` boundary; an unavailable receiver does not change Agent output. Receiver failures produce a bounded structured local error with the Capability ID, invocation ID, run ID, and export phase. Receivers should deduplicate spans by trace and span ID, and live records by `agent.invocation.id` plus `vitehub.event.sequence`, because a retry can repeat a request.

Streaming command output remains trace activity, not a log drain. Provider command start, output deltas, and completion use the same tool-call ID so a session UI can group them without inspecting terminal escape sequences.

## Options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `endpoint` | `string` | Required | Absolute OTLP base endpoint. ViteHub appends `/v1/logs` and `/v1/traces`. |
| `headers` | `Record<string, string>` or resolver | None | Request headers resolved for each export. |
| `resource` | OTLP resource attributes or resolver | Agent and runtime defaults | Additional resource attributes. |
| `content.inputs` | `boolean` | `false` | Includes user and tool input content in exported telemetry. |
| `content.instructions` | `boolean` | `false` | Includes resolved Agent instructions in the configuration telemetry. |
| `content.outputs` | `boolean` | `false` | Includes assistant, tool, and result output content in exported telemetry. |
| `live` | `boolean` | `false` | Sends append-only Trace Events as correlated OTLP logs while the invocation runs. |
