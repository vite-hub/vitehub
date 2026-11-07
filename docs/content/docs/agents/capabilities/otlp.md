---
title: OTLP
description: Send Agent run events and traces to any OpenTelemetry receiver, while the run happens or when it ends.
navigation.title: OTLP
navigation.order: 225
navigation.group: Capabilities
icon: i-lucide-activity
---

`otlp()` sends telemetry for each Invocation (one Agent run) to any OpenTelemetry receiver that accepts standard logs and traces, over OTLP HTTP JSON. It registers a trace exporter, adds no model tool, and wraps no Server Primitive.

## Configure OTLP export

Pass the receiver's base endpoint. ViteHub adds `/v1/logs` and `/v1/traces`.

```ts [server/agents/support.ts]
import { defineAgent } from 'vite-hub/agent'
import { otlp } from 'vite-hub/agent/capabilities'

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

## How OTLP export works

ViteHub always sends one completed trace with timing and `gen_ai.*` span attributes.

### The configuration event

Without `live`, the root span also has the run's Trace Events, including `vitehub.agent.configured`. It describes the Agent Definition, secrets removed: Agent identity, Capability metadata, known Driver and model identity, tool names, runtime, and Workspace name, mode, and Sources.

Its `vitehub.agent.configuration.fingerprint` hashes these facts and the final instructions, not Capability inspection snapshots:

- Public configurations get a stable `sha256_...` digest.
- Configurations with redacted credentials get an `hmac_sha256_...` digest with a private runtime key, so credentials cannot be guessed offline. These compare only within one runtime and change on restart.

### Live export

With `live: true`, each Trace Event goes once as an OTLP LogRecord during the run:

- Records share the completed trace's trace and span IDs.
- Each carries `agent.invocation.id` and `vitehub.event.sequence` for de-duplication.
- Batches go after five seconds or 512 new events, whichever is first, and the rest at the end.
- When all records arrive, the completed trace omits span events. If a batch fails, it keeps them, so no data is lost.

ViteHub only appends. It never polls or resends a changing open-span snapshot. OTLP over HTTP and gRPC is request and response, so there is no receiver-specific SSE or WebSocket channel.

## Custom Capability metadata

Every Capability adds its public `metadata`. A custom Capability can also add facts learned during the run, without knowing the exporter:

```ts
import { defineCapability } from 'vite-hub/agent'

export const repository = defineCapability({
  id: 'repository',
  metadata: { provider: 'github' },
  async resolve(context) {
    const installation = await resolveInstallation(context)
    context.telemetry.metadata({ installation: installation.slug })
  },
})
```

They go in its configuration event entry, with no extra stream or receiver-specific code.

## Delivery behavior

- The exporter retries temporary HTTP failures and obeys `Retry-After`.
- Export is best effort through the host's `waitUntil()`. A down receiver does not change Agent output.
- Receiver failures log a short local error with Capability ID, invocation ID, run ID, and export phase.

> [!NOTE]
> Retries can resend requests. De-duplicate spans by trace and span ID, and live records by `agent.invocation.id` and `vitehub.event.sequence`.

Streamed command output is trace activity, not a log drain. Command start, output parts, and provider completion share a tool-call ID, so a session UI can group them without parsing terminal escape sequences.

## Requirements

- A full `http:` or `https:` base endpoint.
- A receiver accepting OTLP/HTTP JSON at `/v1/traces`, and `/v1/logs` with `live`.

## Security and approval

There is no model tool, so no approval step. By default, only metadata goes to the receiver, not content.

The configuration event is not a user message. The trace content policy controls prompts and model or tool content; this exporter sends their metadata.

Capability tool start, finish, and error events carry `capability.id`; unused Capabilities add none. Tool input and output need content export.

Agent instructions are prompt content, left out by default. Turn them on for a trusted receiver:

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

Secret-shaped metadata keys become `[redacted]`. Keep receiver credentials in `headers`; the endpoint and headers never appear in Agent metadata.

## Driver support

| Agent Driver | Support |
| --- | --- |
| Model-backed | Trace with model and tool activity. |
| Provider-backed | Trace with normalized provider tool and command activity. |
| Custom-run-backed | Trace recorded around `driver.run`. |

## Verify OTLP export

1. Run once against a local OpenTelemetry Collector with a debug exporter.
2. One trace with a `vitehub.agent.configured` event reaches `/v1/traces`, and LogRecords reach `/v1/logs` with `live`.
3. With the receiver stopped, output is unchanged and a local export error appears.

## Options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `endpoint` | `string` | Required | Absolute base endpoint. `/v1/logs` and `/v1/traces` are appended. |
| `headers` | `Record<string, string>` or resolver | None | Headers resolved per export. |
| `resource` | OTLP resource attributes or resolver | Agent and runtime defaults | Additional resource attributes. |
| `content.inputs` | `boolean` | `false` | Export user and tool input content. |
| `content.instructions` | `boolean` | `false` | Export resolved Agent instructions. |
| `content.outputs` | `boolean` | `false` | Export assistant, tool, and result output. |
| `live` | `boolean` | `false` | Send Trace Events as correlated OTLP logs during the run. |

## Related pages

- [Agent invocations](/docs/agents/invocations)
- [diagnostics()](/docs/agents/capabilities/diagnostics)
- [Custom capabilities](/docs/agents/capabilities/custom)
- [Official capabilities](/docs/agents/capabilities/official)
