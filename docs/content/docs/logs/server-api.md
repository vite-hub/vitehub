---
title: Logs server API
navigation.title: Server API
navigation.order: 4
description: "The Evlog logger API in vite-hub/logs, the LogSource read contract, the local buffer, and how the Console and the CLI read events."
icon: i-lucide-logs
---

## Logger API

`vite-hub/logs` re-exports the Evlog root API. For request context, import the official Evlog framework adapters, such as `evlog/nitro/v3`. ViteHub does not rename them or add a second logger lifecycle.

## Source contract

```ts
import type { LogSource, LogEntry, LogQuery, LogPage } from 'vite-hub/logs'
```

A `LogSource` has `info` and an asynchronous `query(query, options)` method. `options.signal` can cancel a query.

`info` has `id`, `label`, `retention`, and supported `filters`. External retention is `{ kind: 'external', description: 'Your backend retention policy' }`. Filters are `text`, `level`, and `service`.

`LogQuery` takes optional `text`, `level`, `service`, `cursor`, and `limit`. Levels are `debug`, `info`, `warn`, and `error`. Apply every filter, or reject those your source cannot support.

Return a `LogPage` with `entries`, an optional next-page `cursor`, and optional `dropped` count. Return the newest events first, with stable IDs. A `LogEntry` has `id`, ISO `timestamp`, `level`, `service`, `message`, and structured `data`.

Throw `LogCursorExpiredError` when a cursor points to data that is gone. Keep pages stable while new events arrive.

## Local buffer

`createLogBuffer()` returns `source`, `append`, `drain`, and `clear`. `append` takes normalized `LogEntry` values. `drain` takes an Evlog drain context after redaction. Neither starts Evlog. Invalid and oversized entries raise the dropped count.

## Inspection

The Console and CLI read the configured source. Run `vitehub logs --help` for CLI commands and connection options. Selecting an event in the Console opens it in the inspector. Nostics diagnostics added with `diagnostic.toJSON()` keep their `name`, `why`, `fix`, and `docs` fields.
