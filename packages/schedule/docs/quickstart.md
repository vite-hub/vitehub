---
title: Schedule quickstart
description: Register Schedule, define a daily cron handler, create a Runtime Schedule, and add Agent Schedules.
navigation.title: Quickstart
navigation.order: 1
icon: i-lucide-zap
frameworks: [vite, nitro]
---

This guide creates one `daily-digest` schedule. The handler runs from a five-field UTC cron expression, and the route creates a Runtime Schedule record that targets the same handler.

::code-collapse

```txt [Prompt]
Set up @vitehub/schedule in this app.

- Install @vitehub/schedule
- Register hubSchedule() for Vite or @vitehub/schedule/nitro for Nitro
- Define daily-digest with defineSchedule('0 9 * * *', handler)
- Opt the definition into Runtime Schedules with allowRuntimeSchedules
- Create a Runtime Schedule through schedules.create()
- Add an Agent Schedule with schedule({ schedules: [...] })

Docs: /docs/vite/schedule/quickstart or /docs/nitro/schedule/quickstart
```

::

::steps

### Install Schedule

```bash
pnpm add @vitehub/schedule
```

Install `@vitehub/agent` too when you use Agent Schedules or Schedule Capability tools:

```bash
pnpm add @vitehub/agent
```

### Register the Integration

::fw{id="vite:dev vite:build"}
Register the Vite plugin:

```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { hubSchedule } from '@vitehub/schedule/vite'

export default defineConfig({
  plugins: [hubSchedule()],
})
```
::

::fw{id="nitro:dev nitro:build"}
Register the Nitro module:

```ts [nitro.config.ts]
import { defineNitroConfig } from 'nitro/config'

export default defineNitroConfig({
  modules: ['@vitehub/schedule/nitro'],
})
```
::

### Define a Static Schedule

::fw{id="vite:dev vite:build"}
Create a discovered Vite schedule file:

```ts [src/daily-digest.schedule.ts]
import { defineSchedule } from '@vitehub/schedule'

export default defineSchedule('0 9 * * *', async (context) => {
  console.log(`Running ${context.id} at ${context.scheduledAt.toISOString()}`)
}, {
  allowRuntimeSchedules: true,
})
```
::

::fw{id="nitro:dev nitro:build"}
Create a discovered Nitro schedule file:

```ts [server/schedules/daily-digest.ts]
import { defineSchedule } from '@vitehub/schedule'

export default defineSchedule('0 9 * * *', async (context) => {
  console.log(`Running ${context.id} at ${context.scheduledAt.toISOString()}`)
}, {
  allowRuntimeSchedules: true,
})
```
::

The file name gives the default Schedule id: `daily-digest`.

### Create a Runtime Schedule

Add a route that creates a recurring Runtime Schedule record:

::fw{id="vite:dev vite:build"}
```ts [src/server.ts]
import { H3 } from 'h3'
import { schedules } from '@vitehub/schedule'

const app = new H3()

app.post('/api/schedules/daily-digest', async () => {
  return await schedules.create({
    cron: '0 9 * * *',
    id: 'daily-digest-9am',
    target: 'daily-digest',
  })
})

export default app
```
::

::fw{id="nitro:dev nitro:build"}
```ts [server/api/schedules/daily-digest.post.ts]
import { schedules } from '@vitehub/schedule'

export default defineEventHandler(async () => {
  return await schedules.create({
    cron: '0 9 * * *',
    id: 'daily-digest-9am',
    target: 'daily-digest',
  })
})
```
::

### Add an Agent Schedule

Use `schedule({ schedules: [...] })` when the Agent itself should be invoked on a recurring cron:

```ts [server/agents/digest.ts]
import { defineAgent, schedule } from '@vitehub/agent'

export default defineAgent({
  capabilities: [
    schedule({
      schedules: [
        '0 9 * * *',
        { cron: '0 17 * * 1-5', id: 'weekday-summary' },
      ],
    }),
  ],
  model,
  adapter: 'ai-sdk',
})
```

::
