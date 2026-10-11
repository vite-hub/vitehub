# Schedule

Use Schedule for recurring wakeups or static cron declarations. A scheduled run should hand off to idempotent application or Agent work.

Read the [Schedule guide](https://vitehub.dev/docs/schedule), then [Get started](https://vitehub.dev/docs/schedule/get-started), [Configure](https://vitehub.dev/docs/schedule/configure), [Server API](https://vitehub.dev/docs/schedule/server-api), or [Hosts](https://vitehub.dev/docs/schedule/hosts).

Keep the schedule definition separate from the work it starts. Use a stable key and record the last completed run when the action must not repeat.

Prove one manual run, one scheduled wake, retry or overlap behavior, and the terminal state. Inspect generated cron or provider output.
