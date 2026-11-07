---
title: Marker
description: "Show an inline status, a note, or a labeled separator between conversation turns."
navigation.order: 12
navigation.group: Parts
icon: i-ph-flag-light
---

`Marker` is a quiet line between turns: a date separator, a branch switch, or a note that the context was compacted. Use it with [Message](/docs/ui/message). The parts match the names, props, and `data-slot` attributes of the [shadcn/ui Marker](https://ui.shadcn.com/docs/components/marker).

::component-preview{name="MarkerExample"}
::

## Installation

Install `@vite-hub/ui` as [Installation](/docs/ui/installation) shows. The Nuxt module auto-imports the parts. In Vue with Vite, import them from `@vite-hub/ui` or `@vite-hub/ui/marker`:

```ts
import { Marker, MarkerContent, MarkerIcon } from "@vite-hub/ui";
```

## Usage

```ts
import { Marker, MarkerContent, MarkerIcon } from "@vite-hub/ui";
```

```vue
<template>
  <Marker>
    <MarkerIcon><UIcon name="i-ph-magnifying-glass-light" /></MarkerIcon>
    <MarkerContent>Explored 4 files</MarkerContent>
  </Marker>
</template>
```

## Composition

```text
Marker
├── MarkerIcon
└── MarkerContent
```

## Features

- Three variants: inline, bordered, and labeled separator.
- `MarkerIcon` is hidden from assistive technology.
- `as` renders a link or button.
- Text and lines use your app's Nuxt UI tokens.
- Default styles sit in the `components` layer of `@vite-hub/ui/styles.css`, so utility classes override them.

## Variants

Use `variant` to pick a style.

::component-preview{name="MarkerVariantsExample"}
::

| Variant     | Description                                           |
| ----------- | ----------------------------------------------------- |
| `default`   | Inline, for status, notes, and actions. |
| `border`    | Inline, with a border under the row. |
| `separator` | A centered label with a line on each side.            |

## Status

Set `role="status"` for work in progress, so assistive technology reads the update. ViteHub does not animate status text, so write the state in it, such as "Running pnpm test".

::component-preview{name="MarkerStatusExample"}
::

## Separator

Use `separator` for labeled dividers, such as dates or section breaks.

::component-preview{name="MarkerSeparatorExample"}
::

## Border

Use `border` for status rows that keep the default alignment and separate the next row.

::component-preview{name="MarkerBorderExample"}
::

## With Icon

`MarkerIcon` shows an icon next to the content. Add `class="flex-col"` to put it above.

::component-preview{name="MarkerIconExample"}
::

## Links and Buttons

Set `as` to render the marker as a link or button. A link gets an underline and a hover color.

::component-preview{name="MarkerLinksExample"}
::

```vue
<Marker as="a" href="#latest">
  <MarkerContent>Jump to the latest message</MarkerContent>
</Marker>
<Marker :as="NuxtLink" to="/runs/42">
  <MarkerContent>Open run 42</MarkerContent>
</Marker>
```

## Accessibility

`Marker` has no role by default. Pick one from what the marker does.

### Status and Progress

For work in progress, such as "Thinking" or a running tool, set `role="status"` so assistive technology reads the update. `Marker` passes `role` to its element.

```vue
<Marker role="status">
  <MarkerIcon><UIcon name="i-ph-circle-dashed-light" /></MarkerIcon>
  <MarkerContent>Compacting the conversation</MarkerContent>
</Marker>
```

### Labeled Separators

A separator with text, such as a date, needs no role. The lines are decorative CSS pseudo-elements, and the text reads as normal.

Do not add `role="separator"` to a labeled divider. A separator takes its name from `aria-label`, not its text, so the label is not read. Use `role="separator"` only for a divider without text.

### Decorative Icons

`MarkerIcon` sets `aria-hidden="true"`, so put the meaning in `MarkerContent`. For an icon-only marker, give `Marker` an `aria-label`.

```vue
<Marker aria-label="Synced">
  <MarkerIcon><UIcon name="i-ph-check-light" /></MarkerIcon>
</Marker>
```

### Interactive Markers

When a marker opens a page or starts an action, set `as="a"` or `as="button"`. It is then focusable with the correct role. Its text is the accessible name.

## API Reference

### Marker

Renders `data-slot="marker"` on the element that `as` selects.

#### Props

| Prop      | Type                                   | Default     | Description                                            |
| --------- | -------------------------------------- | ----------- | ------------------------------------------------------ |
| `variant` | `"default" \| "border" \| "separator"` | `"default"` | Inline, bordered, or a centered label between lines. |
| `as`      | `string \| Component`                  | `"div"`     | Renders another element, such as a link. |

### MarkerIcon

A decorative icon. No props. Renders a `span` with `data-slot="marker-icon"` and `aria-hidden="true"`.

### MarkerContent

The marker text. No props. Renders a `span` with `data-slot="marker-content"`.

## Related

- [Trace](/docs/ui/trace) shows the steps of an Agent turn.
- [Message](/docs/ui/message) lays out each turn.
