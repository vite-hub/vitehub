---
title: Logs server API
navigation.title: Server API
navigation.order: 4
description: "Import the Evlog logger API from evlog, use the LogSource read contract and local buffer from vite-hub/logs, and read events in the Console and CLI."
icon: i-lucide-logs
---

## Logger API

Import the Evlog logger API (`initLogger`, `log`, `createLogger`) from `evlog`. For request context, import the official Evlog framework adapter, such as `useLogger` from `evlog/nitro/v3`.

Import the ViteHub read contract and local buffer (`createLogBuffer()`, `logCursorExpiredError()`, `parseLogQuery()`, and the `LogSource` types) from `vite-hub/logs`. ViteHub keeps Evlog's own API and lifecycle.

## Fields that ViteHub adds

With the evlog Nitro module, ViteHub primitives add their own fields to the wide event of each request. Without evlog, they add nothing.

| Field | Added by | Read more |
| --- | --- | --- |
| `database` | Each request that calls a database | [Database](/docs/database/server-api#see-database-work-on-each-request) |
| `auth` | A sign-in, a Better Auth error, or a refusal of an Auth guard | [Auth](/docs/auth/server-api#see-auth-outcomes-on-each-request) |
| `rateLimit` | A request that a Rate Limit refuses | [Rate Limit](/docs/rate-limit/server-api#see-refusals-on-each-request) |
| `realtime` | A Realtime connection or document request that Realtime refuses | [Realtime](/docs/realtime/limits-and-errors#see-refusals-and-failures-in-logs) |
| `browserError` | A browser error or warning, with `observability.browserErrors`: an uncaught error or a call to `reportBrowserError()` | [Configure](/docs/logs/configure#log-browser-errors) |
| `blob` | A Blob cache failure in `serve()` | [Blob](/docs/blob/limits-and-errors#see-cache-failures-in-logs) |
| `comments` | A failed `onComment` | [Comments](/docs/comments/limits-and-errors#see-hook-and-sync-failures-in-logs) |

Work outside a request gets an evlog event of its own, `{ action, message, [field] }`. The event goes to evlog's drains and to the app's `evlog:drain` hooks, but not to its `evlog:enrich` hooks.

| Field | Event | Read more |
| --- | --- | --- |
| `blob` | A Blob cache failure outside `serve()` | [Blob](/docs/blob/limits-and-errors#see-cache-failures-in-logs) |
| `kv` | A failed delete of expired KV rows | [KV](/docs/kv/limits-and-errors#see-expiry-failures-in-logs) |
| `schedule` | Schedule runs and runtime failures inside Nitro, not standalone provider wakes | [Schedule](/docs/schedule/server-api#see-schedule-runs-in-logs) |
| `comments` | A failed `onMention` or pull request sync | [Comments](/docs/comments/limits-and-errors#see-hook-and-sync-failures-in-logs) |

ViteHub sends these events only when the app installs evlog and registers its Nitro module. Each event has a fixed message and the `code` of the error, never its message, which can hold a path or a value. A failed Schedule handler is the exception: its event has the error, as a request's wide event has a route's error. Without evlog, or with evlog's `enabled: false`, the same failures go to the server console.

## Source contract

```ts
import type { LogSource, LogEntry, LogQuery, LogPage } from 'vite-hub/logs'
```

A `LogSource` has `info` and an asynchronous `query(query, options)` method. `options.signal` can cancel a query.

`info` has `id`, `label`, `retention`, and supported `filters`. External retention is `{ kind: 'external', description: 'Your backend retention policy' }`. Filters are `text`, `level`, and `service`.

`LogQuery` takes optional `text`, `level`, `service`, `cursor`, and `limit`. Levels are `debug`, `info`, `warn`, and `error`. Apply every filter, or reject those your source cannot support.

Return a `LogPage` with `entries`, an optional next-page `cursor`, and optional `dropped` count. Return the newest events first, with stable IDs. A `LogEntry` has `id`, ISO `timestamp`, `level`, `service`, `message`, and structured `data`.

Throw `logCursorExpiredError()` from `vite-hub/logs` when a cursor points to data that is gone. The Console then answers `LOGS_CURSOR_EXPIRED` with status 409. Keep pages stable while new events arrive.

## Local buffer

`createLogBuffer()` from `vite-hub/logs` returns `source`, `append`, `drain`, and `clear`. `append` takes normalized `LogEntry` values. `drain` takes an Evlog drain context after redaction. Neither starts Evlog. Invalid and oversized entries raise the dropped count.

In a standalone script without an existing Evlog setup, pass `buffer.drain` to `initLogger()`:

```ts
import { initLogger, log } from 'evlog'
import { createLogBuffer } from 'vite-hub/logs'

const buffer = createLogBuffer()
initLogger({ drain: buffer.drain, env: { service: 'checkout' }, redact: true })
log.info({ action: 'order.paid', orderId: 'ord_42' })

const page = await buffer.source.query({ service: 'checkout', text: 'ord_42' })
```

In Nitro, attach `buffer.drain` to the `evlog:drain` hook when Evlog is already configured. In a standalone script that already calls `initLogger()` with a drain, combine both drains with `composeDrains([existingDrain, buffer.drain])` from `evlog/toolkit` in the original `initLogger()` call instead of calling `initLogger()` twice.

## Inspection

The Console and CLI read the configured source. Run `vitehub logs --help` for CLI commands and connection options. Selecting an event in the Console opens it in the inspector. Nostics diagnostics added with `diagnostic.toJSON()` keep their `name`, `why`, `fix`, and `docs` fields.
