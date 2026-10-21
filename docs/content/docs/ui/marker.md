---
title: Marker
description: "Show an inline status, a note, or a labeled separator between conversation turns."
navigation.order: 12
navigation.group: Parts
icon: i-ph-flag-light
---

`Marker` is a quiet line between turns: a date separator, a branch switch, or a note that the context was compacted. The parts have the same names, props, and `data-slot` attributes as the [shadcn/ui Marker](https://ui.shadcn.com/docs/components/marker). Use it with [Message](/docs/ui/message) in a conversation.

::component-preview{name="MarkerExample"}
::

## Installation

Install `@vite-hub/ui` as described in [Installation](/docs/ui/installation). The Nuxt module auto-imports the parts. In Vue with Vite, import them from `@vite-hub/ui` or from the focused entry `@vite-hub/ui/marker`:

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

- Three variants: an inline row, a row with a bottom border, and a labeled separator.
- `MarkerIcon` is decorative and hidden from assistive technology.
- `as` on `Marker` renders a link or a button.
- Text and lines use the Nuxt UI tokens of your app.
- The default styles are in the `components` layer of `@vite-hub/ui/styles.css`, so utility classes override them.

## Variants

Use `variant` to choose an inline marker, a bordered row, or a labeled separator.

::component-preview{name="MarkerVariantsExample"}
::

| Variant     | Description                                           |
| ----------- | ----------------------------------------------------- |
| `default`   | An inline marker for status, notes, and actions.      |
| `border`    | A default marker with a border under the row.         |
| `separator` | A centered label with a line on each side.            |

## Status

Set `role="status"` on a marker for work in progress, so assistive technology reads the update. ViteHub does not animate status text, so write the state in the text, for example "Running pnpm test".

::component-preview{name="MarkerStatusExample"}
::

## Separator

Use the `separator` variant for labeled dividers, such as dates or section breaks, in a conversation.

::component-preview{name="MarkerSeparatorExample"}
::

## Border

Use the `border` variant for status rows that keep the default alignment and separate the next row.

::component-preview{name="MarkerBorderExample"}
::

## With Icon

Use `MarkerIcon` to show an icon next to the content. Add `class="flex-col"` to put the icon above the content.

::component-preview{name="MarkerIconExample"}
::

## Links and Buttons

Set `as` on `Marker` to render the whole marker as a link or a button. A link marker gets an underline and a hover color.

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

`Marker` has no role by default. Choose the role from what the marker does.

### Status and Progress

For work in progress, such as "Thinking" or a running tool, set `role="status"`. Assistive technology then reads the update when it appears. `Marker` passes `role` to its element.

```vue
<Marker role="status">
  <MarkerIcon><UIcon name="i-ph-circle-dashed-light" /></MarkerIcon>
  <MarkerContent>Compacting the conversation</MarkerContent>
</Marker>
```

### Labeled Separators

A separator with text, such as a date, needs no role. The lines are decorative CSS pseudo-elements, and the text is read as usual content.

Do not add `role="separator"` to a labeled divider. A separator takes its name from `aria-label`, not from its text, so the visible label is not read. Use `role="separator"` only for a divider without text.

### Decorative Icons

`MarkerIcon` sets `aria-hidden="true"`, so put the meaning in `MarkerContent`. For a marker with only an icon, give the `Marker` an `aria-label`.

```vue
<Marker aria-label="Synced">
  <MarkerIcon><UIcon name="i-ph-check-light" /></MarkerIcon>
</Marker>
```

### Interactive Markers

When a marker opens a page or starts an action, set `as="a"` or `as="button"`. The marker is then focusable and has the correct role. The marker text is the accessible name.

## API Reference

### Marker

The root of a marker. Renders `data-slot="marker"` on the element that `as` selects.

#### Props

| Prop      | Type                                   | Default     | Description                                            |
| --------- | -------------------------------------- | ----------- | ------------------------------------------------------ |
| `variant` | `"default" \| "border" \| "separator"` | `"default"` | An inline row, a row with a bottom border, or a centered label between lines. |
| `as`      | `string \| Component`                  | `"div"`     | Renders the marker as another element, such as a link. |

### MarkerIcon

A decorative icon slot. Has no props. Renders a `span` with `data-slot="marker-icon"` and `aria-hidden="true"`.

### MarkerContent

The text of the marker. Has no props. Renders a `span` with `data-slot="marker-content"`.

## Related

- [Trace](/docs/ui/trace) shows the steps of an Agent turn.
- [Message](/docs/ui/message) lays out each turn.
