---
title: Schedule Content publishing
description: Publish reviewed drafts at a later time with content.schedule(), run due schedules from a Schedule Definition on every host, and inspect pending, overdue, and failed schedules.
navigation.title: Scheduling
navigation.order: 5
icon: i-lucide-calendar-clock
---

`content.schedule()` publishes exactly the drafts that were reviewed, at a later time. A Schedule Definition that calls `content.publishDue()` runs due schedules, so publishing works on every host that runs [Schedule](/docs/schedule).

```ts
const posts = content.collection('posts')
const { draft } = (await posts.status('launch'))!

const schedule = await content.schedule({
  at: '2026-10-20T09:00:00+02:00',
  expect: [{ collection: 'posts', id: 'launch', digest: draft }],
  message: 'Publish the launch post',
})
// { id, at: '2026-10-20T07:00:00.000Z', status: 'pending', expect, message, createdAt }
```

## Run due schedules

Add one Schedule Definition that calls `content.publishDue()`, and enable Schedule:

```ts [server/schedules/content-publish.ts]
import { defineSchedule } from 'vite-hub/schedule'
import { content } from '../content'

export default defineSchedule({
  cron: '* * * * *',
  manual: true,
  handler: () => content.publishDue(),
})
```

```ts [vite.config.ts]
vitehub({ preset: 'cloudflare', schedule: true })
```

