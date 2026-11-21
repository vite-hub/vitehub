---
title: Webhooks hosts
description: Check which Queue and Database Webhooks uses on Node, Cloudflare, and Vercel, how long a debounce can wait, and how retries differ.
navigation.title: Hosts
navigation.order: 5
icon: i-lucide-cloud-cog
---

Webhooks stores each delivery in the Default Database and sends it through the Queue. So a host needs a [Queue provider](/docs/queue/configure) and a SQLite Default Database.

## Host support

| Host | Queue | Default Database | Works |
| --- | --- | --- | --- |
| `vite dev` | Jobs run in the dev server | A SQLite file in `.vitehub/data` | Yes |
| Node, Docker | `local`: jobs on disk, one server process | A SQLite file on a lasting disk, or libSQL such as Turso | Yes |
| Cloudflare Workers | Cloudflare Queues | Cloudflare D1 | Yes |
| Vercel | Vercel Queues | libSQL, such as Turso | Yes |
| Netlify | No Queue provider | | No |
| Node with a Postgres Default Database | `postgres` | Postgres | No. The table needs SQLite. |

In `vite dev`, the Queue follows the delay and retry rules of the build's provider, so a debounce and a retry act as on the host. See [Queue dev delivery](/docs/queue/limits-and-errors#dev-delivery).

## Debounce and retries on each host

Webhooks counts the attempts of a delivery itself. After 4 attempts it marks the delivery `dead`, on every host. The Queue of the host decides when the next attempt runs.

| Rule | Cloudflare | Vercel | Node and `vite dev` |
| --- | --- | --- | --- |
| Longest Queue delay | 24 hours | 7 days | No limit |
| Longest `debounce` | 24 hours | 24 hours | 24 hours |
| Wait before a retry | None | 60 seconds | 1, 2, then 4 seconds |

The debounce limit is the shortest Queue delay of all hosts, the 24 hours of Cloudflare Queues. So a webhook works the same when you move it to another host. Hosted Queues take whole seconds, so a debounce waits at least until the next whole second.

## Node and Docker

The `local` Queue keeps jobs in `.vitehub/data/queue`, and the default SQLite file is in `.vitehub/data` too. In Docker, mount `.vitehub/data` as a volume, or a new container loses the pending deliveries and their wakes. Run one server process for each folder. See [Queue local delivery](/docs/queue/limits-and-errors#local-delivery).

With several Node instances, use a libSQL Database such as Turso for the deliveries. The `local` Queue still runs each wake on the instance that sent it.

## Cloudflare

Use a D1 Default Database. ViteHub adds the `vitehub-webhooks` queue to `wrangler.json` with the other Queue Definitions. Set `T3_WEBHOOK_URL` and `T3_WEBHOOK_SECRET`, or your own variable names, as Worker secrets.

## Vercel

Use a libSQL Default Database, such as Turso, with its variables in the project settings. Vercel Queues needs `@vercel/queue` and `@vercel/functions` in the app. See [Queue hosts](/docs/queue/hosts).
