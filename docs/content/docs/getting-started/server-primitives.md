---
title: Server Primitives
description: Add storage, queues, schedules, email, and other server APIs to a Vite app on any supported host.
navigation.title: Server Primitives
navigation.order: 1.5
icon: i-lucide-server-cog
---

Server Primitives are APIs for storage, background work, auth, and other
server features. Call them from your routes, handlers, or jobs. Each package
has its own configuration and server API.

Follow [your first Server Primitive](/docs/getting-started/first-server-primitive)
to save and read a value locally. Then choose the feature your app needs.
You can add Agents later if your product needs them.

## Pick the right primitive

| You need | Start with |
| --- | --- |
| Public, server, build-time, runtime, or secret environment values | [Env](/docs/env) |
| Application users, sessions, Better Auth routing, or guarded app routes | [Auth](/docs/auth) |
| Provider accounts that the app owns, with OAuth refresh, access rules, and call activity | [Connections](/docs/connections) |
| Request budgets that must be consumed before expensive server work starts | [Rate Limit](/docs/rate-limit) |
| Outbound transactional messages with provider-neutral delivery | [Email](/docs/email) |
| Named outbound message destinations, such as Telegram or Teams, behind selected connectors | [Channels](/docs/channels) |
| Small key-addressed values, settings, flags, cursors, or lightweight state | [KV](/docs/kv) |
| Relational data, constraints, joins, migrations, or queryable history | [Database](/docs/database) |
| Uploads, generated artifacts, binary files, or object metadata | [Blob](/docs/blob) |
| Provider-backed browser sessions, screenshots, DOM inspection, or live handoff | [Browser](/docs/browser) |
| Persistent file-tree state, snapshots, diffs, rules, or sessions | [Workspace](/docs/workspace) |
| Collaborative Markdown editing, presence, and Workspace checkpoints | [Realtime](/docs/realtime) |
| Read-only retrieval from files, globs, GitHub, markdown, MCP, or custom loaders | [Source](/docs/source) |
| Parse, query, search, and serve content from Sources | [Content](/docs/content) |
| Background delivery that returns before work finishes | [Queue](/docs/queue) |
| Durable long-running work with provider-tracked run state | [Workflows](/docs/workflows) |
| Static cron output or recurring runtime schedules | [Schedule](/docs/schedule) |
| Isolated provider-managed execution | [Sandbox](/docs/sandbox) |
| Controlled Unix-like command sessions | [Shell](/docs/shell) |

## Call a feature from a route

Most primitives expose the same application import on every host. ViteHub connects that import to the selected provider during the build.

```ts [server/api/settings.put.ts]
import { kv } from 'vite-hub/kv'

export default defineEventHandler(async (event) => {
  const [error] = await kv.set('settings', await readBody(event))
  if (error) throw error
  return { ok: true }
})
```

The route doesn't need to know whether KV uses local files, Cloudflare, Vercel, or another driver.

## Add a Definition when the feature needs one

A Queue needs a handler Definition. A Database needs a schema Definition.
The tutorial for each feature shows the file to create. ViteHub discovers
these files during development and build.

Read [Definition discovery](/docs/development/definition-discovery) for names
and [File conventions](/docs/reference/file-conventions) for locations.
Check [Configuration](/docs/reference/config-options) when you need options
beyond the tutorial.

## Give an Agent a selected operation

Your server can call each feature directly. An Agent needs a Capability
that exposes the selected operation. For example, the
[KV capability](/docs/kv/agent-capability) can give an Agent access to stored
values, and the [Workspace capability](/docs/workspace/agent-capability) can
give it access to files.

Add a Capability only when the Agent needs it. Set its scope, write mode,
and approval policy for the task. Read
[Capabilities](/docs/agents/capabilities) to choose an operation and check
which constraints it supports.

## Choose a host

Your host determines the resources and limits behind an API. Open
[Build and deploy](/docs/getting-started/build-and-deploy) to select a preset,
then check the feature's Hosts page. Verify the generated bindings and
resource identities before you connect production data.
