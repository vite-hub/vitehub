---
title: evlog
description: Export Agent lifecycle events, resource diagnostics and durable papercut reports.
navigation.group: Core
---

Install `evlog` in the host. Add `posthog-node` to use the optional Node.js PostHog exporter.

```ts
import { createAgentEvlog } from 'vite-hub/agent/evlog'
import { posthogAgentExporter } from 'vite-hub/agent/evlog/posthog'

export const telemetry = createAgentEvlog({
  service: 'support-agent',
  environment: 'development',
  exporter: posthogAgentExporter({
    apiKey: process.env.POSTHOG_API_KEY!,
    service: 'support-agent',
  }),
})
```

Add `telemetry.capability` to an Agent Definition. It emits a start event and one terminal `$ai_trace` event through the Agent telemetry lifecycle, including failed preparation. Terminal events include duration, invocation identity, available usage and cost, and completion status. Streaming usage updates do not emit extra terminal events. Add `diagnostics({ reporter: telemetry.diagnostics, resources })` to export resource measurements from an explicit runtime inspector.

The integration uses evlog's logger and drain pipeline. It does not reinitialize a host's global evlog configuration. On Nitro, install the shared host plugin:

```ts
import { agentEvlogPlugin } from 'vite-hub/agent/evlog'
import { telemetry } from '../observability'

export default agentEvlogPlugin(telemetry)
```

The plugin assigns request IDs, connects the evlog drain and HTTP error hooks, and flushes on shutdown. Pass durable reporters as the second argument to start them when an exporter is configured and stop them before flushing. Other hosts can connect `telemetry.drain` and `telemetry.exception(error, properties)` themselves. Internal Agent events bypass the global drain when an explicit exporter is set, to avoid duplicate exports. Without an exporter, they use the host's existing global drain.

Terminal event delivery runs in the background instead of delaying the final response. Honor the Agent runtime's `waitUntil` tasks. On shutdown, stop accepting work, wait for active invocations and their background tasks, then await `telemetry.flush()`. Flush closes the exporter; subsequent ordinary events are dropped and explicit delivery fails. Export calls and the final exporter flush each have a ten-second deadline, configurable with `deliveryTimeoutMs`. Custom exporters receive an abort signal and must stop their I/O when it aborts. Deadlines bound waiting even if an exporter ignores the signal, but cannot terminate arbitrary application code.

Ordinary logs and events are best effort. `maxPending` defaults to 1,000 for event deliveries and independently for the log buffer. `status()` exposes accepted, failed, dropped, pending and closed state. Counters include log records and event deliveries. Without an exporter, events still reach local evlog output and explicit `capture()` rejects.

Raw prompts, model outputs, tool payloads, credentials and common personal identifiers are excluded from exported properties. Unknown error messages are replaced with generic text. `trustedErrorCodes` allows diagnostic text for known application codes. This filtering reduces accidental disclosure; it is not a general detector for sensitive prose. Only send properties intended for telemetry.

## Deliver papercut reports durably

```ts
import { createPapercutReporter, papercuts } from 'vite-hub/agent/capabilities'

const reporter = createPapercutReporter({
  invocations: () => invocations,
  send: delivery => telemetry.capture('papercut_reported', delivery.properties, {
    uuid: delivery.uuid,
    timestamp: new Date(delivery.timestamp),
  }),
})

// Add papercuts({ report: reporter.report }) to the Agent Definition.
// Start replay with the host; stop it before telemetry.flush().
reporter.start()
```

Use a persistent Agent Invocation store with content retention enabled. Reports require a stored invocation identity. The reporter stores the sanitized envelope before sending it, and only records delivery after the destination acknowledges it. Failed delivery remains available for replay after a restart. Replay reads 100 invocations per page and skips live invocations.

Delivery is at least once. A crash between destination acceptance and the persisted acknowledgement can cause a retry, so the destination must deduplicate the stable UUID. PostHog delivery requires an affirmative ingestion response and uses the same UUID and timestamp on retries. One reporter coalesces concurrent sends; separate processes rely on destination deduplication.

`sessionUrl` supplies a trusted host URL for the invocation. `eventPrefix` and `uuidNamespace` let existing consumers retain their stored event names and report identities. Keep these stable across deployments. `stop()` closes the reporter and waits up to `deliveryTimeoutMs` for active work. A timed-out report is not marked as delivered.
