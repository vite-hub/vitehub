---
title: Logs configuration
navigation.title: Configure
navigation.order: 3
description: "Pass Evlog options through the ViteHub logs option, or read an existing log backend with a LogSource module for the Console and the CLI."
icon: i-lucide-logs
---

## Evlog options

Logs are part of `observability` in `vitehub()`. Pass native Evlog options under `observability.evlog`:

```ts fragment
observability: {
  logs: true,
  evlog: {
    env: { service: 'checkout' },
    redact: { paths: ['customer.email'] },
    exclude: ['/_vitehub/**', '/api/_vitehub/**'],
  },
}
```

Read the [Evlog documentation](https://evlog.dev) for its options and drains. If your app already registers the Evlog Nitro module, keep its options there. ViteHub reuses it.

## Read an existing backend

Set `observability.logs.source` to a server module that exports a `LogSource` as its default export:

```ts fragment
observability: { logs: { source: './server/logs.ts' } }
```

The module implements the [Server API](/docs/logs/server-api) read contract. Query your backend with server credentials, normalize events, and return the newest first. List only filters the backend can apply. Pass the abort signal to backend requests.

Source mode starts no logger, drain, or local buffer, unless `observability.service` turns on Agent telemetry, which registers Evlog. Your setup keeps sending events. The source only reads them.

Evlog can export to PostHog, OTLP, and other destinations, but those drains give the Console no history. ViteHub has no built-in PostHog or OTLP history adapter. Write a source against the destination's query API, because OTLP ingestion alone cannot answer queries.

Keep backend credentials in server config. Remove sensitive fields before you return events to the Console.