Each run publishes every pending or overdue schedule whose time has come, earliest first, and returns `{ published, failed }`. `published` lists `{ schedule, revision, documents }` for each schedule that ran. Content does not wake on its own: without a runner, schedules stay pending and turn [overdue](#statuses).

The Console reads the Schedule Definitions at build time, without running them. When Schedule is off, or no Schedule Definition file calls `publishDue()`, the editor turns off **Schedule…** and names this fix. Call `content.publishDue()` in the Schedule Definition file itself: discovery does not follow a helper in another file.

| Host | What runs `publishDue()` | When a schedule publishes |
| --- | --- | --- |
| Cloudflare | A Cron Trigger from the Schedule Definition. | Within a minute of `at`. |
| Vercel | A Vercel Cron Job. Hobby projects run cron jobs once a day, so use a daily cron there. | Within a minute on Pro, or at the next daily run on Hobby. |
| Netlify | A Scheduled Function. | Within a minute of `at`. |
| Node or Docker | The Schedule [Process Runtime](/docs/schedule/hosts) in one long-lived replica. | Within its scan interval, at most a minute. |
| Development | `pnpm vitehub schedule run content-publish` on Vite + Nitro, because the definition sets `manual: true`, or the Process Runtime. | When you run it. |

Runs may overlap, for example from two replicas: each publish checks the reviewed digests, and each schedule settles once. A run that hits another error, such as an unavailable store, leaves the schedule pending, and the Schedule Run records the error.

## Publish only what was reviewed

`schedule()` takes the same `expect` entries as [`publish({ expect })`](/docs/content/server-api#publish-what-was-reviewed): every document to publish, with the draft digest that was reviewed. Omit `id` for a singleton. `digest: null` publishes a deletion.

- The digests must match the draft when you schedule. Otherwise `schedule()` throws `WORKSPACE_CONFLICT` with the same `details` as `publish()`.
- At its time, the run calls `publish({ expect })`. A draft saved after scheduling makes the run publish nothing. The schedule turns `failed` and keeps the error in `failure`: `{ at, code: 'WORKSPACE_CONFLICT', message, details: { ref: 'draft', documents } }`. A draft that no longer validates fails the same way with `CONTENT_INVALID`.
- A failed schedule is not moved to the new draft. That draft was not reviewed, so someone has to review it and schedule again. `unschedule()` dismisses the failed one.

`schedule()` throws `CONTENT_INVALID` when a draft still has field issues, naming each one in `details.documents`. It also throws `CONTENT_R0011` when `at` is not in the future, when `at` is a string without a time zone, when every document is already published as reviewed, or when a document already has a pending schedule. Call `unschedule()` before you schedule that document again.

## Statuses

| `status` | Meaning |
| --- | --- |
| `pending` | Waits for `at`, or for the next run after it. |
| `overdue` | More than five minutes past `at` without a run. No runner fired, or it runs less often, such as daily. The next run still publishes it. |
| `failed` | A run published nothing because a draft changed or no longer validates. It stays until `unschedule()`. |

`status()` of a collection reports each document's schedule as `schedule: { id, at, status, digest, failure? }`: its pending or overdue schedule, or else a failed one. `state` stays `draft`, `changed`, or `deleted` until the schedule publishes. When `schedule.digest` differs from `draft`, the run will fail.

```ts
await content.collection('posts').status('launch')
// { state: 'draft', draft: 'a1…', published: null, schedule: { id, at: '2026-10-20T07:00:00.000Z', status: 'pending', digest: 'a1…' } }
```

## Inspect and cancel

| Method | Behavior |
| --- | --- |
| `content.schedule({ at, expect, message?, metadata? })` | Stores a schedule and returns it. `at` is a `Date` or an ISO timestamp with a time zone. `message` and `metadata` go on the publish revision too. |
| `content.schedules({ collection?, id?, status? })` | Pending, overdue, and failed schedules, earliest first. |
| `content.unschedule(id, { message?, metadata? })` | Cancels a pending schedule or dismisses a failed one. Throws `CONTENT_NOT_FOUND` when it already ran or is gone. |
| `content.publishDue({ now? })` | Runs due schedules. `now` defaults to the current time. |

A schedule that ran is removed. Its publish revision on `published` carries `metadata.content.schedule` with the schedule id, plus the schedule's `message` and `metadata`.

Schedules are files on the `schedules` ref of the Content Workspace, one JSON file per schedule, named by its id. Every schedule, cancel, run, and failure is a revision on that ref, with `metadata.content.action` set to `schedule`, `unschedule`, `schedule-published`, or `schedule-failed`. Read the full history with the Workspace history API:

```ts
import { useWorkspace } from 'vite-hub/workspace'

const { revisions } = await useWorkspace('site').history.list({ ref: 'schedules' })
```

Schedules need no other storage: they live, and are durable, wherever the Workspace history is. Every change is a compare-and-swap on the `schedules` head, so concurrent writers retry instead of overwriting each other.

## Access

The runtime methods are trusted server API and do not call `authorize`. The [Console](/docs/content/console) and other surfaces require `publish` access to every document of a schedule, both to schedule and to cancel it. A schedule runs later without a user, so the access check happens when someone schedules it.

## Console

The arrow next to the editor's **Publish** button opens **Schedule…**. It saves pending edits first, then asks for a date and time in your browser's time zone, shown next to the inputs. A scheduled document shows **Scheduled · Oct 20, 09:00** in the header, **Overdue** when no run published it on time, or **Schedule failed** with the reason in its tooltip. The **Overdue** tooltip names the fix: add a [runner](#run-due-schedules) when the app has none, or check that it runs on this host. Saving the document again after scheduling shows a reminder: that run will publish nothing. The **…** menu cancels a schedule or dismisses a failed one.

The document list has a **Scheduled** tab while any document of the collection has a schedule, and the Content dashboard lists every scheduled publish, soonest first, under **Scheduled**. The Console owner action `overview` returns them as `collections[].scheduled`.

## Limits

- One pending schedule per document. A schedule may span collections from server code. The Console schedules documents of one collection at a time.
- Precision is the runner interval: within a minute with a per-minute cron, later with a less frequent one.
- `publishDue()` reads every schedule file on each run. Keep a few thousand schedules at most.
- There is no CLI command for Content schedules yet. Use `content.schedules()` from server code, the Console, or the Workspace history.
