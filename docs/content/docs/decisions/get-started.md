---
title: Turn a sentence into filters
description: Build a filter box that reads "nord parts except vak supply" and fills your own chips. It runs offline, with no API key.
layout: tutorial
codePanel: true
navigation.title: Get started
navigation.order: 2
icon: i-lucide-rocket
---

Decisions turns what a person types into choices from a list that you give. You give the options. A model reads the text and picks from them. ViteHub checks that the model picked only your options.

In this tutorial, you build a filter box. A person types "nord parts except vak supply". Your page shows one supplier to include and one to exclude.

> [!NOTE] Before you start
> Use the app from the **Vite** path in [Installation](/docs/getting-started/installation). You need Node.js 22.22 or newer and pnpm.
>
> Until the last step, you need no API key and no network. A small offline stand-in answers in place of the model. The last step uses a real model, which needs an API key and can cost money.

Install the Decisions and [AI Gateways](/docs/gateways) packages. This app has a Vue page, so also install Vue and its Vite plugin:

```bash pm [commands/install-vue]
pnpm add @vite-hub/decisions @vite-hub/gateways vue
pnpm add -D @vitejs/plugin-vue
```

::run-tutorial{to="/learn/decisions"}
::

::tutorial-step{title="Declare your options"}
## Declare your options

Create `server/utils/word-gateway.ts`. A gateway is the object that asks the model. This one asks no model. It looks for words in the text, so you can see the flow with no API key. Read it once, then leave it alone.

```ts [server/utils/word-gateway.ts]
import type { AiGatewayAsk } from "vite-hub/gateways"

type Plan = { groups: { label: string, options: { label: string }[] }[], query: string }

function answer(choice: string, labels: string[], probability: number) {
  const others = Number(((1 - probability) / Math.max(1, labels.length - 1)).toFixed(2))
  return {
    choice,
    confidence: probability,
    probabilities: Object.fromEntries(labels.map(label => [label, label === choice ? probability : others])),
    type: "choice" as const,
  }
}

// An offline stand-in for a decision model. It reads the text word by word:
// an option is included when the text names it, and excluded when "except", "not", or "without" comes before it.
// It needs no key. Use it to learn the flow, not to ship.
export const wordGateway: { ask: AiGatewayAsk } = {
  ask: async (state, questions) => {
    const { groups, query } = state as Plan
    const text = query.toLowerCase()
    const answers: Record<string, unknown> = { supported: { chance: 0.95, type: "chance" } }

    groups.forEach((group, g) => {
      const labels = group.options.map(option => option.label)
      if (`g${g}` in questions) {
        const named = labels.find(label => text.includes(label.toLowerCase())) ?? "(none)"
        answers[`g${g}`] = answer(named, [...labels, "(none)"], 0.8)
        return
      }
      group.options.forEach((option, o) => {
        const label = option.label.toLowerCase()
        const excluded = new RegExp(`(except|not|without)\\s+(\\w+\\s+)?${label}`).test(text)
        const choice = !text.includes(label) ? "none" : excluded ? "exclude" : "include"
        answers[`g${g}_o${o}`] = answer(choice, ["include", "exclude", "none"], 0.9)
      })
    })

    // SAFETY: The answers follow the question keys that defineChoices() builds.
    return answers as never
  },
}
```

Now write your own part. Create `server/utils/forecast-choices.ts`. It lists what the person can choose:

```ts [server/utils/forecast-choices.ts]
import { defineChoices, toOptions } from "vite-hub/decisions"
import { wordGateway } from "./word-gateway"

// Your data. In a real app it comes from a database.
const suppliers = [
  { id: "nord", name: "Nord Parts" },
  { id: "vak", name: "Vak Supply" },
  { id: "alto", name: "Alto Metals" },
]

export const forecast = defineChoices({
  name: "forecast", // a label for logs. It connects nothing.
  gateway: wordGateway,
  groups: {
    supplier: {
      label: "Supplier",
      options: toOptions(suppliers, { value: s => s.id, label: s => s.name, aliases: s => [s.id] }),
    },
    chart: {
      label: "Chart",
      multiple: false, // choose at most one
      options: [{ value: "line", label: "Line" }, { value: "bar", label: "Bar" }],
    },
  },
})
```

- A **group** is one decision, such as "which supplier". An **option** is one thing that the person can pick.
- `toOptions()` turns your data into options. This is the first of two bridges: code that connects your app to Decisions.
- The `supplier` group takes any number of options. The `chart` group takes at most one.

::

::tutorial-step{title="Write the route"}
## Write the route

Create `server/api/choices.post.ts`. It calls `resolve()` with the text that the person typed:

```ts [server/api/choices.post.ts]
import { createError, defineEventHandler, readBody } from "h3"
import { forecast } from "../utils/forecast-choices"

export default defineEventHandler(async (event) => {
  const body = await readBody<{ text?: string }>(event)
  const [error, selection] = await forecast.resolve(body?.text ?? "")
  if (error) throw createError({ statusCode: 422, message: error.message })
  return selection
})
```

- `resolve()` returns `[error, selection]`. It never throws.
- The model call happens in this route, on the server. The browser never sees the gateway or its key.
- The route is yours. Add your sign-in check and your rate limit here.

Start the app and send a sentence:

```bash [commands/dev]
pnpm dev
```

```bash [commands/request]
curl -X POST http://localhost:3000/api/choices \
  -H 'content-type: application/json' \
  -d '{"text":"nord parts except vak supply, as bar"}'
```

You get a selection. Each group has its own shape:

