---
title: Turn a sentence into filters
description: Build a filter box that reads "nord parts except vak supply" and fills your own chips. It runs offline, with no API key.
layout: tutorial
codePanel: true
navigation.title: Get started
navigation.order: 2
icon: i-lucide-rocket
---

You build a filter box. A person types "nord parts except vak supply". Your page shows one supplier to include and one supplier to exclude.

You write the list of options and the API route. ViteHub asks a model to pick from your options and checks the answer. You put the result in your own page state.

You need:

- Node.js 22.22 or newer
- pnpm
- the app from the **Vite with Nitro** path in [Installation](/docs/getting-started/installation)

You do not need an API key or a network connection. A small offline stand-in answers in place of a model. The last step shows how to use a real model.

Decisions is part of `vite-hub`, so you do not add a ViteHub package. The page in this tutorial uses Vue. Install Vue, and the plugin that lets Vite build `.vue` files:

```bash [commands/install-vue]
pnpm add vue
pnpm add -D @vitejs/plugin-vue
```

::run-tutorial{to="/learn/decisions"}
::

::tutorial-step{title="List your options"}
## List your options

Create `server/utils/word-gateway.ts`. A gateway is the object that asks the model. This one does not use a model. It looks for the option names in the text. Read it once, then leave it alone.

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

Now the part that is yours. Create `server/utils/forecast-choices.ts`. A **group** is one decision, such as "which supplier". An **option** is one thing the person can pick. `toOptions()` turns your data into options. This is the first bridge: code that you write to connect your data to ViteHub.

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

The `supplier` group takes any number of options. The `chart` group takes at most one.

::

::tutorial-step{title="Write the route"}
## Write the route

Create `server/api/choices.post.ts`. It calls `resolve()` with the text. `resolve()` does not throw. It returns `[error, selection]`: `error` tells you what went wrong, and `selection` holds the picked options.

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

The route is yours. Add your auth and your rate limit here. The model call happens in this route, on the server. The browser never sees the gateway or its key.

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

`supplier` lists the values to include and the values to exclude. `chart` has the best value, how sure the model is, and every option ranked. Every value is one of your option values, so the route turned the sentence into your own data.

::

::tutorial-step{title="Call it from the browser"}
## Call it from the browser

The browser sends text to your route and gets a selection back. `useChoices()` keeps the input text, shows when a request is waiting, and cancels old requests. You write the second bridge: the `onSelect` function puts the selection into your own state.

Add the Vue plugin to `vite.config.ts`:

```ts [vite.config.ts]
import vue from "@vitejs/plugin-vue"
import { defineConfig } from "vite"
import { vitehub } from "vite-hub"

export default defineConfig({
  plugins: [vue(), vitehub({ preset: "node" })],
})
```

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

Create `src/App.vue`. The `import type` line brings in only the type of your choices. No server code reaches the browser.

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

Stop `pnpm dev` and start it again. Nitro looks for `index.html` only when the dev server starts, so a running server still answers `/` with 404.

Open `http://localhost:3000`, type `nord parts except vak supply, as bar`, and press Enter. The page shows:

```text [output/page.txt]
Supplier: nord
Not supplier: vak
Chart: bar
```

The browser sent your text to the route and put the answer in your Vue state. You can replace the list with your own filter bar. The same `onSelect` fills it.

::

::tutorial-step{title="Swap in a real model"}
## Swap in a real model

The word gateway only knows exact names. A real decision model also reads codes, short names, and typos. Replace the gateway in `server/utils/forecast-choices.ts` with `typesafe()`. Nothing else changes.

```diff
-import { wordGateway } from "./word-gateway"
+import { typesafe } from "vite-hub/gateways"
```

```diff
-  gateway: wordGateway,
+  gateway: typesafe(), // reads TYPESAFE_API_KEY on the server
```

Set the key in your server environment and restart:

```bash [commands/typesafe-key]
export TYPESAFE_API_KEY=your-key
pnpm dev
```

> [!NOTE]
> Each request to a real model can cost money. Keep the key out of browser code and out of Git.

You can now delete `server/utils/word-gateway.ts`. The route and the page stay the same, because both only use `resolve()` and the selection.

::

## Next steps

You wrote two bridges and one route. Your data became options. The selection became your state. ViteHub did the part in the middle.

- [Concepts](/docs/decisions/concepts): learn why the model cannot invent a value.
- [Recipes](/docs/decisions/recipes): build search facets, a command palette, and dashboard controls.
- [Limits and errors](/docs/decisions/limits-and-errors): learn what can fail before you ship.
