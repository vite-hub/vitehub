---
title: Nuxt server folders and auto-imports
description: The server folders that the vite-hub/nuxt module scans, and the server helpers that it auto-imports for each feature.
navigation.title: Nuxt server auto-imports
navigation.order: 41.6
navigation.group: Frameworks
icon: i-lucide-folder-tree
---

On Nuxt 5, server code imports ViteHub helpers from their `vite-hub/*` paths.
Server auto-imports are off by default, as they are for the Nitro and H3
helpers.

```ts [server/api/welcome.post.ts] fragment
import { kv } from 'vite-hub/kv'
import { sendQueue } from 'vite-hub/queue'
import { createError, defineEventHandler, readBody } from 'nitro/h3'

export default defineEventHandler(async (event) => {
  const body = await readBody<{ email?: unknown }>(event)
  const email = typeof body?.email === 'string' ? body.email.trim() : ''
  if (!email) throw createError({ status: 400, message: 'Email is required.' })
  const [queueError] = await sendQueue('welcome-email', { email })
  if (queueError) throw queueError
  try {
    const [kvError] = await kv.set(`welcome:${email}`, 'queued')
    if (kvError) throw kvError
  } catch (error) {
    console.error('Could not save the welcome queue status.', error)
  }
  return { queued: true }
})
```

The response confirms that the queue accepted the job. If saving the status in KV fails, the route logs the error and still confirms the enqueue.

## Migrate an app

An app that used the ViteHub auto-imports before Nuxt 5 can import them with
one codemod:

```bash [Terminal]
npx @vite-hub/codemods nuxt-server-imports [dir] [--dry-run]
```

