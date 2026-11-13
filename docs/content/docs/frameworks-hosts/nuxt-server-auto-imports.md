---
title: Nuxt server folders and auto-imports
description: The server folders that the vite-hub/nuxt module scans, and the server helpers that it auto-imports for each feature.
navigation.title: Nuxt server auto-imports
navigation.order: 41.6
navigation.group: Frameworks
icon: i-lucide-folder-tree
---

On Nuxt 5, the `vite-hub/nuxt` module auto-imports the server helpers of each
feature that you turn on. Nitro server code uses them without an import.
Definition files that ViteHub loads outside Nitro must keep explicit imports,
as described below.

```ts [server/api/welcome.post.ts] fragment
import { defineEventHandler, readBody } from 'nitro/h3'

export default defineEventHandler(async (event) => {
  const { email } = await readBody<{ email: string }>(event)
  const [error] = await sendQueue('welcome-email', { email })
  if (error) throw error
  await kv.set(`welcome:${email}`, 'queued')
  return { queued: true }
})
```

`sendQueue` and `kv` need no import. Nuxt 5 does not auto-import Nitro and H3
helpers such as `defineEventHandler` unless you turn on
`experimental.nitroAutoImports`, so this example imports them.

Explicit imports from `vite-hub/*` also work. They are the same functions.

## Folders and auto-imports

The module scans the server directory of the app and of each Nuxt layer.

| Feature | Option | Folder that the module scans | Server auto-imports |
| --- | --- | --- | --- |
| Agent | `agent` | `server/agents/` | `runAgent`, `streamAgent` |
| Auth | `auth` | `server/auth.ts` | `auth`, `can`, `getAuth`, `requireAbility`, `requireAuth`, `requireAuthorization`, `useAuth`, `withAnonymousAuthorization`, `withAuth`, `withAuthorization` |
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
| Rate Limit | `rateLimit` | None. The build reads the `requireRateLimit()` and `checkRateLimit()` calls in server files. | `checkRateLimit`, `peekRateLimit`, `requireRateLimit`, `resetRateLimit` |
| Realtime | `realtime` | `server/realtime/` | `defineRealtime`, `isRealtimeAvailable`, `refreshRealtimeDocument` |
| Sandbox Task | `sandboxTask` | `server/sandbox-tasks/` | `runSandboxTask` |
| Schedule | `schedule` | `server/schedules/` | `cancelSchedule`, `getSchedule`, `listSchedules`, `startSchedule` |
| Workflow | `workflow`, or enabled through `agent` | `server/workflows/` | `cancelWorkflow`, `deferWorkflow`, `getWorkflowRun`, `resumeWorkflow`, `startWorkflow` |
| Workspace | `workspace` | `server/workspaces/` | `useWorkspace` |

- A feature that is off adds no auto-imports. A host without the service adds
  none either. For example, `queue: true` on Netlify adds no Queue helpers.
- Agent also enables Workflow unless `workflow: false`. On Netlify, Agent
  does not enable Workflow by default.
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

Routes and other files that Nitro alone loads can still use the runtime
auto-imports in the table.

## Types

Nuxt writes the declarations of all server auto-imports to
`.nuxt/types/server-imports.d.ts` when it prepares the app. Each ViteHub
auto-import has the type of its `vite-hub/*` export, so `nuxt typecheck`
checks the calls.

## Names that another source owns

ViteHub does not use a name that Nuxt, Nitro, or H3 auto-imports, such as
`getSession`, `useSession`, `defineTask`, or `useStorage`.

When another source gives the same name, that source wins and ViteHub skips
its entry. This is true for `server/utils/` files, `nitro.imports.imports`
entries, and other modules. For example, `server/utils/kv.ts` that exports
`kv` replaces the ViteHub `kv`.

## Turn auto-imports off

ViteHub uses Nuxt's own switches. It adds no option of its own.

```ts [nuxt.config.ts]
export default defineNuxtConfig({
  modules: ['vite-hub/nuxt'],
  // Turns off server auto-imports, also for `server/utils/`.
  nitro: { imports: false },
})
```

- `nitro: { imports: false }` turns off all server auto-imports.
- `imports: { autoImport: false }` turns off all auto-imports in the project,
  in the app and in server code.

With auto-imports off, import each helper from its `vite-hub/*` path.
