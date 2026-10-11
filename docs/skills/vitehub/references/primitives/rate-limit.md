# Rate Limit

Use Rate Limit to guard an action with an atomic counter and a defined window. Put identity derivation in the caller or Agent Capability.

Read the [Rate Limit guide](https://vitehub.dev/docs/rate-limit), then [Get started](https://vitehub.dev/docs/rate-limit/get-started), [Server API](https://vitehub.dev/docs/rate-limit/server-api), [Hosts](https://vitehub.dev/docs/rate-limit/hosts), or [Limits and errors](https://vitehub.dev/docs/rate-limit/limits-and-errors).

Choose a provider whose guarantees match the action. Memory is local to one process. Inspect `.vitehub/rate-limit/manifest.json` before a production deploy. Do not replace a Rate Limit with a KV read followed by a write.

Prove allowed, rejected, reset, and provider failure behavior. Check the resolved window and enforcement mode in generated inspection state.
