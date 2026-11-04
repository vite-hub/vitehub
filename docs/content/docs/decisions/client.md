---
title: Decisions client
description: Use useChoices() in Vue or Nuxt to turn the text of an input into a selection that fills your own state.
navigation.title: Client
navigation.order: 9
icon: i-lucide-code-2
---

`useChoices()` is a Vue composable. It turns the text of an input into a selection. It owns the status, the debounce, and the cancel of older requests. It does not know your server, your store, or your UI.

Import it from `vite-hub/decisions/vue`. In Nuxt, it is auto-imported.

## Use it

You give it a `resolve` function that calls your route. You give it an `onSelect` function that applies the selection to your state. These are the two bridges.

```vue [FilterBar.vue]
<script setup lang="ts">
import { useChoices } from "vite-hub/decisions/vue"
import type { forecast } from "~~/server/utils/forecast-choices" // a type, so no server code reaches the browser

const store = useForecastStore()
const ai = useChoices<typeof forecast>({
  resolve: (text, { signal }) => $fetch("/api/forecast/choices", { method: "POST", body: { text }, signal }),
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

Give the type of your choices as the generic: `useChoices<typeof forecast>`. Then `selection` and `onSelect` are typed from your options.

## Options

| Option | Meaning |
| --- | --- |
| `resolve` | Required. Send the text, return the selection. Throw when the request fails. Pass `signal` to your request. |
| `onSelect` | Called with each new selection. Apply it to your state here. |
| `debounce` | Wait this many milliseconds after the last key, then resolve. Leave it out to resolve only on `submit()`. |
| `minLength` | The text must be this long before a debounced resolve runs. Default 3. |
| `onClear` | Called by `clear()`. Reset your own state here, for example the filters that the last selection set. |

## Returned values

| Value | Meaning |
| --- | --- |
| `text` | A ref for your input. |
| `status` | `idle`, `thinking`, `ready`, or `error`. |
| `selection` | The latest selection, or `undefined`. |
| `error` | The latest failure, or `undefined`. |
| `submit()` | Resolve the current text now. |
| `abort()` | Cancel the request and go back to `idle`. |
| `clear()` | Clear the text, the selection, and the error, then call `onClear`. |

A newer request cancels the older one through `signal`. The older result never reaches `onSelect`. Leaving the component cancels the request too.

## Choose when to resolve

Each resolve sends one question for each option to the model. That costs time and money. Two patterns:

- **On Enter.** Leave out `debounce` and call `ai.submit()` on Enter or on a button. Best for short, deliberate input such as filters.
- **While typing.** Set `debounce` to 600 or more. Pair it with a rate limit on the route.

## The selection in your template

`ai.selection.value` is the same object that `resolve()` returns. Use it to show what the model understood, for example the ranked options of a single group:

```ts
ai.selection.value?.chart.ranked // [{ value: "bar", probability: 0.8 }, { value: "line", probability: 0.1 }]
```

When `value` is `null`, show the ranked list and let the person choose. The model was not sure enough.
