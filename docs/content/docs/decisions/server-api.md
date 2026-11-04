---
title: Decisions server API
description: Define choices, load options for one request, resolve text into a selection, and inspect the questions before you send them.
navigation.title: Server API
navigation.order: 4
icon: i-lucide-server
---

Import the server API from `vite-hub/decisions`. It runs wherever your server code runs. Pass it a gateway that has `ask()`, such as `typesafe()` or `vercel()` from `vite-hub/gateways`. See [AI gateways](/docs/agents/ai-gateways).

## Define choices

`defineChoices()` takes a gateway and your groups. A wrong definition throws when you call it.

```ts [server/utils/forecast-choices.ts]
import { defineChoices, toOptions } from "vite-hub/decisions"
import { typesafe } from "vite-hub/gateways"

export const forecast = defineChoices({
  name: "forecast", // a label for logs. It connects nothing.
  gateway: typesafe(), // reads TYPESAFE_API_KEY on the server
  hints: "mtop means Make to order", // added to every question
  groups: {
    supplier: {
      label: "Supplier",
      options: toOptions(suppliers, { value: s => s.id, label: s => s.name, aliases: s => [s.code] }),
    },
    chart: {
      label: "Chart",
      multiple: false, // choose at most one
      options: [{ value: "line", label: "Line" }, { value: "bar", label: "Bar" }],
    },
  },
})
```

| Setting | Meaning |
| --- | --- |
| `gateway` | An object with `ask()`. The key stays on the server. |
| `groups` | One entry for each decision. The key names the group in the selection. |
| `hints` | A short note for the model about your domain. It applies to every question. |
| `name` | A label for logs and the CLI. It never connects anything. |
| `limits` | Change the [limits](/docs/decisions/limits-and-errors#limits). |
| `thresholds` | Change the [thresholds](/docs/decisions/concepts#thresholds). |

Each group takes these settings:

| Setting | Meaning |
| --- | --- |
| `label` | What people call the group. The model reads it. |
| `options` | A list, or a function that loads the list for one request. |
| `multiple` | `true` (default): any number of options. `false`: at most one. |
| `hints` | A short note for the model about this group. |

`toOptions(items, { value, label, aliases? })` turns your data into options. An option is `{ value, label, aliases? }`. The `value` is a string or a number, and it must be unique in its group.

## Resolve text

Call `resolve()` in a route, a queue worker, or a test. It returns `[error, selection]` and never throws.

```ts [server/api/forecast/choices.post.ts]
import { forecast } from "../../utils/forecast-choices"

export default defineEventHandler(async (event) => {
  await requireUserSession(event) // your auth
  const { text } = await readBody(event)
  const [error, selection] = await forecast.resolve(text)
  if (error) throw createError({ statusCode: 422, message: error.message })
  return selection
})
```

```ts
selection.supplier // { include: ["nord"], exclude: ["vak"] }
selection.chart // { value: "bar", confidence: 0.8, ranked: [{ value: "bar", probability: 0.8 }, ...] }
```

The route is yours. Auth, rate limits, and the context to pass belong there. Use [Rate Limit](/docs/rate-limit) to cap the requests, because each call sends one question for each option.

`error` has a `code` from `DECISIONS_R0002` to `DECISIONS_R0006`. See [Limits and errors](/docs/decisions/limits-and-errors).

## Load options for one request

An `options` function receives `context`. Annotate its parameter, and `resolve()` asks for the same type.

```ts
const sites = defineChoices({
  gateway: typesafe(),
  groups: {
    site: {
      label: "Site",
      options: async ({ tenantId }: { tenantId: string }) =>
        toOptions(await loadSites(tenantId), { value: s => s.id, label: s => s.name }),
    },
  },
})

await sites.resolve(text, { context: { tenantId: session.tenantId } })
```

Without a type on the parameter, `resolve()` asks for no context. With a type, TypeScript stops you from forgetting it.

## Cancel a request

Pass a `signal` to stop the gateway request:

```ts
await forecast.resolve(text, { signal: AbortSignal.timeout(10_000) })
```

## Inspect

`forecast.inspect(text)` returns `[error, plan]`. The plan has the state and the questions that `resolve()` would send. Nothing leaves your server. Use it in a test or when an answer looks wrong.

```ts
const [error, plan] = await forecast.inspect("nord parts except vak supply")
plan.questions // one question for each option of a multiple group, one for each single group, and `supported`
```
