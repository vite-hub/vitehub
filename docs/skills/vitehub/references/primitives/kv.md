# KV

Use KV for small values addressed by a key, such as flags, cursors, short-lived state, or counters that do not require relational queries.

Read the [KV guide](https://vitehub.dev/docs/kv), then [Get started](https://vitehub.dev/docs/kv/get-started), [Configure](https://vitehub.dev/docs/kv/configure), [Server API](https://vitehub.dev/docs/kv/server-api), or [Hosts](https://vitehub.dev/docs/kv/hosts).

Choose the driver in Vite config. Keep key names and serialization in application code. KV operations are not a substitute for atomic Rate Limit enforcement or relational transactions.

Prove put, get, list with a prefix, and delete. Restart local storage or query the hosted provider to confirm the durability you need.
