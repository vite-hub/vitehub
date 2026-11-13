---
title: Agent Session
description: "Show an Agent session with a timeline, details card, and a panel of inspection surfaces."
navigation.order: 26
navigation.group: Chat
icon: i-ph-layout-light
---

`AgentSession` gives a session a header, a centered timeline, a details card, and a resizable right panel. The layout follows [T3 Code](https://github.com/pingdotgg/t3code), under its MIT license. Your app owns session data and the content of each surface.

::example{name="AgentSessionExample" height=30 flush}
::

## Installation

Import the components and package styles as described in [Installation](/docs/ui/installation):

```ts
import { AgentSession, AgentSessionDetailsRow, AgentSessionDetailsSection, AgentSessionTimeline } from "@vite-hub/ui/agent-session";
import "@vite-hub/ui/styles.css";
```

The same entry is available at `vite-hub/ui/agent-session`. The root `@vite-hub/ui` entry also exports these components.

## Usage

```vue
<AgentSession
  title="Update the docs"
  :surfaces="[{ id: 'trace', label: 'Trace', icon: 'i-lucide-list-tree', shortcut: 't' }]"
  storage-key="my-app:session-layout"
>
  <AgentSessionTimeline :items="items" />
  <template #details>
    <AgentSessionDetailsSection title="Session">
      <AgentSessionDetailsRow label="Status" value="Completed" />
    </AgentSessionDetailsSection>
  </template>
  <template #surface-trace>Trace content</template>
</AgentSession>
```

The default slot scrolls with the timeline. Put a timeline that owns its scrolling in the `body` slot instead. `heading` replaces the title and subtitle; `actions` adds header actions. `details` fills the card, which becomes a popover when space is limited. Each surface uses `surface-<id>`, or the fallback `surface` slot with `{ surface }`.

Use `v-model:surface`, `v-model:panel-open`, and `v-model:maximized` to connect the view to a router. Controlled values take priority over saved layout values. Without these props, the layout owns its state. `storageKey` retains the panel width, open tabs, selected surface, panel state, and details card state in local storage. Surface shortcuts work while the empty panel has focus. The component instance exposes `openSurface(id)`, `closeSurface(id)`, and `togglePanel()`.

`AgentSessionTimeline` accepts `AgentSessionItem[]`: user and assistant turns have `id`, `type`, and `text`; work turns have `entries`; dividers have `label`. Override a turn with an `item-user`, `item-assistant`, `item-work`, or `item-divider` slot, each receiving `{ item }`.

`AgentSessionWorkGroup` folds `AgentSessionWorkEntry[]` behind a summary. Entries have `id`, `kind`, and `label`, with optional `preview`, `detail`, `status`, and `trailing`. Kinds are `command`, `edit`, `read`, `search`, `web`, `mcp`, `skill`, `thinking`, `plan`, and `tool`; status is `running`, `error`, or `done`.

## Accessibility

Header controls have accessible names and pressed states. Surface tabs expose their selected state. The panel width can be changed with the keyboard on its separator. Escape closes the details popover and returns focus to its toggle. Long user turns and work groups expose expanded states on their buttons.

## API Reference

### AgentSession

#### Props

| Prop | Type | Default | Description |
| --- | --- | --- | --- |
| `title` | `string` | Required | Session heading. |
| `subtitle` | `string` | | Secondary heading text. |
| `surfaces` | `AgentSessionSurface[]` | `[]` | Panel surfaces, each with `id`, `label`, `icon`, and optional `shortcut`. |
| `storageKey` | `string` | | Local storage key for the layout. |
| `defaultPanelOpen` | `boolean` | `false` | Initial panel state without stored or controlled state. |
| `defaultDetailsOpen` | `boolean` | `true` | Initial inline details card state. |
| `defaultSurface` | `string` | | Initial surface without stored or controlled state. |
| `defaultWidth` | `number` | `560` | Initial panel width in pixels. |
| `surface` | `string \| null` | | Controlled surface; `null` shows the launcher. |
| `panelOpen` | `boolean` | | Controlled panel visibility. |
| `maximized` | `boolean` | | Controlled panel maximization. |

#### Events

| Event | Payload | Description |
| --- | --- | --- |
| `update:surface` | `string \| null` | Selected surface changed. |
| `update:panelOpen` | `boolean` | Panel visibility changed. |
| `update:maximized` | `boolean` | Panel maximization changed. |

### AgentSessionDetailsSection

#### Props

| Prop | Type | Default | Description |
| --- | --- | --- | --- |
| `title` | `string` | | Heading above the default slot. |

### AgentSessionDetailsRow

#### Props

| Prop | Type | Default | Description |
| --- | --- | --- | --- |
| `icon` | `string` | | Iconify name. The `icon` slot can replace it. |
| `label` | `string` | | Row label, replaced by the default slot when supplied. |
| `value` | `string \| number` | | Row value, replaced by the `value` slot when supplied. |
| `href` | `string` | | Link destination. An `onClick` handler makes a button when no link is set. |
| `tone` | `"default" \| "muted" \| "success" \| "error" \| "info"` | `"default"` | Value color. |
| `title` | `string` | | Browser tooltip. |

### AgentSessionTimeline

#### Props

| Prop | Type | Default | Description |
| --- | --- | --- | --- |
| `items` | `AgentSessionItem[]` | Required | Session turns in display order. |

### AgentSessionWorkGroup

#### Props

| Prop | Type | Default | Description |
| --- | --- | --- | --- |
| `label` | `string` | | Summary text; otherwise shows the step count. |
| `entries` | `AgentSessionWorkEntry[]` | Required | Tool calls in display order. |
| `defaultOpen` | `boolean` | `false` | Initial expanded state. |
