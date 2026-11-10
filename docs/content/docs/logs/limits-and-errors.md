---
title: Logs limits and errors
navigation.title: Limits and errors
navigation.order: 6
description: "Local buffer size, Console and query limits, the HTTP errors of the logs API, and how to attach a Nostics diagnostic to an event."
icon: i-lucide-logs
---

- The local buffer keeps 256 entries in one process, up to 16 KiB each. A restart clears it. Workers do not share it. Invalid, oversized, and evicted events raise the dropped count.
- The Console shows at most 1,000 events. Follow polls every two seconds and can miss events during bursts or retention changes.
- Queries return 200 entries by default and 500 at most. Search text is up to 512 characters. Responses are up to 4 MiB.
- Errors: an expired cursor returns HTTP 409, an invalid query 400, and a source failure 502.

Remove secrets and personal data before capture or source delivery. The local Console is a development tool. In production, access goes through your app's Console authorization.

For structured error help, set a serialized Nostics diagnostic on the event:

```ts fragment
logger.set({ diagnostic: diagnostic.toJSON() })
```

Nostics writes the diagnostic code as `name`. Keep `why`, `fix`, `docs`, and any structured data. Logging only the error message loses them.
