---
title: Configure
navigation.title: Configure
navigation.order: 3
description: Configure for ViteHub Logs, powered by Evlog.
icon: i-lucide-logs
---

## Evlog options

Pass native Evlog options under `logs.evlog`:

```ts
logs: {
  evlog: {
    env: { service: 'checkout' },
    redact: { paths: ['customer.email'] },
    exclude: ['/_vitehub/**', '/api/_vitehub/**'],
  },
}
```

See [Evlog documentation](https://evlog.dev) for its current configuration and drains. If your application already registers the Evlog Nitro module, keep its options there. ViteHub reuses that module rather than registering a second one.

## Read an existing backend

Set `logs.source` to a server module that exports a `LogSource` as its default export:

```ts
logs: { source: './server/logs.ts' }
```

The module must implement the [Server API](/docs/logs/server-api) read contract. Query your existing backend with server credentials, normalize events, and return newest events first. Advertise only filters the backend can apply. Forward the abort signal to backend requests.

Source mode starts no logger, drain, or local buffer. Your existing instrumentation continues to send events. The source only reads them.

Evlog supports export destinations such as PostHog and OTLP. Those drains do not provide a Console history reader. ViteHub currently has no built-in PostHog or OTLP history adapter. Implement a source against the destination's query API. OTLP ingestion alone cannot answer log queries.

Keep backend credentials in server configuration. Redact sensitive fields before returning events to the Console.
