---
title: Observability
description: Export Agent lifecycle events, request failures and durable papercut reports through evlog.
navigation.group: Core
---

Configure observability once in `vitehub()`. Install `evlog` in the host. Add `posthog-node` to export to PostHog.

```ts [vite.config.ts]
import { vitehub } from 'vite-hub'
import { env } from 'vite-hub/env'

export default defineConfig({
  plugins: [
    vitehub({
      preset: 'node',
      agent: true,
      console: true,
      publicUrl: 'https://agents.example.com',
      observability: {
        service: 'support-agent',
        posthog: {
          apiKey: env({ optional: true, secret: true, source: env.source('POSTHOG_API_KEY') }),
          host: 'https://eu.i.posthog.com',
        },
        evlog: { sampling: { rates: { info: 0, warn: 100, error: 100 } } },
        papercuts: true,
      },
    }),
  ],
})
```

ViteHub then:

- registers the evlog Nitro module with `evlog` as its options and `service` and `environment` as its `env`, in `vite dev` and `vite build`;
- declares `posthog.apiKey` as Server Env `observability.posthog.apiKey` and reads it at startup, so the Console Env page shows it;
- generates a Nitro plugin that installs one host instance, assigns request IDs, connects the evlog drain and HTTP error hooks, and flushes on shutdown;
- adds the observability Capability to every Agent, and with `papercuts`, the `report_papercut` tool;
- reports `status()` as `observability` in the Console status endpoint, `/api/_vitehub/console/status`.

Remove an existing evlog Nitro module and host plugin when you adopt this option. Without an API key, events still reach local evlog output, `status().configured` is `false`, and `capture()` rejects.

Read the instance in server code:

```ts
import { useObservability } from 'vite-hub/agent/observability'

const observability = useObservability()
observability.event('import.completed', { rows: 120 })
await observability.capture('invoice.sent', { invoice_id: id })
observability.exception(error, { operation: 'import' })
observability.status() // { configured, accepted, failed, dropped, pending, closed, papercuts? }
```

`useObservability()` throws when `vitehub({ observability })` is not set. The Capability emits one terminal `$ai_trace` event per invocation through the Agent telemetry lifecycle, including failed preparation. Terminal events include duration, invocation identity, available usage and cost, and completion status. Streaming usage updates do not emit extra terminal events. Internal Agent events bypass the global drain when an exporter is set, to avoid duplicate exports.

Hosts without `vitehub()` call `installObservability(options)` from `@vite-hub/agent/observability/host` and pass the returned plugin the Nitro app. `posthog(options)` from `@vite-hub/agent/observability/posthog` creates the exporter.

Terminal event delivery runs in the background instead of delaying the final response. Honor the Agent runtime's `waitUntil` tasks. On shutdown, the plugin stops papercut replay, then flushes the exporter. Flush closes the exporter; subsequent ordinary events are dropped and explicit delivery fails. Export calls and the final exporter flush each have a ten-second deadline. Custom exporters receive an abort signal and must stop their I/O when it aborts. Deadlines bound waiting even if an exporter ignores the signal, but cannot terminate arbitrary application code.

HTTP request log export includes only request records with a warning or error level or a status of 400 or higher. Request records are identified by evlog's `DrainContext.request` metadata, which the Nitro integration supplies. Other application logs, Agent events and exception delivery are unaffected.

Ordinary logs and events are best effort. `maxPending` defaults to 1,000 for event deliveries and independently for the log buffer. `status()` exposes accepted, failed, dropped, pending and closed state. Counters include log records and event deliveries.

Raw prompts, model outputs, tool payloads, credentials and common personal identifiers are excluded from exported properties. Unknown error messages are replaced with generic text. This filtering reduces accidental disclosure; it is not a general detector for sensitive prose. Only send properties intended for telemetry.

Observability currently requires Nitro-hosted Agents. Netlify and Deno standalone Agent output are not supported. Close the current host before installing another observability instance.

## Deliver papercut reports durably

Set `papercuts: true`, or `{ eventPrefix, uuidNamespace, intervalMs }`. It requires `agent` and `console`, because reports are journaled in the Console invocation store. The reporter starts only when an exporter is configured.

Use a persistent Agent Invocation store with content retention enabled. Reports require a stored invocation identity. The reporter stores the sanitized envelope before sending it, and only records delivery after the destination acknowledges it. Failed delivery remains available for replay after a restart. Replay reads 100 invocations per page and skips live invocations.

Delivery is at least once. A crash between destination acceptance and the persisted acknowledgement can cause a retry, so the destination must deduplicate the stable UUID. PostHog delivery requires an affirmative ingestion response and uses the same UUID and timestamp on retries. One reporter coalesces concurrent sends; separate processes rely on destination deduplication.

`eventPrefix` and `uuidNamespace` let existing consumers retain their stored event names and report identities. Keep these stable across deployments. On shutdown the reporter waits up to ten seconds for active work. A timed-out report is not marked as delivered. `status().papercuts` counts deliveries in flight, delivered and failed since start; undelivered reports stay in the journal for replay.

Invocation links in events and reports use `vitehub({ publicUrl })`. Without it, events have no `session_url`. Quota checks, application routing and deployment revision labels remain application configuration.