```json [output/response.json]
{
  "supplier": {
    "exclude": [
      "vak"
    ],
    "include": [
      "nord"
    ]
  },
  "chart": {
    "confidence": 0.8,
    "ranked": [
      {
        "probability": 0.8,
        "value": "bar"
      },
      {
        "probability": 0.1,
        "value": "line"
      }
    ],
    "value": "bar"
  }
}
```

- `supplier` lists the values to include and the values to exclude.
- `chart` has the best value, how sure the model is, and every option from most to least likely.
- Every value is one of your option values.

::

::tutorial-step{title="Call it from the browser"}
## Call it from the browser

The browser sends the text to your route and gets a selection back. `useChoices()` handles the typing and the waiting, and it cancels old requests. You write the second bridge: `onSelect` puts the selection into your own state.

In Vite, add the Vue plugin. Nuxt includes Vue:

:::tabs{sync="framework"}
::::tabs-item{label="Nuxt"}
```ts [nuxt.config.ts]
export default defineNuxtConfig({
  modules: ['vite-hub/nuxt'],
  vitehub: { host: "node" },
})
```
::::

::::tabs-item{label="Nitro"}
```ts [vite.config.ts]
import { nitro } from 'nitro/vite'
import vue from "@vitejs/plugin-vue"
import { defineConfig } from "vite"
import { vitehub } from "vite-hub"

export default defineConfig({
  plugins: [vue(), vitehub({ host: "node" }), nitro()],
})
```
::::

::::tabs-item{label="Vite"}
```ts [vite.config.ts]
import vue from "@vitejs/plugin-vue"
import { defineConfig } from "vite"
import { vitehub } from "vite-hub"

export default defineConfig({
  plugins: [vue(), vitehub({ host: "node" })],
})
```
::::
:::

Create the page at the root of your app:

```html [index.html]
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Forecast filters</title>
  </head>
  <body>
    <div id="app"></div>
    <script type="module" src="/src/main.ts"></script>
  </body>
</html>
```

```ts [src/main.ts]
import { createApp } from "vue"
import App from "./App.vue"

createApp(App).mount("#app")
```

Create `src/App.vue`:

```vue [src/App.vue]
<script setup lang="ts">
import { ref } from "vue"
import { useChoices } from "vite-hub/decisions/vue"
import type { forecast } from "../server/utils/forecast-choices"

// Your state. Choices never touches it.
const included = ref<string[]>([])
const excluded = ref<string[]>([])
const chart = ref<string | null>(null)

const ai = useChoices<typeof forecast>({
  // Bridge to the server: send the text, return the selection.
  resolve: async (text, { signal }) => {
    const response = await fetch("/api/choices", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
      signal,
    })
    if (!response.ok) throw new Error((await response.json()).message)
    return response.json()
  },
  // Bridge out: apply the selection to your state.
  onSelect: (selection) => {
    included.value = selection.supplier.include
    excluded.value = selection.supplier.exclude
    chart.value = selection.chart.value
  },
})
</script>

<template>
  <input v-model="ai.text.value" placeholder="nord parts except vak supply, as bar" @keydown.enter="ai.submit()">
  <p v-if="ai.status.value === 'thinking'">Thinking</p>
  <p v-else-if="ai.error.value">{{ ai.error.value.message }}</p>
  <ul>
    <li v-for="id in included" :key="id">Supplier: {{ id }}</li>
    <li v-for="id in excluded" :key="id">Not supplier: {{ id }}</li>
    <li v-if="chart">Chart: {{ chart }}</li>
  </ul>
</template>
```

- `import type` brings in only the type of your choices. No server code goes to the browser.
- `resolve` sends the text to your route.
- `onSelect` copies the selection into `included`, `excluded`, and `chart`. These are your own Vue refs.

Stop `pnpm dev` and start it again. Nitro looks for `index.html` only when the dev server starts. Without a restart, `/` still answers 404.

Open `http://localhost:3000`, type `nord parts except vak supply, as bar`, and press Enter. The page shows:

```text [output/page.txt]
Supplier: nord
Not supplier: vak
Chart: bar
```

The list shows plain Vue state. Replace it with your own filter bar, and the same `onSelect` fills it.

::

::tutorial-step{title="Swap in a real model"}
## Swap in a real model

The word gateway knows only exact names. A real decision model also reads codes, short names, and typos. In `server/utils/forecast-choices.ts`, replace the word gateway with `typesafe()`. Nothing else changes in your code. `typesafe()` sends the questions through `advocaat`, the TypeSafe client, so install it with `pnpm add advocaat`. Without it, `resolve()` returns an error.

```diff
-import { wordGateway } from "./word-gateway"
+import { typesafe } from "vite-hub/gateways"
```

```diff
-  gateway: wordGateway,
+  gateway: typesafe(), // reads TYPESAFE_API_KEY on the server
```

Set the API key in your server environment, and restart the dev server. Keep the key out of browser code and out of Git. Each request can cost money.

```bash [commands/typesafe-key]
export TYPESAFE_API_KEY=your-key
pnpm dev
```

You can now delete `server/utils/word-gateway.ts`. The route and the page do not change, because they use only `resolve()` and the selection.

::

## What you built

You wrote two bridges and one route. Your data became options. The selection became your state. ViteHub did the part in the middle: it asked the model and checked the answer.

## Next steps

::card-group
:::card{title="Concepts" icon="i-lucide-lightbulb" to="/docs/decisions/concepts"}
See why the model cannot invent a value.
:::

:::card{title="Recipes" icon="i-lucide-chef-hat" to="/docs/decisions/recipes"}
Build search facets, a command palette, and dashboard controls.
:::

:::card{title="Limits and errors" icon="i-lucide-triangle-alert" to="/docs/decisions/limits-and-errors"}
Read this before you ship.
:::
::
