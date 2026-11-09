---
title: Agent Session
description: "Show a finished or running agent session with its timeline, a details card, and a right panel of surfaces such as the Workspace."
navigation.order: 42
navigation.group: Agent work
icon: i-ph-sidebar-simple-light
---

`AgentSession` is the layout of one agent session: a header, a centered timeline, a details card at the top right, and a right panel of surfaces. The Console uses it for a selected session, with the Workspace, Changes, Trace, Capabilities, and Details views as surfaces. The layout follows the thread view of [T3 Code](https://github.com/pingdotgg/t3code) (MIT).

::component-preview{name="AgentSessionExample" flush}
::

## Installation

Install `@vite-hub/ui` as described in [Installation](/docs/ui/installation). `vite-hub/nuxt` auto-imports the components. In Vue with Vite, import them from `@vite-hub/ui` or from the focused entry `@vite-hub/ui/agent-session`:

```ts
import { AgentSession, AgentSessionTimeline } from "@vite-hub/ui/agent-session";
```

## Usage

Give the session a title, the surfaces of its right panel, and the timeline items. Put the details card in the `details` slot and each surface in a `surface-<id>` slot.

```vue
<script setup lang="ts">
import {
  AgentSession,
  AgentSessionDetailsRow,
  AgentSessionDetailsSection,
  AgentSessionTimeline,
  type AgentSessionItem,
  type AgentSessionSurface,
} from "@vite-hub/ui/agent-session";

const surfaces: AgentSessionSurface[] = [
  { id: "files", label: "Files", icon: "i-lucide-files", shortcut: "f" },
];
const items: AgentSessionItem[] = [
  { type: "user", id: "prompt", text: "Add a /health route." },
  { type: "work", id: "work", label: "Worked for 42s", entries: [
    { id: "read", kind: "read", label: "Read", preview: "server/routes/index.ts" },
    { id: "edit", kind: "edit", label: "Edited", preview: "server/routes/health.ts", trailing: "+12" },
  ] },
  { type: "assistant", id: "answer", text: "Added `GET /health`. It returns `ok`." },
];
</script>

<template>
  <AgentSession title="Add a health route" :surfaces storage-key="my-app:session-layout">
    <AgentSessionTimeline :items />
    <template #details>
      <AgentSessionDetailsSection title="Session">
        <AgentSessionDetailsRow icon="i-lucide-circle-check" label="Status" value="Completed" />
        <AgentSessionDetailsRow icon="i-lucide-timer" label="Duration" value="42s" />
      </AgentSessionDetailsSection>
    </template>
    <template #surface-files>
      <MyFileTree />
    </template>
  </AgentSession>
</template>
```

## Composition

```text
AgentSession
├── header: heading slot, actions slot, details toggle, panel toggle
├── main
│   ├── scroll area and 46rem lane with the default slot, or the body slot
│   └── details card with the details slot
│       └── AgentSessionDetailsSection
│           └── AgentSessionDetailsRow
└── right panel: surface tabs, launcher, and the surface slots
```

`AgentSessionTimeline` renders user messages, assistant Markdown, dividers, and `AgentSessionWorkGroup` rows for tool work.

## Features

- Shows the details card beside the timeline when there is room. In a narrow column, the card opens as a popover that closes on Escape or an outside click.
- Keeps the panel toggle in the top right corner, whether the panel is open or closed.
- Opens surfaces as tabs. The empty panel lists them with their keyboard shortcuts.
- Resizes the panel with a pointer or the arrow keys. A double click resets the width.
- Keeps the panel, its width, its tabs, and the card in `localStorage` when you set `storageKey`.
- Folds a long user message after 10 lines.
- On screens narrower than 768px, an open panel replaces the timeline.

## Data Ownership

The components do not fetch or save the session. Map your session records to `AgentSessionItem` values in your application. Surfaces render what you put in their slots.

## Accessibility

- The details toggle and the panel toggle are buttons with `aria-pressed`.
- The surface tabs use the tab roles, and the panel resizer is a `separator` that the arrow keys move.
- A details row with `href` renders a link, and a row with a click listener renders a button. Other rows are plain text.
- Collapsed work groups and folded messages are buttons with `aria-expanded`.

## API Reference

### AgentSession

Renders the header, the timeline area, the details card, and the right panel.

#### Props

| Prop                 | Type                    | Default  | Description                                                              |
| -------------------- | ----------------------- | -------- | ------------------------------------------------------------------------ |
| `title`              | `string`                | Required | The session title, in the header.                                        |
| `subtitle`           | `string`                |          | Muted text after the title.                                              |
| `surfaces`           | `AgentSessionSurface[]` | `[]`     | The surfaces that the right panel can open.                              |
| `storageKey`         | `string`                |          | The `localStorage` key that keeps the layout. Without it, nothing stays. |
| `defaultPanelOpen`   | `boolean`               | `false`  | Opens the right panel on the first visit.                                |
| `defaultDetailsOpen` | `boolean`               | `true`   | Shows the inline details card on the first visit.                        |
| `defaultSurface`     | `string`                |          | The surface that an open panel shows on the first visit.                 |
| `defaultWidth`       | `number`                | `560`    | The first panel width in pixels.                                         |

#### Events

| Event            | Payload          | Description                                         |
| ---------------- | ---------------- | --------------------------------------------------- |
| `update:surface` | `string \| null` | The active surface changed, or the panel closed.    |

#### Slots

| Slot             | Scope         | Description                                                            |
| ---------------- | ------------- | ---------------------------------------------------------------------- |
| `default`        |               | Content of the centered lane, such as `AgentSessionTimeline`.          |
| `body`           |               | Replaces the scroll area and the lane, for content that scrolls itself. |
| `heading`        |               | Replaces the title and the subtitle.                                   |
| `actions`        |               | Header buttons before the toggles.                                     |
| `details`        |               | Content of the details card. Without it, there is no card.             |
| `surface-<id>`   | `{ surface }` | Content of one surface.                                                |
| `surface`        | `{ surface }` | Content of a surface that has no `surface-<id>` slot.                  |

The component exposes `openSurface(id)`, `closeSurface(id)`, and `togglePanel()`.

### AgentSessionDetailsSection

A group of rows in the details card, with an optional heading.

#### Props

| Prop    | Type     | Default | Description          |
| ------- | -------- | ------- | -------------------- |
| `title` | `string` |         | The section heading. |

### AgentSessionDetailsRow

A 32px row with an icon, a label, and a value at the end.

#### Props

| Prop    | Type                                                   | Default     | Description                                  |
| ------- | ------------------------------------------------------ | ----------- | -------------------------------------------- |
| `icon`  | `string`                                               |             | An Iconify name. The `icon` slot replaces it. |
| `label` | `string`                                               |             | The row label. The default slot replaces it. |
| `value` | `string \| number`                                     |             | The value at the end. The `value` slot replaces it. |
| `href`  | `string`                                               |             | Makes the row a link.                        |
| `tone`  | `"default" \| "muted" \| "success" \| "error" \| "info"` | `"default"` | The color of the value.                      |
| `title` | `string`                                               |             | The native tooltip.                          |

A click listener makes the row a button. Other attributes go to the row element.

### AgentSessionWorkGroup

A collapsed line such as **Worked for 42s**, with one row for each tool call.

#### Props

| Prop          | Type                     | Default  | Description                                  |
| ------------- | ------------------------ | -------- | -------------------------------------------- |
| `label`       | `string`                 |          | The line text. It defaults to the step count. |
| `entries`     | `AgentSessionWorkEntry[]` | Required | The tool calls.                              |
| `defaultOpen` | `boolean`                | `false`  | Opens the group on mount.                    |

### AgentSessionTimeline

Renders a list of `AgentSessionItem` values.

#### Props

| Prop    | Type                 | Default  | Description          |
| ------- | -------------------- | -------- | -------------------- |
| `items` | `AgentSessionItem[]` | Required | The timeline items.  |

An `item-<type>` slot, such as `item-assistant`, replaces the rendering of that item type. It receives `{ item }`.

#### Types

```ts
interface AgentSessionSurface {
  id: string;
  label: string;
  icon: string;
  shortcut?: string;
}

interface AgentSessionWorkEntry {
  id: string;
  kind: "command" | "edit" | "read" | "search" | "web" | "mcp" | "skill" | "thinking" | "plan" | "tool";
  label: string;
  preview?: string;
  detail?: string;
  status?: "running" | "error" | "done";
  trailing?: string;
}

type AgentSessionItem =
  | { type: "user"; id: string; text: string; createdAt?: string }
  | { type: "assistant"; id: string; text: string; createdAt?: string }
  | { type: "work"; id: string; label?: string; entries: AgentSessionWorkEntry[]; defaultOpen?: boolean }
  | { type: "divider"; id: string; label: string };
```

## Related

- [Chat session](/docs/ui/chat-session) shows a conversation that a person continues.
- [File tree](/docs/ui/file-tree) and [Diff](/docs/ui/diff) fit in the surfaces.
