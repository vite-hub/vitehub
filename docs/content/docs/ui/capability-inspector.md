---
title: Capability Inspector
description: "Show what each Capability recorded for one Invocation, including MCP servers, tool contracts, and custom read-only views."
navigation.order: 34
navigation.group: Agent work
icon: i-ph-plugs-connected-light
---

`AgentCapabilityInspector` shows the Capabilities captured for one Agent Invocation. Select a Capability to see its recorded state, its tool contracts, and its configuration. A Capability can contribute a read-only view, for example the MCP server list or the Title generation state. Use it as a Capabilities tab next to the [Invocation inspector](/docs/ui/invocation-inspector).

::component-preview{name="CapabilityInspectorExample"}
::

## Usage

```vue
<AgentCapabilityInspector :invocation="record" @select-activity="selectedActivityId = $event" />
```

It takes the same `invocation` as `AgentInvocationInspector`. The Invocation inspector hides its embedded Capability summary by default, so the two panels work together without overrides.

## Capability views

A Capability declares `inspection.view` as a JSON Render spec (`@json-render/core`) and records `inspection.state` during the run. The inspector renders the view with a small read-only catalog:

| Element    | Props               | Renders                                                          |
| ---------- | ------------------- | ---------------------------------------------------------------- |
| `Stack`    |                     | Its children in a column.                                        |
| `Section`  | `title`             | A titled group.                                                  |
| `Text`     | `text`              | A paragraph. Empty text renders nothing.                         |
| `KeyValue` | `label`, `value`    | One label and value.                                             |
| `Tools`    | `names`, `mcpServer` | The Capability's tool contracts, filtered by name or MCP server. |

Props can read the recorded state with `{ $state: "/path" }`, or the current item of a `repeat` with `{ $item: "/path" }`. The inspector rejects a view that uses other elements, other props, actions, computed expressions, cycles, more than 128 elements, or more than 20 levels of nesting. The renderer has no tool execution or RPC handlers.

## Examples

### Fallbacks

When a view is not valid, the inspector shows the recorded tools and state instead. When capture was truncated, or a Capability recorded no inspection data, it says so.

::component-preview{name="CapabilityInspectorFallbackExample"}
::

## API reference

### AgentCapabilityInspector

#### Props

| Prop         | Type                  | Default  | Description                                       |
| ------------ | --------------------- | -------- | ------------------------------------------------- |
| `invocation` | `AgentInvocationView` | Required | The Invocation and its captured configuration.    |

The selection resets to the first Capability when `invocation.id` changes.

#### Events

| Event            | Payload      | Description                                                       |
| ---------------- | ------------ | ----------------------------------------------------------------- |
| `selectActivity` | `id: string` | The viewer selected a tool's call count. The ID is the tool's first call. |

#### Types

The inspector reads `invocation.configuration.capabilities` and `invocation.configuration.tools`:

```ts
interface CapabilityRecord {
  id: string;
  inspection?: {
    label: string;
    truncated?: boolean;
    view?: Spec; // from @json-render/core
    state?: Readonly<Record<string, AgentInspectionValue>>;
  };
  metadata?: Readonly<Record<string, AgentInspectionValue>>;
}
```

Tools match a Capability through their `capabilityId`.

## Accessibility

- The Capability buttons are in a `<nav>` named **Capabilities**. The selected button has `aria-pressed="true"`.
- Truncation notices are live status messages.

## Related

- [Tool list](/docs/ui/tool-list) renders the tool contracts inside each Capability.
- [Invocation inspector](/docs/ui/invocation-inspector) shows the rest of the configuration.
- [Capabilities](/docs/agents/capabilities) explains how Agents receive operations.
