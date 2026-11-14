---
title: Decisions server API
description: Define choices, load options per request, resolve text into a selection, and inspect the questions before you send them.
navigation.title: Server API
navigation.order: 4
icon: i-lucide-server
---

Import the server API from `vite-hub/decisions`. It runs wherever your server code runs. Pass it a gateway that has `ask()`, such as `typesafe()` or `vercel()` from `vite-hub/gateways`, to ask TypeSafe Jev. Or pass any AI SDK `model`. See [AI gateways](/docs/gateways).

## Define choices

`defineChoices()` takes a gateway or a model, and your groups. A wrong definition throws when you call it.

```ts [server/utils/forecast-choices.ts] fragment
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
| `gateway` | An object with `ask()`, such as `typesafe()` or `vercel()` for TypeSafe Jev. The key stays on the server. |
| `model` | Any AI SDK model, such as `openai("gpt-5.1-mini")`, instead of `gateway`. It needs the `ai` package. Set `gateway` or `model`, not both. |
| `groups` | One entry for each decision. The key names the group in the selection. |
| `hints` | A short note for the model about your domain. It applies to every question. |
| `name` | A label for logs and the CLI. It never connects anything. |
| `limits` | Change the [limits](/docs/decisions/limits-and-errors#limits). |
| `thresholds` | Change the [thresholds](/docs/decisions/concepts#thresholds). |

Jev gives a probability for every option. A chat model gives one answer and how sure it is, so with `model` the other options share the rest of the probability. `ranked` is then less useful after its first entry. See [Ask with any model](/docs/gateways/server-api#ask-with-any-model).

Each group takes these settings:

| Setting | Meaning |
| --- | --- |
| `label` | The group name. The model reads it. |
| `options` | A list, or a function that loads it per request. |
| `multiple` | `true` (default): any number of options. `false`: at most one. |
| `infer` | `false` (default): choose only an option that the text names. `true`: choose the option that fits the text best, also when the text does not name it. Needs `multiple: false`. See [Infer one option](/docs/decisions/concepts#infer-one-option). |
| `hints` | A short note for the model about this group. |

`toOptions(items, { value, label, aliases?, description? })` turns your data into options. An option is `{ value, label, aliases?, description? }`. The `value` is a string or a number, and it must be unique in its group. The `description` tells the model what the option is about. An `infer` group needs it.

## Resolve text

Call `resolve()` in a route, queue worker, or test. It returns `[error, selection]` and never throws.

```ts [server/api/forecast/choices.post.ts] fragment
import { forecast } from "../../utils/forecast-choices"

export default defineEventHandler(async (event) => {
  await requireUserSession(event) // your auth
  const { text } = await readBody(event)
  const [error, selection] = await forecast.resolve(text)
  if (error) throw createError({ statusCode: 422, message: error.message })
  return selection
})
```

```ts fragment
selection.supplier // { include: ["nord"], exclude: ["vak"] }
selection.chart // { value: "bar", confidence: 0.8, ranked: [{ value: "bar", probability: 0.8 }, ...] }
```

The route is yours, so put auth, rate limits, and context there. Use [Rate Limit](/docs/rate-limit) to cap requests. Each call sends one question per multi-select option, one per non-empty single-select group, and one `supported` check.

`error.code` is `DECISIONS_R0002` to `DECISIONS_R0006` ([Limits and errors](/docs/decisions/limits-and-errors)).

## Load options for one request

An `options` function gets `context`. Type its parameter, and `resolve()` requires the same type.

```ts fragment
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

```ts fragment
await forecast.resolve(text, { signal: AbortSignal.timeout(10_000) })
```

## Inspect

`forecast.inspect(text)` returns `[error, plan]`, with the state and questions that `resolve()` would send. Nothing leaves your server. Use it in tests or when an answer looks wrong.

```ts fragment
const [error, plan] = await forecast.inspect("nord parts except vak supply")
plan.questions // one question for each option of a multiple group, one for each single group, and `supported` unless every group infers
```

The CLI runs both functions on a file, with no route or dev server:

```sh
pnpm vitehub decisions list
pnpm vitehub decisions run server/utils/forecast-choices.ts "nord parts except vak supply"
pnpm vitehub decisions run server/utils/forecast-choices.ts "nord parts" --inspect
```

`run` prints the selection as JSON. Read [Run a Decision](/docs/cli/decisions#run-a-decision) for `--export` and `--context`.
