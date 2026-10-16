---
title: Connection Status
description: "Show whether a realtime editor is connecting, connected, or reconnecting."
navigation.order: 31
navigation.group: Collaboration
icon: i-ph-wifi-high-light
---

`ConnectionStatus` shows the connection of a realtime editor. `status` takes the values that y-websocket, Hocuspocus, and y-partyserver emit, so a provider's status passes straight through. The parts split as [Kibo UI's Status](https://www.kibo-ui.com/components/status): an indicator dot and a label.

::component-preview{name="ConnectionStatusExample"}
::

## Installation

Install `@vite-hub/ui` as described in [Installation](/docs/ui/installation). The Nuxt module auto-imports the parts. In Vue with Vite, import them from `@vite-hub/ui` or from the focused entry `@vite-hub/ui/connection-status`:

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

- Three states: `connecting` until the first connection, `connected`, and `reconnecting` after a lost connection.
- A dropped connection stays `connected` for `delay` ms, so short drops do not flicker. Most come back sooner, and the editor keeps the edits meanwhile.
- Pending states pulse. The pulse stops when the reader prefers reduced motion.
- `data-status` on every part, so a utility class or your own CSS can style each state.

## States

| `status` from the provider            | Shown          |
| ------------------------------------- | -------------- |
| Not connected yet                     | `connecting`   |
| `connected`                           | `connected`    |
| Not `connected` for `delay` ms or more | `reconnecting` |

A provider that retries alternates between `disconnected` and `connecting`. The delay counts from the moment it left `connected`.

## Custom Label

`ConnectionStatusLabel` passes the state to its slot.

::component-preview{name="ConnectionStatusLabelExample"}
::

## Accessibility

`ConnectionStatus` has `role="status"`, so a screen reader announces a change of the label, such as "Reconnecting", without moving focus. The indicator is decorative. The label is the accessible text, so keep a label in custom compositions.

## API Reference

### ConnectionStatus

The root. Renders a `div` with `data-slot="connection-status"` and `data-status`.

#### Props

| Prop     | Type                                              | Default  | Description                                                                 |
| -------- | ------------------------------------------------- | -------- | --------------------------------------------------------------------------- |
| `status` | `"connecting" \| "connected" \| "disconnected"`   | Required | The provider's connection status.                                           |
| `delay`  | `number`                                          | `1500`   | How long, in ms, a lost connection shows `connected` before `reconnecting`. |

### ConnectionStatusIndicator

A dot that shows the state. Has no props. Renders a `span` with `data-slot="connection-status-indicator"`.

### ConnectionStatusLabel

The state as text: "Connecting", "Connected", or "Reconnecting". The default slot receives `{ state }`. Has no props. Renders a `span` with `data-slot="connection-status-label"`.

## Related

- [Sync Status](/docs/ui/sync-status) shows whether edits are saved.
- [Avatar Stack](/docs/ui/avatar-stack) shows who is in the room.
