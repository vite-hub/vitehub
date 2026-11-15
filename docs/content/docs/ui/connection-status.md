---
title: Connection Status
description: "Show whether a realtime editor is connecting, connected, or reconnecting."
navigation.order: 31
navigation.group: Collaboration
icon: i-lucide-wifi
---

`ConnectionStatus` shows the connection of a realtime editor. `status` takes the values that y-websocket, Hocuspocus, and y-partyserver emit, so pass a provider's status as it is. Like [Kibo UI's Status](https://www.kibo-ui.com/components/status), it has an indicator dot and a label.

::example{name="ConnectionStatusExample" height=8}
::

## Installation

Install `@vite-hub/ui` as [Installation](/docs/ui/installation) shows. `vite-hub/nuxt` auto-imports the parts. In Vue with Vite, import them from `@vite-hub/ui`:

```ts
import { ConnectionStatus, ConnectionStatusIndicator, ConnectionStatusLabel } from "@vite-hub/ui";
```

## Usage

```ts
import { ConnectionStatus } from "@vite-hub/ui";
import { useRealtimeTiptap } from "vite-hub/realtime/vue";

const { status } = useRealtimeTiptap("docs", "guides/welcome.md");
```

```vue
<template>
  <ConnectionStatus :status="status" />
</template>
```

## Composition

```text
ConnectionStatus
├── ConnectionStatusIndicator
└── ConnectionStatusLabel
```

Without children, `ConnectionStatus` renders both parts.

## Features

- A dropped connection shows `connected` for `delay` ms, so short drops do not flicker. The editor keeps edits meanwhile.
- Pending states pulse, except with reduced motion.
- Every part has `data-status` for styling each state.

## States

| `status` from the provider            | Shown          |
| ------------------------------------- | -------------- |
| Not connected yet                     | `connecting`   |
| `connected`                           | `connected`    |
| Not `connected` for `delay` ms or more | `reconnecting` |

A retrying provider switches between `disconnected` and `connecting`. The delay counts from when it left `connected`.

## Custom Label

`ConnectionStatusLabel` passes the state to its slot.

::example{name="ConnectionStatusLabelExample" height=8}
::

## Accessibility

`ConnectionStatus` has `role="status"`, so screen readers announce label changes, such as "Reconnecting", without moving focus. The indicator is decorative and the label is the accessible text, so keep a label in custom layouts.

## API Reference

### ConnectionStatus

The root. Renders a `div` with `data-slot="connection-status"` and `data-status`.

#### Props

| Prop     | Type                                              | Default  | Description                                                                 |
| -------- | ------------------------------------------------- | -------- | --------------------------------------------------------------------------- |
| `status` | `"connecting" \| "connected" \| "disconnected"`   | Required | The provider's status. |
| `delay`  | `number`                                          | `1500`   | Ms a lost connection shows `connected` before `reconnecting`. |

### ConnectionStatusIndicator

A dot that shows the state. No props. Renders a `span` with `data-slot="connection-status-indicator"`.

### ConnectionStatusLabel

The state as text: "Connecting", "Connected", or "Reconnecting". The default slot receives `{ state }`. No props. Renders a `span` with `data-slot="connection-status-label"`.

## Related

- [Sync Status](/docs/ui/sync-status) shows whether edits are saved.
- [Avatar Stack](/docs/ui/avatar-stack) shows who is in the room.
- [Collaborative Editor](/docs/ui/blocks/collaborative-editor) combines all collaboration parts with Realtime.
