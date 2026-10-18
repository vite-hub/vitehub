# Rate Limit

<!-- Generated from docs/content/docs/rate-limit/index.md. Edit the agent-only block there. -->

Source page: https://vitehub.dev/raw/docs/rate-limit.md

Use Rate Limit to guard an action with an atomic counter and a defined window. Put identity derivation in the caller or Agent Capability.

Read [Get started](https://vitehub.dev/raw/docs/rate-limit/get-started.md), [Server API](https://vitehub.dev/raw/docs/rate-limit/server-api.md), [Hosts](https://vitehub.dev/raw/docs/rate-limit/hosts.md), or [Limits and errors](https://vitehub.dev/raw/docs/rate-limit/limits-and-errors.md).

Choose a provider whose guarantees match the action. Memory is local to one process. Inspect `.vitehub/rate-limit/manifest.json` before a production deploy. Do not replace a Rate Limit with a KV read followed by a write.

Prove allowed, rejected, reset, and provider failure behavior. Check the resolved window and enforcement mode in generated inspection state.
