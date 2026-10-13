---
title: Realtime configuration
description: Choose the room authority that keeps Realtime collaborative state and check Realtime limits.
navigation.title: Configure
navigation.order: 3
icon: i-lucide-sliders-horizontal
---

## Choose a room authority

Set the authority with the `realtime.authority` option of `vitehub()`, as in [Get started](/docs/realtime/get-started#configure-realtime).

| Authority | Use |
| --- | --- |
| `auto` | Uses Cloudflare Durable Objects when Realtime can resolve a Cloudflare Nitro preset or hosting environment. With only `vitehub({ preset: 'cloudflare' })` during Vite development, set `authority: 'cloudflare'` explicitly. Other development presets use memory; other production builds fail until an authority is selected. |
| `cloudflare` | Generates a SQLite-backed Durable Object binding and migration. Use it for durable, distributed rooms on Cloudflare. |
| `memory` | Keeps rooms in one process. Use it for local development or an explicitly single-process Node deployment. Room state is lost when the process stops. |

ViteHub rejects the memory authority on distributed host presets. It also
rejects a Cloudflare authority paired with another deployment preset.

## Limits

| Boundary | Limit |
| --- | --- |
| WebSocket message | 1 MiB |
| Document state per room | 8 MiB |
| Awareness state per room | 8 MiB |
| Awareness clients per peer | 1,024 |
| Active rooms under the memory authority | 128, with inactive clean rooms evicted first |
