---
title: Marker
description: "Show an inline status, a note, or a labeled separator between conversation turns."
navigation.order: 12
navigation.group: Parts
icon: i-ph-flag-light
---

`Marker` is a quiet line between turns: a date separator, a branch switch, or a note that the context was compacted. The parts have the same names, props, and `data-slot` attributes as the [shadcn/ui Marker](https://ui.shadcn.com/docs/components/marker).

::component-preview{name="MarkerExample"}
::

## Usage

```vue
<template>
  <Marker variant="separator">
    <MarkerContent>Today</MarkerContent>
  </Marker>
  <Marker>
    <MarkerIcon><UIcon name="i-ph-git-branch-light" /></MarkerIcon>
    <MarkerContent>Switched to fix/frozen-lockfile</MarkerContent>
  </Marker>
</template>
```

Set `as` to render the whole marker as a link or a button:

```vue
<Marker as="a" href="#latest">
  <MarkerContent>Jump to the latest message</MarkerContent>
</Marker>
```

## API reference

### Marker

#### Props

| Prop      | Type                                   | Default     | Description                                            |
| --------- | -------------------------------------- | ----------- | ------------------------------------------------------ |
| `variant` | `"default" \| "border" \| "separator"` | `'default'` | An inline row, a row with a bottom border, or a centered label between lines. |
| `as`      | `string \| Component`                  | `'div'`     | Renders the marker as another element, such as a link. |

### MarkerIcon

### MarkerContent

These parts have no props. `MarkerIcon` sets `aria-hidden="true"`.

## Accessibility

- Put the meaning in `MarkerContent`. The icon is hidden from screen readers.
- A status that changes while the reader waits, such as "Compacting context", needs a live region in your app.

## Related

- [Trace](/docs/ui/trace) shows the steps of an Agent turn.
- [Message](/docs/ui/message) lays out each turn.
