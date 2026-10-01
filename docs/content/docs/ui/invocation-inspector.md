---
title: Invocation Inspector
description: Inspect the resolved Agent, runtime, Workspace, Capabilities, tools, and identifiers for one invocation.
navigation.order: 32
navigation.group: Agent work
icon: i-ph-sidebar-simple-light
---

`AgentInvocationInspector` presents the configuration captured for one Agent Invocation. Its narrow layout works in a splitter, drawer, or standalone details panel.

::component-preview{name="InvocationInspectorExample"}
::

## Usage

```vue
<AgentInvocationInspector :invocation="record">
  <template #actions="{ invocation }">
    <UButton icon="i-lucide-x" aria-label="Close details" @click="close(invocation.id)" />
  </template>

  <template #metadata="{ invocation }">
    <DeploymentMetadata :invocation="invocation" />
  </template>
</AgentInvocationInspector>
```

The inspector keeps the outcome visible, summarizes the run, and groups the captured Agent setup below it. The run summary counts messages, steps, and tool calls, and shows the total time. Sources and tools stay compact, while Capability metadata and instructions expand in place. Terminal errors appear with the exact invocation status. Identifiers remain hidden until copied.

The model row shows the model maker's mark, for example Anthropic for `anthropic/claude-sonnet-4.5`, and the provider below it, for example OpenRouter. The marks come from [Lobe Icons](https://github.com/lobehub/lobe-icons) under the MIT license. Unknown makers and providers use a generic chip.

Each used tool shows its call count. Select the count to emit `selectActivity` with the tool's first call. Pass that id to `AgentInvocation`'s `selectedActivityId` to open the work group and scroll to the call. `AgentCapabilityInspector` emits the same event.

## Captured configuration

Pass the sanitized configuration stored with the invocation:

```ts
const invocation = {
  ...record,
  configuration: {
    agent: { name: "review", version: "1.0.0" },
    capabilities: [{ id: "workspace-shell" }],
    driver: { kind: "provider", provider: "codex" },
    instructions: [resolvedInstructions],
    runtime: { name: "node" },
    tools: [{ name: "exec_command" }],
    workspace: { mode: "write", name: "review", sources: ["repository"] },
  },
};
```

A tool entry can include `label` and `icon` from the tool's declared `title` and `icon`. The tool list and the session's tool calls use them. `createViteHubUI()` registers Nuxt UI's `UIcon` to render the icon; without `UIcon`, they keep the built-in icons.

Do not reconstruct configuration from the current Agent Definition. Dynamic Capabilities, instructions, Workspace bindings, Sources, driver, and runtime may have changed since the invocation ran.

Only include instruction content when the current viewer may inspect it. The component does not fetch missing configuration or authorize access.
