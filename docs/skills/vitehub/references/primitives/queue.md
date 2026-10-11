# Queue

Use Queue to send work to a consumer that can run after the request ends. Queue Definitions own consumer code, retries, and concurrency.

Read the [Queue guide](https://vitehub.dev/docs/queue), then [Get started](https://vitehub.dev/docs/queue/get-started), [Configure](https://vitehub.dev/docs/queue/configure), [Server API](https://vitehub.dev/docs/queue/server-api), or [Hosts](https://vitehub.dev/docs/queue/hosts).

Treat enqueue as a handoff. Make the job idempotent, keep payloads bounded, and choose retry behavior for the side effect. Queue configuration does not make a job exactly once.

Use a Queue for independent background work, a Schedule for when work starts,
and a Workflow when several durable steps must be inspected together.

Prove enqueue, consumer execution, retry, and a poison or invalid payload. Inspect provider output for the target host.
