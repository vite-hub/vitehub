# @vite-hub/schedule

<p>
  <a href="https://vitehub.dev"><img alt="ViteHub" src="https://img.shields.io/badge/ViteHub-vitehub.dev-646cff?style=flat-square"></a>
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-ready-3178c6?style=flat-square">
  <img alt="Vite" src="https://img.shields.io/badge/Vite-discovery-646cff?style=flat-square">
  <img alt="Schedule" src="https://img.shields.io/badge/Schedule-cron%20runtime-0284c7?style=flat-square">
</p>

`@vite-hub/schedule` keeps cron definitions and runtime schedules behind one schedule registry.

## Install

```sh
pnpm add @vite-hub/schedule
```

Add `@vite-hub/kv` when runtime schedules should persist outside memory.

## Minimal API

```ts
// server/schedules/daily-report.ts
import { defineSchedule } from "@vite-hub/schedule"

export default defineSchedule({
  cron: "0 8 * * *",
  allowRuntimeSchedules: true,
  handler: async ({ scheduledAt }) => {
    console.log(`Generating daily report for ${scheduledAt.toISOString()}`)
  },
})
```

```ts
// server/api/schedules.post.ts
import { schedules } from "@vite-hub/schedule/runtime"
import { defineEventHandler } from "h3"

export default defineEventHandler(() => {
  return schedules.create({
    cron: "30 3 * * 1",
    target: "daily-report",
  })
})
```

```ts
// vite.config.ts
import { hubSchedule } from "@vite-hub/schedule/vite"
import { defineConfig } from "vite"

export default defineConfig({
  plugins: [hubSchedule()],
})
```

## Vite Integration

Use `hubSchedule()` in Vite to discover `server/schedules/<name>.ts` and `src/<name>.schedule.ts`. Static schedules can produce provider cron output, including [Vercel Cron Jobs](https://vercel.com/docs/cron-jobs/). For Nitro apps on Cloudflare, Schedule Provider Wake writes generated `server/plugins/vitehub-schedule.ts` and `server/modules/vitehub-schedule.ts` files so Nitro can register the `cloudflare:scheduled` runtime hook and emit `cloudflare.wrangler.triggers.crons` during standalone `nitro build`.

Cron parsing uses [`cron-schedule`](https://github.com/P4sca1/cron-schedule).

Learn more at [vitehub.dev](https://vitehub.dev).
