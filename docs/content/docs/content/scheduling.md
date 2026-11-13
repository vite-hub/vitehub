---
title: Schedule Content publishing
description: "Publish reviewed drafts later with content.schedule(), run due schedules from a Schedule Definition, and inspect pending, overdue, and failed schedules."
navigation.title: Scheduling
navigation.order: 11
icon: i-lucide-calendar-clock
---

`content.schedule()` publishes reviewed drafts later. A Schedule Definition (a cron file) runs them with `content.publishDue()` on every host that runs [Schedule](/docs/schedule).

The examples on this page schedule documents of this `posts` collection:

```ts [server/content.ts]
import { cms } from 'vite-hub/cms'
import { defineContent } from 'vite-hub/content'
import { documents } from 'vite-hub/content/collections'
import { z } from 'zod'

export default defineContent({
  extends: cms,
  collections: {
    posts: documents({ path: 'posts/**/*.md', fields: { title: z.string() } }),
  },
})
```

```ts [server/utils/schedule-launch.ts]
import content from '../content'

export async function scheduleLaunch() {
  const posts = content.collection('posts')
  const { draft } = (await posts.status('launch'))!

  const schedule = await content.schedule({
    at: '2026-10-20T09:00:00+02:00',
    expect: [{ collection: 'posts', id: 'launch', digest: draft }],
    message: 'Publish the launch post',
  })
  // { id, at: '2026-10-20T07:00:00.000Z', status: 'pending', expect, message, createdAt }
  return schedule
}
```

## Run due schedules

Add a Schedule Definition that calls `content.publishDue()`, and turn on Schedule:

```ts [server/schedules/content-publish.ts] fragment
import { defineSchedule } from 'vite-hub/schedule'
import content from '../content'

export default defineSchedule({
  cron: '* * * * *',
  manual: true,
  handler: () => content.publishDue(),
})
```

::tabs{sync="framework"}
:::tabs-item{label="Nuxt"}
```ts [nuxt.config.ts]
export default defineNuxtConfig({
  modules: ['vite-hub/nuxt'],
  vitehub: { host: 'cloudflare', schedule: true },
})
```
:::

:::tabs-item{label="Nitro"}
```ts [vite.config.ts]
import { nitro } from 'nitro/vite'
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [vitehub({ host: 'cloudflare', schedule: true }), nitro()],
})
```
:::

:::tabs-item{label="Vite"}
```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [vitehub({ host: 'cloudflare', schedule: true })],
})
```
:::
::