It adds the import of each helper that a server file uses without one. It
leaves names that your app gives itself, such as `db` from
`server/utils/db.ts`. `vitehub migrate` runs it too. See
[Upgrade ViteHub](/docs/codemods/upgrade-vitehub#nuxt-server-imports).

## Turn server auto-imports on

ViteHub follows Nuxt's own switch. It adds no option of its own.
Install `@vite-hub/kv` and `@vite-hub/queue` for this example.

```ts [nuxt.config.ts]
export default defineNuxtConfig({
  modules: [['vite-hub/nuxt', { kv: true, queue: true }]],
  experimental: { nitroAutoImports: true },
})
```

With the switch on, Nuxt auto-imports the Nitro and H3 helpers, and the
`vite-hub/nuxt` module auto-imports the server helpers in the table below.
`nitroLegacy: true`, or a `nitroLegacy` object without `imports: false`, also
turns them on.

```ts [server/api/welcome.post.ts] fragment
export default defineEventHandler(async (event) => {
  const body = await readBody<{ email?: unknown }>(event)
  const email = typeof body?.email === 'string' ? body.email.trim() : ''
  if (!email) throw createError({ status: 400, message: 'Email is required.' })
  const [queueError] = await sendQueue('welcome-email', { email })
  if (queueError) throw queueError
  try {
    const [kvError] = await kv.set(`welcome:${email}`, 'queued')
    if (kvError) throw kvError
  } catch (error) {
    console.error('Could not save the welcome queue status.', error)
  }
  return { queued: true }
})
```

Explicit imports from `vite-hub/*` also work with the switch on. They are the
same functions.

## Folders and auto-imports

The module scans the server directory of the app and of each Nuxt layer. The
auto-imports apply only when Nuxt server auto-imports are on.

| Feature | Option | Folder that the module scans | Server auto-imports |
| --- | --- | --- | --- |
| Agent | `agent` | `server/agents/` | `runAgent`, `streamAgent` |
| Auth | `auth` | `server/auth.ts` | `can`, `requireAbility`, `requireAuth`, `requireAuthorization`, `useAuth`, `withAnonymousAuthorization`, `withAuth`, `withAuthorization` |
| Blob | `blob` | None | `blob` |
| Browser | `browser` | `server/browsers/` | `defineBrowser`, `runBrowser` |
| Channels | `channels` | `server/channels/` | `defineChannel`, `useChannel` |
| Comments | `comments` | `server/comments.ts` | None |
| Connections | `connections` | `server/connections/` | `defineConnection`, `useConnection` |
| Database | `database` | `server/databases/` | `db`, `schema`, `useDatabase` |
| Email | `email` | `server/emails/` (Markdown templates) | `email` |
| Env | On unless `env: false` | None | `useServerEnv` |
| I18n | `i18n` | None. Messages are collected from source files; translations live in `locales/` or the configured Workspace. | `getRequestI18n`, `useTranslations` |
| KV | `kv` | None | `kv` |
| Queue | `queue` | `server/queues/` | `defineQueue`, `deferQueue`, `useQueue`, `sendQueue` |
| Rate Limit | `rateLimit` | None. The build reads the `requireRateLimit()`, `checkRateLimit()`, and `refundRateLimit()` calls in server files. | `checkRateLimit`, `peekRateLimit`, `refundRateLimit`, `requireRateLimit`, `resetRateLimit` |
| Realtime | `realtime` | `server/realtime/` | `defineRealtime`, `isRealtimeAvailable`, `refreshRealtimeDocument` |
| Sandbox Task | `sandboxTask` | `server/sandbox-tasks/` | `runSandboxTask` |
| Schedule | `schedule` | `server/schedules/` | `cancelSchedule`, `getSchedule`, `listSchedules`, `startSchedule` |
| SEO | `seo: { sitemap }` | `server/sitemap.ts` | `defineSitemap` |
| Source | Always on | `server/sources/` | `useSource` |
| Workflow | `workflow` | `server/workflows/` | `cancelWorkflow`, `deferWorkflow`, `getWorkflowRun`, `resumeWorkflow`, `startWorkflow` |
| Workspace | `workspace` | `server/workspaces/` | `useWorkspace` |

- A feature that is off adds no auto-imports. A host without the service adds
  none either. For example, `queue: true` on Netlify adds no Queue helpers.
- [File conventions](/docs/reference/file-conventions) shows the file names in
  each folder and the suffix form, such as `<path>.queue.ts`.
- `useServerEnv` comes from `vite-hub/env`. Its
  type follows your Env declarations.

## Definition files that keep their imports

ViteHub also loads some Definition files outside Nitro, for example in the
Vite dev server or in a separate provider bundle. Nitro auto-imports do not
exist there. These files and all modules they load must import every helper
they use, including runtime helpers such as `kv` inside handlers:

| Helper | Import |
| --- | --- |
| `defineAgent` | `vite-hub/agent` |
| `defineAuth` | `vite-hub/auth` |
| `defineComments` | `vite-hub/comments` |
| `defineDatabase` | `vite-hub/database` |
| `defineSchedule` | `vite-hub/schedule` |
| `defineWorkflow` | `vite-hub/workflow` |
| `defineWorkspace` | `vite-hub/workspace` |

This rule applies to Schedule and Workflow Definitions on every host, so
the same files work when the deployment preset changes. It also applies
to Workflow step files. For example:

```ts [server/schedules/cleanup.ts]
import { kv } from 'vite-hub/kv'
import { defineSchedule } from 'vite-hub/schedule'

export default defineSchedule({
  cron: '0 0 * * *',
  async handler() {
    const [error] = await kv.delete('expired')
    if (error) throw error
  },
})
```

With server auto-imports on, routes and other files that Nitro alone loads can
use the runtime auto-imports in the table.

## Types

Nuxt writes the declarations of all server auto-imports to
`.nuxt/types/server-imports.d.ts` when it prepares the app. Each ViteHub
auto-import has the type of its `vite-hub/*` export, so `nuxt typecheck`
checks the calls. With the switch off, the file declares no ViteHub helpers,
and `nuxt typecheck` reports a name such as `kv` that the file does not import.

## Names that another source owns

ViteHub does not use a name that Nuxt, Nitro, or H3 auto-imports, such as
`getSession`, `useSession`, `defineTask`, or `useStorage`.

When another source gives the same name, that source wins. ViteHub skips its
entry and logs one warning that names both sources. This is true for
`server/utils/` files, `nitro.imports.imports` entries, and other modules. For
example, `server/utils/db.ts` that exports `db` replaces the ViteHub `db`.
Import the ViteHub helper from its `vite-hub/*` path where you need it.

## Turn auto-imports off

Leave `experimental.nitroAutoImports` off. Nuxt's other switches also stop the
ViteHub server auto-imports:

- `nitro: { imports: false }` turns off all server auto-imports, also for
  `server/utils/`.
- `imports: { autoImport: false }` turns off all auto-imports in the project,
  in the app and in server code.

With auto-imports off, import each helper from its `vite-hub/*` path.
