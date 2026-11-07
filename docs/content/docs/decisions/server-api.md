---
title: Decisions server API
description: Define choices, load options per request, resolve text into a selection, and inspect the questions before you send them.
navigation.title: Server API
navigation.order: 4
icon: i-lucide-server
---

Import the server API from `vite-hub/decisions`. It runs in any server code. Pass a gateway (the model client) with `ask()`, such as `typesafe()` or `vercel()` from `vite-hub/gateways` ([AI gateways](/docs/agents/ai-gateways)).

## Define choices

`defineChoices()` takes a gateway and your groups. It throws on a wrong definition.

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
| `groups` | One entry per decision. The key names the group in the selection. |
| `hints` | A note about your domain, added to every question. |
| `name` | A label for logs and the CLI. It connects nothing. |
| `limits` | Change the [limits](/docs/decisions/limits-and-errors#limits). |
| `thresholds` | Change the [thresholds](/docs/decisions/concepts#thresholds). |

Group settings:

| Setting | Meaning |
| --- | --- |
| `label` | The group name. The model reads it. |
| `options` | A list, or a function that loads it per request. |
| `multiple` | `true` (default): any number of options. `false`: at most one. |
| `hints` | A note about this group for the model. |

`toOptions(items, { value, label, aliases? })` turns your data into options of shape `{ value, label, aliases? }`. `value` is a string or number, unique in its group.

## Resolve text

Call `resolve()` in a route, queue worker, or test. It returns `[error, selection]` and never throws.

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

The route is yours, so put auth, rate limits, and context there. Use [Rate Limit](/docs/rate-limit) to cap requests. Each call sends one question per multi-select option, one per non-empty single-select group, and one `supported` check.

`error.code` is `DECISIONS_R0002` to `DECISIONS_R0006` ([Limits and errors](/docs/decisions/limits-and-errors)).

## Load options for one request

An `options` function gets `context`. Type its parameter, and `resolve()` requires the same type.

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

Without a type, `resolve()` takes no context. With one, TypeScript stops you from forgetting it.

## Cancel a request

Pass a `signal` to stop the gateway request:

```ts
await forecast.resolve(text, { signal: AbortSignal.timeout(10_000) })
```

## Inspect

`forecast.inspect(text)` returns `[error, plan]`, with the state and questions that `resolve()` would send. Nothing leaves your server. Use it in tests or when an answer looks wrong.

```ts
const [error, plan] = await forecast.inspect("nord parts except vak supply")
plan.questions // one question for each option of a multiple group, one for each single group, and `supported`
```

The CLI runs both functions on a file, with no route or dev server:

```sh
pnpm vitehub decisions list
pnpm vitehub decisions run server/utils/forecast-choices.ts "nord parts except vak supply"
pnpm vitehub decisions run server/utils/forecast-choices.ts "nord parts" --inspect
```

`run` prints the selection as JSON. Read [Run a Decision](/docs/development/cli#run-a-decision) for `--export` and `--context`.
