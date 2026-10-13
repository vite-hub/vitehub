# Schedule

Use Schedule for recurring wakeups or static cron declarations. A scheduled run should hand off to idempotent application or Agent work.

Read the [Schedule guide](https://vitehub.dev/raw/docs/schedule.md), then [Get started](https://vitehub.dev/raw/docs/schedule/get-started.md), [Configure](https://vitehub.dev/raw/docs/schedule/configure.md), [Server API](https://vitehub.dev/raw/docs/schedule/server-api.md), or [Hosts](https://vitehub.dev/raw/docs/schedule/hosts.md).

Keep the schedule definition separate from the work it starts. Use a stable key and record the last completed run when the action must not repeat.

Prove one manual run, one scheduled wake, retry or overlap behavior, and the terminal state. Inspect generated cron or provider output.
