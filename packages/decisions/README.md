# @vite-hub/decisions

Turn text into choices over options that you declare. A person types "nord parts except vak supply". Your app gets back which options the text includes and excludes. Use it for filters, search facets, command palettes, and builders.

`defineChoices()` is a plain function on the server. It does not know your routes, your UI, or your store. You write the two bridges: from your data to options, and from the selection to your state. ViteHub applications import it as `vite-hub/decisions`.

## Install

```sh
pnpm add @vite-hub/decisions @vite-hub/gateways advocaat
```

The model call goes through an AI gateway that has `ask()`, such as `typesafe()` or `vercel()` from `@vite-hub/gateways`. The gateway reads its key from the environment. The key stays on your server.

## Use

```ts
import { defineChoices, toOptions } from '@vite-hub/decisions'
import { typesafe } from '@vite-hub/gateways'

export const forecast = defineChoices({
  name: 'forecast', // a label for logs only
  gateway: typesafe(), // reads TYPESAFE_API_KEY
  groups: {
    supplier: {
      label: 'Supplier',
      options: toOptions(suppliers, { value: s => s.code, label: s => s.name, aliases: s => [s.code] }),
    },
    chart: {
      label: 'Chart',
      multiple: false, // choose one
      options: [{ value: 'line', label: 'Line' }, { value: 'bar', label: 'Bar' }],
    },
  },
})

// In any server code: a route, a queue worker, a test.
const [error, selection] = await forecast.resolve('nord parts except vak supply')
if (error) return handle(error)

selection.supplier // { include: ['S2'], exclude: ['S1'] }
selection.chart // { value: null, confidence: 0.9, ranked: [{ value: 'line', probability: 0.5 }, ...] }
```

`resolve()` returns `[error, data]` and never throws. Definition errors throw when you define the choices.

## The bridges

| You write | We do |
| --- | --- |
| `options`: your data as `{ value, label, aliases? }`, or a function that loads them for one request | Build one question per option and ask the gateway |
| The route that calls `resolve()`, with your auth and rate limit | Check the limits and the answers |
| The code that applies `selection` to your state | Type `selection` from your options |

An `options` function receives `context`. Annotate its parameter, and `resolve()` asks for the same type:

```ts
options: async ({ tenantId }: { tenantId: string }) => toOptions(await loadSites(tenantId), { value: s => s.id, label: s => s.name })
// await sites.resolve(text, { context: { tenantId: session.tenantId } })
```

## Groups

| Option | Meaning |
| --- | --- |
| `multiple: true` (default) | Any number of options. The selection is `{ include, exclude }`. |
| `multiple: false` | At most one option. The selection is `{ value, confidence, ranked }`. `value` is `null` below `thresholds.option`. |
| `hints` | A short note for the model about this group. |

The top-level `hints` apply to every question. Put your domain words there, such as "mtop means Make to order".

## Use it in the browser

`useChoices()` from `@vite-hub/decisions/vue` (auto-imported in Nuxt) turns the text of an input into a selection. You give it a `resolve` function that calls your route. It does not know your server, your store, or your UI.

```vue
<script setup lang="ts">
import type { forecast } from '~~/server/utils/forecast-choices' // a type, so no server code reaches the browser

const store = useForecastStore()
const ai = useChoices<typeof forecast>({
  resolve: (text, { signal }) => $fetch('/api/forecast/choices', { method: 'POST', body: { text }, signal }),
  onSelect: selection => store.setSuppliers(selection.supplier), // your bridge out
  debounce: 800, // leave it out to resolve only on ai.submit()
})
</script>

<template>
  <input v-model="ai.text.value" @keydown.enter="ai.submit()">
  <p v-if="ai.status.value === 'thinking'">Thinking</p>
  <p v-else-if="ai.error.value">{{ ai.error.value.message }}</p>
</template>
```

| Returned | Meaning |
| --- | --- |
| `text` | A ref for your input. |
| `status` | `idle`, `thinking`, `ready`, or `error`. |
| `selection`, `error` | The latest result and the latest failure. |
| `submit()`, `abort()`, `clear()` | Resolve now, cancel the request, reset the text, selection, and error. `clear()` also calls `onClear`, so you can reset your own state. |

A newer request cancels the older one through `signal`, and the older result never reaches `onSelect`. With debounce enabled, changing the text cancels the current request immediately, including while waiting for the next request to start. Throw from `resolve` to set `error`. The text must be at least `minLength` (3) characters before a debounced resolve runs.

## Limits and errors

| Limit | Default |
| --- | --- |
| Groups | 40 |
| Options per group | 100 |
| Options in all groups | 100 |
| Text length | 300 |

| Code | Meaning |
| --- | --- |
| `DECISIONS_R0001` | The definition is wrong. It throws when you define it. |
| `DECISIONS_R0002` | The options are over a limit or invalid. Nothing was asked. |
| `DECISIONS_R0003` | The text is empty or too long. Nothing was asked. |
| `DECISIONS_R0004` | The model says the options cannot express the text. |
| `DECISIONS_R0005` | The gateway request failed. `cause` has the error. |
| `DECISIONS_R0006` | The model answer misses a question. |

`thresholds.option` (0.5) decides one option. `thresholds.supported` (0.6) decides whether the text can be expressed at all. A decision model answers from the options you gave it. It cannot compare numbers or invent a value.

## Inspect

`choices.inspect(text)` returns the state and the questions that `resolve()` would send. Nothing leaves your server.

The `vitehub` CLI of `vite-hub` runs a definition by its file path. There is no registry.

```sh
pnpm vitehub decisions list                     # the exports of defineChoices() results, by file
pnpm vitehub decisions run server/utils/forecast-choices.ts "nord parts except vak supply"
pnpm vitehub decisions run server/utils/forecast-choices.ts "nord parts" --inspect   # no model call
```

`run` prints the selection as JSON. `--export <name>` picks one export of a file with several, and `--context <json>` passes the `context` of `options` functions. A Decision error prints `{ "error": { "code", "message" } }` and exits with status 1. The command reads gateway keys from the shell and the project `.env` files. It loads the file with Vite but not with the project config, so Nuxt aliases and auto-imports do not resolve.

`createDecisionsCliNamespace()` from `@vite-hub/decisions/cli` returns the same commands for another CLI. It needs `vite`.
