---
title: Choices server API
description: Define choices, load options per request, resolve text into a selection, and inspect the questions before you send them.
navigation.title: Server API
navigation.order: 4
icon: i-lucide-server
---

Import the server API from `vite-hub/choices`. It runs wherever your server code runs. Pass it a gateway that has `ask()`, such as `typesafe()` or `vercel()` from `vite-hub/gateways`, to ask TypeSafe Jev. Or pass any AI SDK `model`. See [AI gateways](/docs/gateways).

## Define choices

`defineChoices()` takes a gateway or a model, and your groups. A wrong definition throws when you call it.

```ts [server/utils/forecast-choices.ts] fragment
import { defineChoices, toOptions } from "vite-hub/choices"
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
| `limits` | Change the [limits](/docs/choices/limits-and-errors#limits). |
| `thresholds` | Change the [thresholds](/docs/choices/concepts#thresholds). |

Jev gives a probability for every option. A chat model gives one answer and how sure it is, so with `model` the other options share the rest of the probability. `ranked` is then less useful after its first entry. See [Ask with any model](/docs/gateways/server-api#ask-with-any-model).

Each group takes these settings:

| Setting | Meaning |
| --- | --- |
| `label` | The group name. The model reads it. |
| `options` | A list, or a function that loads it per request. |
| `multiple` | `true` (default): any number of options. `false`: at most one. |
| `infer` | `false` (default): choose only an option that the text names. `true`: choose the option that fits the text best, also when the text does not name it. Needs `multiple: false`. See [Infer one option](/docs/choices/concepts#infer-one-option). |
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
  if (error) throw new HTTPError({ status: 422, message: error.message })
  return selection
})
```

```ts fragment
selection.supplier // { include: ["nord"], exclude: ["vak"] }
selection.chart // { value: "bar", confidence: 0.8, ranked: [{ value: "bar", probability: 0.8 }, ...] }
```

The route is yours, so put auth, rate limits, and context there. Use [Rate Limit](/docs/rate-limit) to cap requests. Each call sends one question per multi-select option and one per non-empty single-select group, except that an `infer` group with one option sends none. The `supported` check adds one question if at least one non-empty group does not infer.

`error.code` is `DECISIONS_R0002` to `DECISIONS_R0006` ([Limits and errors](/docs/choices/limits-and-errors)).

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

## Track token usage

Pass `onUsage` to read the model, provider, and token counts that the gateway reports:

```ts fragment
await forecast.resolve(text, {
  onUsage: ({ model, provider, usage }) => console.log(provider, model, usage.inputTokens, usage.outputTokens),
})
```

Jev sends at most 60 KB of questions per request, so it can report usage for multiple batches in one `resolve()`. With `model`, `onUsage` runs at most once. It runs only when the gateway reports usage. If no question is sent, a TypeSafe response has no token counts, or a `model` response fails validation, the callback does not run. No callback does not mean that no request was sent or no tokens were used.

With one group and 100 options, multi-select sends 101 questions: one per option plus `supported`. Single-select without inference sends 2: one for the group plus `supported`. With `infer: true` it sends 1, since there is no `supported` check.

## Inspect

`forecast.inspect(text)` returns `[error, plan]`, with the state and questions that `resolve()` would send. Nothing leaves your server. Use it in tests or when an answer looks wrong.

```ts fragment
const [error, plan] = await forecast.inspect("nord parts except vak supply")
plan.questions // the questions for this input, including `supported` when needed
```

The CLI runs both functions on a file, with no route or dev server:

```sh
pnpm vitehub choices list
pnpm vitehub choices run server/utils/forecast-choices.ts "nord parts except vak supply"
pnpm vitehub choices run server/utils/forecast-choices.ts "nord parts" --inspect
```

`run` prints the selection as JSON. Read [Run Choices](/docs/cli/primitives#run-choices) for `--export` and `--context`.

## Test without a model

`vite-hub/choices/testing` has two gateways that need no key. Pass one as the `gateway` of `defineChoices()`.

`selectionGateway(selection)` returns the selection that you give, by group key and option value. It validates values against the loaded groups without applying model thresholds. Leave a group out to select nothing, even when it has `infer: true`:

```ts [forecast.test.ts]
import { defineChoices } from 'vite-hub/choices'
import { selectionGateway, unsupported } from 'vite-hub/choices/testing'

const groups = {
  chart: { label: 'Chart', multiple: false, options: [{ label: 'Line', value: 'line' }, { label: 'Bar', value: 'bar' }] },
  supplier: { label: 'Supplier', options: [{ label: 'Vak Supply', value: 'S1' }, { label: 'Nord Parts', value: 'S2' }] },
} as const

const forecast = defineChoices({
  gateway: selectionGateway<typeof groups>({ chart: 'bar', supplier: { include: ['S2'], exclude: ['S1'] } }),
  groups,
})
const [, selection] = await forecast.resolve('bar chart for nord parts except vak supply')
selection?.supplier.include // ['S2']

// DECISIONS_R0004: the options cannot express the text.
await defineChoices({ gateway: selectionGateway(unsupported), groups }).resolve('price above 100')
```

A group that you leave out selects nothing. Pass a function, `(text, context) => selection`, to answer from the text and the request `context`. Return `unsupported` for [`DECISIONS_R0004`](/docs/choices/limits-and-errors#decisions_r0004), and throw for [`DECISIONS_R0005`](/docs/choices/limits-and-errors#decisions_r0005). A group key or option value that the groups do not have also returns `DECISIONS_R0005`, with `DECISIONS_TESTING_SELECTION_INVALID` as its `cause`.

`wordGateway()` answers by word match: it includes an option that the text names and excludes one after "except", "not", or "without". [Get started](/docs/choices/get-started) uses it. It is not a model, so use it to try the flow, not to ship.

For a failing gateway, pass `scriptedAsk()` from `vite-hub/gateways/testing` with `{ error: 'GATEWAYS_R0008' }`. `resolve()` returns `DECISIONS_R0005` with the gateway's public reason. See [Test without a key](/docs/gateways/server-api#test-without-a-key).
