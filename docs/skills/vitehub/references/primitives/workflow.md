# Workflows

Use Workflows for provider-tracked work that can outlive a request and needs durable state, retries, or steps. A run id is the handle for inspection.

Read the [Workflows guide](https://vitehub.dev/docs/workflows), then [Get started](https://vitehub.dev/docs/workflows/get-started), [Configure](https://vitehub.dev/docs/workflows/configure), [Server API](https://vitehub.dev/docs/workflows/server-api), or [Hosts](https://vitehub.dev/docs/workflows/hosts).

Make each step idempotent and define terminal failure behavior. Keep request handlers small: start the run, return its id, and inspect the run separately.

Prove start, retry or resume, cancellation, and a terminal result. Inspect provider state instead of assuming the request process owns the run.
