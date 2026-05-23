---
title: Schedule provider notes
description: Provider-facing boundaries for Schedule setup and recurring cron delivery.
navigation.title: Provider Notes
navigation.order: 80
icon: i-lucide-cloud
frameworks: [vite, nitro]
---

Schedule definitions and Runtime Schedule APIs are provider-neutral. Provider-specific output belongs to the Vite or Nitro integration and deployment environment.

## Application Code Stays Portable

The same definition shape works across providers:

```ts
import { defineSchedule } from '@vitehub/schedule'

export default defineSchedule('0 9 * * *', async (context) => {
  console.log(context.id, context.scheduledAt)
})
```

The same Runtime Schedule client shape works in routes and server code:

```ts
import { schedules } from '@vitehub/schedule'

await schedules.create({
  cron: '0 9 * * *',
  target: 'daily-digest',
})
```

## Provider Wake

A Provider Wake is the provider-triggered event that asks ViteHub to start due Schedule Runs. Provider Wake behavior is provider-specific, so keep those details in provider-focused setup notes and deployment output docs.

General Schedule examples should talk about Schedule Runs, Runtime Schedules, and Agent Schedules rather than provider-specific event names.

## Storage

Runtime Schedules require a runtime store. The v1 client shape is:

```ts
{
  create(record)
  delete(id)
  get(id)
  list()
  update(id, patch)
}
```

Use provider or app storage that matches your deployment needs. In-memory stores are useful for tests and local experiments, but they do not provide durable Runtime Schedule records.

## V1 Provider Boundaries

Provider integrations may differ in deployment output and trigger mechanics, but Schedule v1 keeps these user-facing boundaries:

- Cron is five-field UTC cron.
- Runtime Schedules are recurring records only.
- Retry, overlap, and dedupe policy are not configurable through Schedule v1.
- Backfill is not part of Schedule v1.
- Provider-specific wake vocabulary should stay in provider docs.
