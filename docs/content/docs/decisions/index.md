---
title: Decisions
layout: landing
navigation.title: Overview
description: Turn what people type into choices over options that you declare. Use it for filters, search facets, and command palettes.
seo.title: Text to filters and choices for Vite apps with ViteHub
navigation.order: 1
icon: i-lucide-list-checks
---

::product-hero{tagline="Turn what people type into choices over options that you declare, for filters, search, and command palettes."}
  :::product-files
  ```ts [server/utils/forecast-choices.ts] fragment
  import { defineChoices, toOptions } from 'vite-hub/decisions'
  import { typesafe } from 'vite-hub/gateways'

  // Bridge in: your data becomes options
  export const forecast = defineChoices({
    gateway: typesafe(), // reads TYPESAFE_API_KEY
    groups: {
      supplier: {
        label: 'Supplier',
        options: toOptions(suppliers, {
          value: s => s.id,
          label: s => s.name,
        }),
      },
    },
  })
  ```

  ```ts [server/api/choices.post.ts]
  import { createError, defineEventHandler, readValidatedBody } from 'h3'
  import * as v from 'valibot'
  import { forecast } from '../utils/forecast-choices'

  // The route is yours. Add auth and limits here.
  export default defineEventHandler(async (event) => {
    const { text } = await readValidatedBody(event, v.parser(v.object({ text: v.string() })))
    const [error, selection] = await forecast.resolve(text)
    if (error) throw createError({ statusCode: 422, message: error.message })
    return selection
  })
  ```

  ```vue [FilterBar.vue]
  <script setup lang="ts">
  import { useChoices } from 'vite-hub/decisions/vue'
  import type { forecast } from '~~/server/utils/forecast-choices'

  const filters = useFilters() // your state
  const ai = useChoices<typeof forecast>({
    resolve: (text, { signal }) =>
      $fetch('/api/choices', { method: 'POST', body: { text }, signal }),
    // Bridge out: the selection becomes your state
    onSelect: selection => filters.setSuppliers(selection.supplier),
  })
  </script>

  <template>
    <input v-model="ai.text.value" @keydown.enter="ai.submit()">
  </template>
  ```
  :::
::

::product-features
  :::product-feature-item{title="Declare options, get typed choices" icon="i-lucide-list-checks" to="/docs/decisions/server-api#define-choices"}
  `defineChoices()` returns a selection that is typed from your options.
  :::

  :::product-feature-item{title="Include and exclude" icon="i-lucide-search" to="/docs/decisions/concepts#selection"}
  "nord parts except vak supply" includes one supplier and excludes the other.
  :::

  :::product-feature-item{title="The model cannot invent a value" icon="i-lucide-shield-check" to="/docs/decisions/concepts#the-model-never-invents-a-value"}
  Every value in the selection is one of your options.
  :::

  :::product-feature-item{title="You own the route and the state" icon="i-lucide-code-2" to="/docs/decisions/client"}
  Auth, limits, and the filters stay in your code. `useChoices()` only connects them.
  :::

  :::product-feature-item{title="Try it with no API key" icon="i-lucide-rocket" to="/docs/decisions/get-started"}
  The tutorial uses a small offline gateway. Swap it for a real model in the last step.
  :::

  :::product-feature-item{title="Know the limits" icon="i-lucide-info" to="/docs/decisions/limits-and-errors#limits"}
  100 options, 300 characters of text, and one error code for each failure.
  :::
::

::agent-only
Use Decisions to turn free text into a typed selection over options that the app declares. Decisions has no routes, no UI, and no store. Write the two bridges: data to options, and selection to state.

Call `resolve()` only on the server, inside a route that you own. Never import the choices value in browser code. Import its type with `import type`. A decision model cannot compare numbers or invent a value, so keep numeric filters in normal controls.

Prove it with `inspect()` first, then with a test gateway that has `ask()`. Do not claim live model behavior without a key.
::
