---
title: Decisions recipes
description: "Four uses of Decisions: filters, search facets, a command palette, and dashboard knobs, each with both bridges."
navigation.title: Recipes
navigation.order: 10
icon: i-lucide-blocks
---

In each recipe, the server defines the choices and a route calls `resolve()`. The browser calls `useChoices()`. You write two bridges: data to options, and selection to state. The route is always the same; [Get started](/docs/decisions/get-started) shows it.

## Filters

A demand forecast has filter chips for suppliers and materials. Typing "nord parts except vak supply" fills the chips.

**Bridge in.** Your lists become options:

```ts [server/utils/forecast-choices.ts]
export const forecast = defineChoices({
  gateway: typesafe(),
  groups: {
    supplier: { label: "Supplier", options: toOptions(suppliers, { value: s => s.id, label: s => s.name, aliases: s => [s.code] }) },
    material: { label: "Material", options: toOptions(materials, { value: m => m.id, label: m => m.name }) },
  },
})
```

**Bridge out.** The selection becomes your store filters:

```ts
useChoices<typeof forecast>({
  resolve,
  onSelect: (selection) => {
    filters.suppliers = selection.supplier.include
    filters.excludedSuppliers = selection.supplier.exclude
    filters.materials = selection.material.include
  },
})
```

```ts
selection.supplier // { include: ["nord"], exclude: ["vak"] }
selection.material // { include: [], exclude: [] }
```

A group the text does not mention has empty lists. Decide in `onSelect` if empty means "keep the chips" or "clear them".

## Search facets

A docs search box has facets for section and page kind. "guides about queues" sets the facets, and the rest of the query stays in the box.

**Bridge in.** The facets are fixed lists:

```ts [server/utils/search-choices.ts]
export const search = defineChoices({
  gateway: typesafe(),
  groups: {
    section: { label: "Section", options: sections.map(s => ({ value: s.slug, label: s.title })) },
    kind: { label: "Kind", multiple: false, options: [{ value: "guide", label: "Guide" }, { value: "reference", label: "Reference" }] },
  },
})
```

**Bridge out.** The selection becomes the URL query:

```ts
useChoices<typeof search>({
  resolve,
  onSelect: selection => navigateTo({
    query: { section: selection.section.include, kind: selection.kind.value ?? undefined },
  }),
})
```

```ts
selection.section // { include: ["queue"], exclude: [] }
selection.kind // { value: "guide", confidence: 0.85, ranked: [...] }
```

Decisions picks facets but does not search. Your search code reads the query as before.

## Command palette

"open settings" runs one command from a palette. Use a single group, so at most one command is picked.

**Bridge in.** Your commands become options, with the command id as the value:

```ts [server/utils/palette-choices.ts]
export const palette = defineChoices({
  gateway: typesafe(),
  groups: {
    command: { label: "Command", multiple: false, options: toOptions(commands, { value: c => c.id, label: c => c.title, aliases: c => c.keywords }) },
  },
})
```

**Bridge out.** Run a command only when the model is sure:

```ts
useChoices<typeof palette>({
  resolve,
  onSelect: ({ command }) => {
    if (command.value) runCommand(command.value)
    else showSuggestions(command.ranked.slice(0, 3))
  },
})
```

```ts
selection.command // { value: "open-settings", confidence: 0.82, ranked: [{ value: "open-settings", probability: 0.82 }, ...] }
```

When `value` is `null`, use the ranked list as suggestions.

::warning
Do not run a destructive command from a model answer without a confirm step.
::

## Dashboard knobs

"revenue last quarter as bars" sets three dashboard knobs: metric, period, and chart type.

**Bridge in.** Each knob is a single group:

```ts [server/utils/dashboard-choices.ts]
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

```ts
useChoices<typeof dashboard>({
  resolve,
  onSelect: ({ metric, period, chart }) => {
    if (metric.value) knobs.metric = metric.value
    if (period.value) knobs.period = period.value
    if (chart.value) knobs.chart = chart.value
  },
})
```

```ts
selection.metric // { value: "revenue", confidence: 0.8, ranked: [...] }
selection.period // { value: "quarter", confidence: 0.8, ranked: [...] }
selection.chart // { value: "bar", confidence: 0.8, ranked: [...] }
```

A knob the text does not mention has `value: null` and keeps its setting.

## What these recipes do not do

Decisions only picks among options. It does not compare numbers, so "orders over 500" needs a normal input. Your code, not Decisions, searches and runs commands. Read [Limits and errors](/docs/decisions/limits-and-errors).
