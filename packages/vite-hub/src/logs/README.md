# ViteHub Logs

`vite-hub/logs` exposes Evlog's public logger API unchanged. Install `evlog` to use it. Logging setup remains owned by the application. Reading logs does not start a logger, register an OpenTelemetry SDK or create an exporter.

A `LogSource` describes retention and supported filters, then reads newest-first pages. Keep provider credentials on the server. Apply redaction before events reach the source. A source must reject a filter that it cannot apply. Its query receives an optional abort signal. Cursor semantics and expiration belong to the source.

```ts
import { createLogBuffer, initLogger } from 'vite-hub/logs'

const buffer = createLogBuffer()
initLogger({ drain: buffer.drain, redact: true })

const page = await buffer.source.query({ level: 'error', limit: 50 })
```

Attach `buffer.drain` to an existing Evlog drain hook instead when Evlog is already configured. The buffer never calls `initLogger`. Keep one exporter route to each destination.

The local buffer defaults to 256 entries and 16 KiB per event. It stores JSON snapshots, drops oversized or invalid events, and counts evictions and drops. It is per process, disappears on restart and does not combine serverless instances. It is for local inspection, not retained production history. `clear()` clears only this local buffer.

Use `vite-hub/logs/source` for the read contract without loading Evlog. Use `vite-hub/logs/memory` for the buffer without loading Evlog at runtime. Read adapters can connect an existing backend without creating another copy of its logs. OpenTelemetry exports logs; it does not define the query API for that backend.

Nostics fields can be stored within `LogEntry.data` as structured data. Keep diagnostic `code`, `why`, `fix`, `docs`, `sources`, and `data` intact after redaction. One owning operation should emit the error event; avoid reporting it again from both a Nostics reporter and the request error handler.

Serialize a Nostics `Diagnostic` with `diagnostic.toJSON()` before calling `logger.set({ diagnostic: ... })`. Evlog treats Error instances differently from structured fields. The serialized diagnostic uses `name` for its stable code. The Console accepts both `name` and `code`.
