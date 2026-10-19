# KV

<!-- Generated from docs/content/docs/kv/index.md. Edit the agent-only block there. -->

Source page: https://vitehub.dev/raw/docs/kv.md

Use KV for small values addressed by a key, such as flags, cursors, short-lived state, or counters that do not require relational queries.

Read [Get started](https://vitehub.dev/raw/docs/kv/get-started.md), [Configure](https://vitehub.dev/raw/docs/kv/configure.md), [Server API](https://vitehub.dev/raw/docs/kv/server-api.md), or [Hosts](https://vitehub.dev/raw/docs/kv/hosts.md).

Choose the driver in Vite config. Keep key names and serialization in application code. KV operations are not a substitute for atomic Rate Limit enforcement or relational transactions.

Prove put, get, list with a prefix, and delete. Restart local storage or query the hosted provider to confirm the durability you need.
