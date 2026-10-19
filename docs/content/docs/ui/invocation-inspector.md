---
title: Invocation Inspector
description: "Inspect the outcome, run summary, Agent setup, Capabilities, tools, and identifiers of one Invocation."
navigation.order: 32
navigation.group: Agent work
icon: i-ph-sidebar-simple-light
---

`AgentInvocationInspector` presents the configuration captured for one Agent Invocation. It shows the outcome first, then a run summary, a timeline, and the captured Agent setup. Its narrow layout fits a splitter, a drawer, or a details panel next to [`AgentInvocation`](/docs/ui/invocation).

::component-preview{name="InvocationInspectorExample"}
::

## Usage

```vue
<AgentInvocationInspector :invocation="record" @select-activity="selectedActivityId = $event">
  <template #actions="{ invocation }">
    <UButton icon="i-lucide-x" aria-label="Close details" @click="close(invocation.id)" />
  </template>
</AgentInvocationInspector>
```

## What it shows

- **Outcome:** the status, the total time, the title, the context, and the Agent name and version. A terminal error appears here.
- **Run summary:** messages, steps, tool calls, total time, file changes, tokens, and cost. Token partitions appear when `usage` has them.
- **Timeline:** the timed steps of the run, rendered by [`AgentInvocationTimeline`](/docs/ui/timeline). Select one to emit `selectActivity`.
- **Agent setup:** the model, runtime, Workspace, Sources, Channels, Capabilities, tools, and instructions. Capability metadata and instructions expand in place.
- **Identifiers:** copy buttons for the trace ID and the Invocation ID.

The model row shows the model maker's mark, for example Anthropic for `anthropic/claude-sonnet-4.5`, and the provider under it, for example OpenRouter. The marks come from [Lobe Icons](https://github.com/lobehub/lobe-icons) under the MIT license. Unknown makers and providers use a generic chip.

Each used tool shows its call count. Select the count to emit `selectActivity` with the tool's first call. Pass that ID to `AgentInvocation`'s `selectedActivityId` to open the work group and scroll to the call.

## Examples

### Failed run

The error appears in the outcome section with the Invocation status.

::component-preview{name="InvocationInspectorFailedExample"}
::

### Compact panel

Set `:show-timeline="false"` to hide the timeline. Set `show-capabilities` to include the grouped Capability summary. Use the `actions` slot for a close button and `metadata` for your own section.

::component-preview{name="InvocationInspectorCompactExample" reset}
::

The default keeps all recorded tool contracts in the inspector. Use the separate [Capability inspector](/docs/ui/capability-inspector) for Capability details, as in the Console. Set `showCapabilities` to `true` to embed them in a standalone inspector.

## Captured configuration

Pass the sanitized configuration stored with the Invocation:

```ts
const invocation = {
  ...record,
  configuration: {
    agent: { name: "review", version: "1.0.0" },
    capabilities: [{ id: "workspace-shell" }],
    driver: { kind: "provider", provider: "codex" },
    instructions: [resolvedInstructions],
    runtime: { name: "node" },
    tools: [{ name: "exec_command", label: "Ran command", icon: "i-lucide-terminal" }],
    workspace: { mode: "write", name: "review", sources: ["repository"] },
  },
};
```

A tool entry can have a `label` and an `icon` from the tool's `title` and `icon`. The tool list and the session's tool calls use them. `createViteHubUI()` registers Nuxt UI's `UIcon` to render the icon. Without `UIcon`, the built-in icons stay.

Do not rebuild configuration from the current Agent Definition. Dynamic Capabilities, instructions, Workspace bindings, Sources, the driver, and the runtime can change after the run.

Include instruction content only when the current viewer may inspect it. The component does not fetch missing configuration or authorize access.

## API reference

### AgentInvocationInspector

#### Props

| Prop               | Type                  | Default  | Description                                           |
| ------------------ | --------------------- | -------- | ----------------------------------------------------- |
| `invocation`       | `AgentInvocationView` | Required | The Invocation and its captured configuration.        |
| `showStatus`       | `boolean`             | `true`   | Shows the status row in the outcome section.          |
| `showError`        | `boolean`             | `true`   | Shows the terminal error in the outcome section.      |
| `showTimeline`     | `boolean`             | `true`   | Shows the run timeline.                               |
| `showCapabilities` | `boolean`             | `false`  | Shows the embedded Capability summary.                |

#### Events

| Event            | Payload       | Description                                                    |
| ---------------- | ------------- | -------------------------------------------------------------- |
| `selectActivity` | `id: string`  | The viewer selected a timeline entry or a tool's call count.   |

#### Slots

| Slot              | Scope            | Description                                      |
| ----------------- | ---------------- | ------------------------------------------------ |
| `actions`         | `{ invocation }` | Controls in the panel header, for example Close. |
| `identityActions` | `{ invocation }` | Controls next to the Invocation title.           |
| `metadata`        | `{ invocation }` | A section before the identifiers.                |

## Accessibility

- The panel is an `<aside>` named **Session details**.
- The status row is a polite live region, so status changes are announced.
- Copy buttons announce **Trace ID copied**, **Invocation ID copied**, or a failure.

## Related

- [Invocation](/docs/ui/invocation) renders the thread that `selectActivity` points to.
- [Timeline](/docs/ui/timeline) is the embedded step list.
- [Capability inspector](/docs/ui/capability-inspector) shows Capability views in a separate panel.
- [Tool list](/docs/ui/tool-list) renders the tool contracts.
