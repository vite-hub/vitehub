---
title: Limits and errors
navigation.title: Limits and errors
navigation.order: 6
description: Limits and errors for ViteHub Logs, powered by Evlog.
icon: i-lucide-logs
---

The default local buffer retains 256 entries in one process, with a 16 KiB maximum per entry. Restarting the process clears it. Separate workers do not share the buffer. Invalid, oversized, and evicted events increase the dropped count.

The Console retains at most 1,000 displayed events. Follow polls every two seconds. It is not a lossless subscription and can miss events during bursts or retention changes.

Queries default to 200 entries and accept at most 500. Search text is limited to 512 characters. The API bounds responses to 4 MiB. An expired cursor returns HTTP 409. Invalid queries return 400; source failures return 502.

Redact secrets and personal data before capture or source delivery. A local Console is a development tool. Production access must use the application's configured Console authorization.

For structured error guidance, set a serialized Nostics diagnostic on the event:

```ts
logger.set({ diagnostic: diagnostic.toJSON() })
```

Nostics serializes the diagnostic code as `name`. Preserve `why`, `fix`, `docs`, and any structured data. Logging only an error message loses those fields.
