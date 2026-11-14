---
title: Status
description: "Show the state of a run, a connection, or a document as a colored dot and a short label."
navigation.order: 17
navigation.group: Parts
icon: i-lucide-circle
---

`Status` shows a state as a 6px dot and a label, as [Geist's Status Dot](https://vercel.com/geist/status-dot). The dot takes the color of the tone. The label keeps the color of the text around it, so color is never the only signal.

::example{name="StatusExample" height=12}
::

## Installation

Install `@vite-hub/ui` as described in [Installation](/docs/ui/installation). The Nuxt module auto-imports `Status`. In Vue with Vite, import it from `@vite-hub/ui`:

```ts
import { Status } from "@vite-hub/ui";
```

## Usage

```vue
<template>
  <Status tone="success" label="Ready" />
  <Status tone="info" label="Building" pulse />
  <Status tone="error" label="Failed" colored />
</template>
```

## Tones

| Tone      | Use it for                                    |
| --------- | --------------------------------------------- |
| `neutral` | Not started, a draft, or cancelled.           |
| `success` | Done, connected, or published.                |
| `warning` | Queued, partial, or waiting for someone.      |
| `error`   | Failed, or a problem that needs action.       |
| `info`    | Running, or a state that is only information. |

## Colored label

Add `colored` when the label is the status itself, such as "Failed" or "Expired". The label then uses the darker text shade of the tone, which keeps 4.5:1 on the page. Leave it off when the label names something else, such as a legend entry beside a chart.

## Live states

Add `pulse` while the state can change soon, such as "Connecting" or "Running". The dot pings. The ping stops when the reader prefers reduced motion.

## Accessibility

The dot is decorative. The label is the accessible text. When a layout shows only the dot, leave out the label and put the text beside the dot in a visually hidden element, so screen readers still hear it:

```vue
<template>
  <Status tone="success" />
  <span class="sr-only">Published</span>
</template>
```

`Status` does not announce changes. Wrap a status that changes while the reader is on the page in an element with `role="status"`.

## API Reference

### Status

Renders a `span` with `data-slot="status"`, `data-tone`, and `data-size`. The dot is a `span` with `data-slot="status-indicator"`, and the label a `span` with `data-slot="status-label"`. The default slot replaces the label.

#### Props

| Prop      | Type                                                      | Default     | Description                                                   |
| --------- | --------------------------------------------------------- | ----------- | ------------------------------------------------------------- |
| `tone`    | `"neutral" \| "success" \| "warning" \| "error" \| "info"` | `"neutral"` | The color of the dot.                                         |
| `label`   | `string`                                                  |             | The text beside the dot.                                      |
| `colored` | `boolean`                                                 | `false`     | Colors the label with the tone. Use it when the label is the status. |
| `pulse`   | `boolean`                                                 | `false`     | Pings the dot for a live or pending state.                    |
| `size`    | `"sm" \| "md"`                                            | `"sm"`      | `sm` for 12px text, `md` for 14px text.                       |

## Related

- [Connection Status](/docs/ui/connection-status) shows the connection of a realtime editor.
- [Sync Status](/docs/ui/sync-status) shows whether edits are saved.