Each run publishes every due schedule, earliest first, and returns `{ published, failed }`. `published` lists `{ schedule, revision, documents }` per schedule. Without a runner, schedules stay pending and turn [overdue](#statuses).

If Schedule is off, or no definition calls `publishDue()`, the Console turns off **Schedule…** and shows this fix. It reads the definitions at build time, so call `publishDue()` in the definition file itself, not in a helper.

| Host | What runs `publishDue()` | When a schedule publishes |
| --- | --- | --- |
| Cloudflare | A Cron Trigger from the Schedule Definition. | Within a minute of `at`. |
| Vercel | A Vercel Cron Job. Hobby projects run cron jobs once a day, so use a daily cron there. | Within a minute on Pro. At the next daily run on Hobby. |
| Netlify | A Scheduled Function. | Within a minute of `at`. |
| Node or Docker | The Schedule [Process Runtime](/docs/schedule/hosts) in one long-lived replica. | Within its scan interval, at most a minute. |
| Development | `pnpm vitehub schedule run content-publish` on Vite + Nitro, because the definition sets `manual: true`, or the Process Runtime. | When you run it. |

Runs can overlap, for example from two replicas. Each publish checks the digests, so each schedule settles once. On another error, such as a store that is down, the schedule stays pending and the Schedule Run records the error.

## Publish only what was reviewed

`schedule()` takes the same `expect` entries as [`publish({ expect })`](/docs/content/server-api#publish-what-was-reviewed): each document with the draft digest (content hash) you reviewed. Omit `id` for a singleton. `digest: null` publishes a deletion.

- The digests must match the draft when you schedule. If not, `schedule()` throws `WORKSPACE_CONFLICT` with the same `details` as `publish()`.
- The run calls `publish({ expect })`. If someone saved the draft after scheduling, it publishes nothing. The schedule turns `failed` with `failure`: `{ at, code: 'WORKSPACE_CONFLICT', message, details: { ref: 'draft', documents } }`. A draft that no longer validates fails with `CONTENT_INVALID`.
- A failed schedule does not move to the new, unreviewed draft. Review it and schedule again. `unschedule()` dismisses the failed one.

`schedule()` throws `CONTENT_INVALID` when a draft has field issues, and names each one in `details.documents`. It throws `CONTENT_R0011` when:

- `at` is not in the future, or is a string without a time zone.
- Every document is already published as reviewed.
- A document already has a pending schedule. Call `unschedule()` first.

## Statuses

| `status` | Meaning |
| --- | --- |
| `pending` | Waits for `at`, or for the next run after it. |
| `overdue` | More than five minutes past `at` without a run. No runner fired, or it runs less often, such as daily. The next run still publishes it. |
| `failed` | A run published nothing because a draft changed or no longer validates. It stays until `unschedule()`. |

`status()` shows each document's pending, overdue, or else failed schedule as `schedule: { id, at, status, digest, failure? }`. `state` stays `draft`, `changed`, or `deleted` until it publishes. If `schedule.digest` differs from `draft`, the run will fail.

```ts [server/utils/launch-status.ts]
import content from '../content'

export async function launchStatus() {
  return await content.collection('posts').status('launch')
  // { state: 'draft', draft: 'a1…', published: null, schedule: { id, at: '2026-10-20T07:00:00.000Z', status: 'pending', digest: 'a1…' } }
}
```

## Inspect and cancel

| Method | Behavior |
| --- | --- |
| `content.schedule({ at, expect, message?, metadata? })` | Stores a schedule and returns it. `at` is a `Date` or an ISO timestamp with a time zone. `message` and `metadata` go on the publish revision too. |
| `content.schedules({ collection?, id?, status? })` | Pending, overdue, and failed schedules, earliest first. |
| `content.unschedule(id, { message?, metadata? })` | Cancels a pending schedule or dismisses a failed one. Throws `CONTENT_NOT_FOUND` when it already ran or is gone. |
| `content.publishDue({ now? })` | Runs due schedules. `now` defaults to the current time. |

A schedule that ran is removed. Its publish revision on `published` has the schedule id in `metadata.content.schedule`, plus the schedule's `message` and `metadata`.

Each schedule is one JSON file, named by its id, on the `schedules` ref of the Content Workspace. Every schedule, cancel, run, and failure is a revision on that ref. Its `metadata.content.action` is `schedule`, `unschedule`, `schedule-published`, or `schedule-failed`. Read the history with the Workspace history API:

```ts
import { useWorkspace } from 'vite-hub/workspace'

const { revisions } = await useWorkspace('content').history.list({ ref: 'schedules' })
```

Schedules need no other storage and are as durable as the Workspace history. Each change is a compare-and-swap on the `schedules` head, so concurrent writers retry instead of overwriting.

## Access

Runtime methods are trusted server API and skip `authorize`. To schedule or cancel in the [Console](/docs/content/console) or other surfaces, a user needs `publish` access to every document in it. The run has no user, so the check happens at scheduling time.

## Console

The arrow next to **Publish** opens **Schedule…**. It saves pending edits, then asks for a date and time in your browser's time zone, shown next to the inputs. A scheduled document's header shows:

- **Scheduled · Oct 20, 09:00**.
- **Overdue** when no run published it on time. The tooltip says to add a [runner](#run-due-schedules) or check that it runs on this host.
- **Schedule failed**, with the reason in its tooltip. It names no documents, because the user may not be able to read all of them.

Saving after scheduling shows a reminder that the run will publish nothing. The **…** menu cancels or dismisses a schedule.

The document list has a **Scheduled** tab while a document has a schedule. The Content dashboard lists all of them, soonest first, under **Scheduled**. The owner action `overview` returns them as `collections[].scheduled`.

## Limits

- One pending schedule per document. From server code, a schedule can span collections. The Console schedules one collection at a time.
- Precision is the runner interval: within a minute with a per-minute cron, later with a slower one.
- `publishDue()` reads every schedule file on each run. Keep at most a few thousand schedules.
- The [CLI](/docs/content/cli) has `schedule`, `scheduled`, and `unschedule`. You can also use `content.schedules()` in server code, the Console, or the Workspace history.
