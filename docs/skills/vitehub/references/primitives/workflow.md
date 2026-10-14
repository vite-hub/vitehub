# Workflows

Use Workflows for provider-tracked work that can outlive a request and needs durable state, retries, or steps. A run id is the handle for inspection.

Read the [Workflows guide](https://vitehub.dev/raw/docs/workflows.md), then [Get started](https://vitehub.dev/raw/docs/workflows/get-started.md), [Configure](https://vitehub.dev/raw/docs/workflows/configure.md), [Server API](https://vitehub.dev/raw/docs/workflows/server-api.md), or [Hosts](https://vitehub.dev/raw/docs/workflows/hosts.md).

Make each step idempotent and define terminal failure behavior. Keep request handlers small: start the run, return its id, and inspect the run separately.

Prove start, retry or resume, cancellation, and a terminal result. Inspect provider state instead of assuming the request process owns the run.
