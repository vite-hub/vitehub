---
title: Decisions client
description: Use useChoices() in Vue or Nuxt to turn input text into a selection that fills your state.
navigation.title: Client
navigation.order: 9
icon: i-lucide-code-2
---

`useChoices()` is a Vue composable that turns input text into a selection. It handles status, debounce, and cancelling old requests, but knows nothing of your server, store, or UI.

Import it from `vite-hub/decisions/vue`. Nuxt auto-imports it.

## Use it

Give it the two bridges: `resolve` calls your route, and `onSelect` applies the selection to your state.

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

Pass your choices type as the generic, `useChoices<typeof forecast>`, to type `selection` and `onSelect` from your options.

## Options

| Option | Meaning |
| --- | --- |
| `resolve` | Required. Sends the text and returns the selection. Throw when the request fails. Pass `signal` to your request. |
| `onSelect` | Gets each new selection. Apply it to your state here. |
| `debounce` | Milliseconds to wait after the last key before resolving. Leave it out to resolve only on `submit()`. |
| `minLength` | Minimum text length for a debounced resolve. Default 3. |
| `onClear` | Called by `clear()`. Reset your state here, such as the filters the last selection set. |

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

A newer request cancels the older one through `signal`, so the older result never reaches `onSelect`. Unmounting the component also cancels.

## Choose when to resolve

Each resolve sends the model one question per multi-select option, one per non-empty single-select group, and one `supported` check. That costs time and money. Pick one pattern:

- **On Enter.** Leave out `debounce` and call `ai.submit()` on Enter or a button. Best for short input such as filters.
- **While typing.** Set `debounce` to 600 or more, and rate-limit the route.

## The selection in your template

`ai.selection.value` is the object that `resolve()` returns. Use it to show what the model understood, such as the ranked options of a group:

```ts fragment
ai.selection.value?.chart.ranked // [{ value: "bar", probability: 0.8 }, { value: "line", probability: 0.1 }]
```

When `value` is `null`, the model was not sure enough. Show the ranked list and let the person choose.
