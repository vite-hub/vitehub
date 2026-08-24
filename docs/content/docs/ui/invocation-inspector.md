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

The inspector keeps the outcome visible, summarizes the run, and groups the captured Agent setup below it. Sources and tools stay compact, while Capability metadata and instructions expand in place. Terminal errors appear with the exact invocation status. Identifiers remain hidden until copied.

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

Do not reconstruct configuration from the current Agent Definition. Dynamic Capabilities, instructions, Workspace bindings, Sources, driver, and runtime may have changed since the invocation ran.

Only include instruction content when the current viewer may inspect it. The component does not fetch missing configuration or authorize access.
