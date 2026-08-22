---
title: OTLP
description: Export Agent Invocation traces to an OpenTelemetry receiver.
navigation.title: OTLP
navigation.order: 125
navigation.group: External context
icon: i-lucide-activity
---

`otlp()` exports completed Agent Invocation traces using OTLP/HTTP JSON. It is a transport Capability, so the same Agent Definition works with a ViteHub session viewer, a general OpenTelemetry backend, or another product that understands the OpenTelemetry generative-AI conventions.

## Configuration

Import the Capability from `@vite-hub/agent/capabilities` and pass the receiver's complete traces endpoint.

```ts [server/agents/support.ts]
import { defineAgent } from '@vite-hub/agent'
import { otlp } from '@vite-hub/agent/capabilities'

export default defineAgent({
  capabilities: [
    otlp({
      endpoint: process.env.OTLP_TRACES_ENDPOINT!,
      headers: {
        authorization: `Bearer ${process.env.OTLP_TOKEN!}`,
      },
      resource: {
        'service.namespace': 'support',
      },
    }),
  ],
  driver: { model: 'openai/gpt-5.1-mini' },
  name: 'support',
})
```

## Trace contract

ViteHub exports ordinary OTLP spans and `gen_ai.*` attributes. It adds one `vitehub.agent.configured` event to the root span. That event carries sanitized Agent Definition metadata: Agent identity, Capability metadata, Driver and model identity when resolved, tool names, runtime, and Workspace name, mode, and Sources.

The configuration event is not a user message. User prompts and model or tool content remain governed by trace content policy and are metadata-only in this exporter.

Agent instructions are prompt content, so they are excluded by default. Opt in explicitly when the receiver is trusted:

```ts
otlp({
  endpoint: process.env.OTLP_TRACES_ENDPOINT!,
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

The exporter retries transient HTTP failures and honors `Retry-After`. Export is best effort and runs through the host's `waitUntil()` boundary; an unavailable receiver does not change Agent output. Receiver failures produce a bounded structured local error with the Capability ID, invocation ID, run ID, and export phase.

Set `live: true` when the receiver should see trace state while the invocation runs. Live delivery permits one request in flight and coalesces additional changes into one latest snapshot. It cannot build an unbounded request or memory backlog when the receiver is slow. The terminal snapshot supersedes stale live work and is always attempted after the active request settles. Receivers should deduplicate by trace ID and span ID because a retried or live request can contain spans seen previously.

Streaming command output remains trace activity, not a log drain. Provider command start, output deltas, and completion use the same tool-call ID so a session UI can group them without inspecting terminal escape sequences.

## Options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `endpoint` | `string` | Required | Complete OTLP traces endpoint, commonly ending in `/v1/traces`. |
| `headers` | `Record<string, string>` or resolver | None | Request headers resolved for each export. |
| `resource` | OTLP resource attributes or resolver | Agent and runtime defaults | Additional resource attributes. |
| `live` | `boolean` | `false` | Exports coalesced trace snapshots while the invocation runs, followed by the terminal snapshot. |
| `content.inputs` | `boolean` | `false` | Includes user and tool input content in invocation spans. |
| `content.instructions` | `boolean` | `false` | Includes resolved Agent instructions in the configuration event. |
| `content.outputs` | `boolean` | `false` | Includes assistant, tool, and result output content in invocation spans. |
