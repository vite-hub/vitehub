---
title: Observability
description: Send Agent events, request errors, and papercut reports to evlog and PostHog.
navigation.group: Inspect and evaluate
navigation.order: 50
navigation.kind: Guides
---

Set observability once in `vitehub()`. Install `evlog` in the host. Add `posthog-node` to export to PostHog. `service` turns on Agent telemetry and installs `useObservability()`; without it, `observability` registers only Evlog and the [Logs](/docs/logs) source in `observability.logs`.

::tabs{sync="framework"}
:::tabs-item{label="Nuxt"}
```ts [nuxt.config.ts]
import { env } from 'vite-hub/env'

export default defineNuxtConfig({
  modules: ['vite-hub/nuxt'],
  vitehub: {
    host: 'node',
    agent: true,
    console: { auth: false },
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
  },
})
```
:::

:::tabs-item{label="Nitro"}
```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { nitro } from 'nitro/vite'
import { vitehub } from 'vite-hub'
import { env } from 'vite-hub/env'

export default defineConfig({
  plugins: [
    vitehub({
      host: 'node',
      agent: true,
      console: { auth: false },
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
    nitro(),
  ],
})
```
:::

:::tabs-item{label="Vite"}
```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'
import { env } from 'vite-hub/env'

export default defineConfig({
  plugins: [
    vitehub({
      host: 'node',
      agent: true,
      console: { auth: false },
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
:::
::

ViteHub then:

- registers the evlog Nitro module in `vite dev` and `vite build`, with `evlog` as its options and `service` and `environment` as its `env`, in `vite dev` and `vite build`.
- declares `posthog.apiKey` as Server Env `observability.posthog.apiKey` and reads it at startup, so the Console Env page shows it.
- generates a Nitro plugin that installs one host instance, sets request IDs, connects the evlog drain and HTTP error hooks, and flushes on shutdown.
- adds the observability Capability to every Agent, and with `papercuts`, the `report_papercut` tool.
- reports `status()` as `observability` in the `status.get` operation.

Remove your own evlog Nitro module and host plugin. Without an API key, events still reach local evlog output, `status().configured` is `false`, and `capture()` rejects.

Read the instance in server code:

```ts fragment
import { useObservability } from 'vite-hub/agent/observability'

const observability = useObservability()
observability.event('import.completed', { rows: 120 })
await observability.capture('invoice.sent', { invoice_id: id })
observability.exception(error, { operation: 'import' })
observability.status() // { configured, accepted, failed, dropped, pending, closed, papercuts? }
```

`useObservability()` throws when `vitehub({ observability })` has no `service`.

The Capability sends one terminal `$ai_trace` event per invocation, also when preparation fails, with duration, invocation identity, known usage and cost, and status. Streaming usage updates add no extra ones. With an exporter set, internal Agent events skip the global drain to avoid duplicates.

Without `vitehub()`, call `installObservability(options)` from `@vite-hub/agent/observability/host` and pass the returned plugin the Nitro app. `posthog(options)` from `@vite-hub/agent/observability/posthog` creates the exporter.

## Delivery and shutdown

- Terminal events send in the background, not delaying the response. Honor the runtime's `waitUntil` tasks.
- On shutdown, the plugin stops papercut replay, then flushes the exporter. Flush closes the exporter. Later ordinary events drop, and explicit delivery fails.
- Export calls and the final flush each have a ten-second deadline. Custom exporters get an abort signal and must stop their I/O on it. The deadline limits waiting even if an exporter ignores it, but cannot stop app code.
- HTTP request log export keeps only request records at warning or error level, or with status 400 or higher. evlog's `DrainContext.request` metadata from the Nitro integration marks them. Other logs, Agent events, and exceptions are unaffected.
- Ordinary logs and events are best effort. `maxPending` defaults to 1,000 for event deliveries, and separately for the log buffer. `status()` shows accepted, failed, dropped, pending, and closed state. Counts cover log records and event deliveries.

::warning
Exported properties exclude raw prompts, model outputs, tool payloads, credentials, and common personal identifiers. Unknown error messages become generic text. This reduces accidental leaks but does not catch all sensitive text. Send only properties meant for telemetry.
::

Observability needs Nitro-hosted Agents. Netlify and Deno standalone Agent output are not supported. Close the current host before you install another instance.

## Deliver papercut reports durably

A papercut is a short note an Agent files about friction it hits. Set `papercuts: true`, or `{ eventPrefix, uuidNamespace, intervalMs }`. It needs `agent` and `console`, because reports are journaled in the Console invocation store. The reporter starts only with an exporter.

Reports need a stored invocation identity, so use a persistent Invocation store with content retention on. The reporter stores the cleaned report before sending, and marks it delivered only after the destination confirms. Failed reports replay after a restart, 100 invocations per page, skipping live ones.

Delivery is at least once. A crash after the destination accepts but before the confirmation is stored can cause a retry, so the destination must deduplicate by the stable UUID. PostHog delivery needs a positive ingestion response and reuses the UUID and timestamp on retries. One reporter merges concurrent sends. Separate processes rely on destination deduplication.

`eventPrefix` and `uuidNamespace` let existing consumers keep their event names and report identities across deployments, so do not change them. On shutdown the reporter waits up to ten seconds for active work, and does not mark a timed-out report as delivered. `status().papercuts` counts in-flight, delivered, and failed reports since start, and `known` and `repeats` for [repeated reports](/docs/agents/capabilities/papercuts#repeated-reports) in the last 7 days. Undelivered reports stay in the journal for replay.

Links in events and reports use `vitehub({ publicUrl })`. Without it, events have no `session_url`. Quota checks, app routing, and deployment revision labels stay in your app configuration.

## Check behavior

Observability records what happened. Use [Test an Agent](/docs/agents/testing) for fixed contracts and [Evals](/docs/agents/evals) for model behavior. Set up [Invocation storage](/docs/agents/invocation-storage) when the Console or an exporter needs stored records.
