---
title: Server API
navigation.title: Server API
navigation.order: 4
description: Server API for ViteHub Logs, powered by Evlog.
icon: i-lucide-logs
---

## Logger API

`vite-hub/logs` re-exports Evlog's root API. Use official Evlog framework adapter imports for request context, such as `evlog/nitro/v3`. ViteHub does not rename those adapters or add a second logger lifecycle.

## Source contract

```ts
import type { LogSource, LogEntry, LogQuery, LogPage } from 'vite-hub/logs'
```

A `LogSource` has `info` and an asynchronous `query(query, options)` method. `options.signal` can cancel a query.

`info` contains `id`, `label`, `retention`, and supported `filters`. External retention uses `{ kind: 'external', description: 'Your backend retention policy' }`. Filters are `text`, `level`, and `service`.

`LogQuery` accepts optional `text`, `level`, `service`, `cursor`, and `limit`. Levels are `debug`, `info`, `warn`, and `error`. Apply all supplied filters, or reject filters your source cannot support.

Return a `LogPage` with `entries`, an optional next-page `cursor`, and optional `dropped` count. Return newest events first and use stable event IDs. A `LogEntry` contains `id`, ISO `timestamp`, `level`, `service`, `message`, and structured `data`.

Throw `LogCursorExpiredError` when a cursor no longer identifies retained data. Keep pagination stable while newer events arrive.

## Local buffer

`createLogBuffer()` returns `source`, `append`, `drain`, and `clear`. `append` accepts normalized `LogEntry` values. `drain` accepts an Evlog drain context after redaction. Neither method initializes Evlog. Invalid and oversized entries increase the dropped count.

## Inspection

The Console and CLI read the configured source. Use `vitehub logs --help` for the CLI commands and connection options. Console selection opens the full event in the right inspector. Serialized Nostics diagnostics retain their `name`, `why`, `fix`, and `docs` fields when added with `diagnostic.toJSON()`.
