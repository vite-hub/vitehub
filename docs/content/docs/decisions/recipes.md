---
title: Decisions recipes
description: "Four ways to use Decisions: filters, search facets, a command palette, and dashboard knobs. Each shows both bridges."
navigation.title: Recipes
navigation.order: 10
icon: i-lucide-blocks
---

Every recipe has the same three parts. The server defines the choices and has a route that calls `resolve()`. The browser calls `useChoices()`. You write two bridges: your data to options, and the selection to your state.

The route is the same in each recipe. [Get started](/docs/decisions/get-started) shows it in full.

## Filters

A demand forecast has filter chips for suppliers and materials. A person types "nord parts except vak supply" and the chips fill.

**Bridge in.** Your lists become options:

```ts [server/utils/forecast-choices.ts] fragment
export const forecast = defineChoices({
  gateway: typesafe(),
  groups: {
    supplier: { label: "Supplier", options: toOptions(suppliers, { value: s => s.id, label: s => s.name, aliases: s => [s.code] }) },
    material: { label: "Material", options: toOptions(materials, { value: m => m.id, label: m => m.name }) },
  },
})
```

**Bridge out.** The selection becomes the filters of your store:

```ts fragment
useChoices<typeof forecast>({
  resolve,
  onSelect: (selection) => {
    filters.suppliers = selection.supplier.include
    filters.excludedSuppliers = selection.supplier.exclude
    filters.materials = selection.material.include
  },
})
```

```ts fragment
selection.supplier // { include: ["nord"], exclude: ["vak"] }
selection.material // { include: [], exclude: [] }
```

A group the text does not mention comes back with empty lists. Decide in `onSelect` if empty means "leave the chips" or "clear them".

## Search facets

A search box on a docs site has facets for the section and the kind of page. "guides about queues" sets the facets and the rest of the query stays in the box.

**Bridge in.** The facets are fixed lists:

```ts [server/utils/search-choices.ts] fragment
export const search = defineChoices({
  gateway: typesafe(),
  groups: {
    section: { label: "Section", options: sections.map(s => ({ value: s.slug, label: s.title })) },
    kind: { label: "Kind", multiple: false, options: [{ value: "guide", label: "Guide" }, { value: "reference", label: "Reference" }] },
  },
})
```

**Bridge out.** The selection becomes the URL query:

```ts fragment
useChoices<typeof search>({
  resolve,
  onSelect: selection => navigateTo({
    query: { section: selection.section.include, kind: selection.kind.value ?? undefined },
  }),
})
```

```ts fragment
selection.section // { include: ["queue"], exclude: [] }
selection.kind // { value: "guide", confidence: 0.85, ranked: [...] }
```

Decisions picks facets. It does not search. Your search code reads the query as before.

## Command palette

A palette lists commands. "open settings" runs one. Use a single group, so the person gets at most one command.

**Bridge in.** Your commands become options. The value is the id of the command:

```ts [server/utils/palette-choices.ts] fragment
export const palette = defineChoices({
  gateway: typesafe(),
  groups: {
    command: { label: "Command", multiple: false, options: toOptions(commands, { value: c => c.id, label: c => c.title, aliases: c => c.keywords }) },
  },
})
```

**Bridge out.** The selection runs a command, but only when the model is sure:

```ts fragment
useChoices<typeof palette>({
  resolve,
  onSelect: ({ command }) => {
    if (command.value) runCommand(command.value)
    else showSuggestions(command.ranked.slice(0, 3))
  },
})
```

```ts fragment
selection.command // { value: "open-settings", confidence: 0.82, ranked: [{ value: "open-settings", probability: 0.82 }, ...] }
```

When `value` is `null`, the ranked list is your suggestion list. Do not run a destructive command from a model answer without a confirm step.

## Dashboard knobs

A dashboard has a metric, a period, and a chart type. "revenue last quarter as bars" sets all three knobs.

**Bridge in.** Each knob is a single group:

```ts [server/utils/dashboard-choices.ts]
import { typesafe } from 'vite-hub/gateways'
import { defineChoices } from 'vite-hub/decisions'

export const dashboard = defineChoices({
  gateway: typesafe(),
  groups: {
    metric: { label: "Metric", multiple: false, options: [{ value: "revenue", label: "Revenue" }, { value: "orders", label: "Orders" }] },
    period: { label: "Period", multiple: false, options: [{ value: "month", label: "Last month" }, { value: "quarter", label: "Last quarter" }] },
    chart: { label: "Chart", multiple: false, options: [{ value: "line", label: "Lines" }, { value: "bar", label: "Bars" }] },
  },
})
```

**Bridge out.** Set a knob only when the model chose a value:

```ts fragment
useChoices<typeof dashboard>({
  resolve,
  onSelect: ({ metric, period, chart }) => {
    if (metric.value) knobs.metric = metric.value
    if (period.value) knobs.period = period.value
    if (chart.value) knobs.chart = chart.value
  },
})
```

```ts fragment
selection.metric // { value: "revenue", confidence: 0.8, ranked: [...] }
selection.period // { value: "quarter", confidence: 0.8, ranked: [...] }
selection.chart // { value: "bar", confidence: 0.8, ranked: [...] }
```

A knob the text does not mention has `value: null`, so it keeps its old setting.

## What these recipes do not do

Decisions picks among options. It does not compare numbers, so "orders over 500" needs a normal input. It does not search or run commands. Your code does that with the selection. See [Limits and errors](/docs/decisions/limits-and-errors).
