# Realtime

Use Realtime for collaborative state that changes while clients are connected. Realtime keeps room authority, document format, and durable checkpoints explicit.

Read the [Realtime guide](https://vitehub.dev/raw/docs/realtime.md), then [Get started](https://vitehub.dev/raw/docs/realtime/get-started.md), [Configure](https://vitehub.dev/raw/docs/realtime/configure.md), or [Server API](https://vitehub.dev/raw/docs/realtime/server-api.md). The Configure page describes host authority and persistence.

Choose Cloudflare authority for multi-instance production. Memory authority is single-process. Keep authentication and checkpoint retention in application policy.

Realtime is the collaboration layer for the supported document and editor
models. It does not replace Auth, Workspace persistence, or a general WebSocket
server.

Prove two clients joining, a concurrent edit, reconnect, and checkpoint recovery. Inspect the generated registry and handler for hosted output.
