---
title: Invocations and traces
description: Present a persisted Agent Invocation as an inspectable coding session.
navigation.order: 31
navigation.group: Agent work
icon: i-ph-activity-light
---

`AgentInvocation` accepts the structural shape of ViteHub's `AgentInvocationRecord`. It turns append-only observations into a coding-session thread: assistant prose stays unlabelled, user input remains visually distinct, commands and file changes expand in place, and usage snapshots show token counts instead of repeating timestamps.

```vue
<AgentInvocation :invocation="record">
  <template #title="{ invocation }">
    {{ invocation.title || invocation.agentName }}
  </template>
  <template #metadata="{ invocation }">
    <DeploymentMetadata :invocation="invocation" />
  </template>
</AgentInvocation>
```

The component displays pending, running, completed, failed, and cancelled states, terminal errors, conversation messages, reasoning, commands, product actions, approvals, file changes, and usage snapshots. The optional `configuration` field populates the inspector with the resolved Agent Definition, driver, model, runtime, Capabilities, tools, Workspace, Sources, and instruction document.

The renderer does not own session navigation. Put it beside the application's session list so the left rail can remain visible while people move between invocations.

## Inspection configuration

Pass the sanitized configuration captured for that invocation. Do not reconstruct it from the current Agent Definition because dynamic Capabilities, instructions, Workspace bindings, and Sources may differ between runs.

```ts
const invocation = {
  ...record,
  configuration: {
    agent: { name: "review", version: "1.0.0" },
    capabilities: [{ id: "workspace-shell" }],
    driver: { kind: "provider", provider: "t3" },
    instructions: [resolvedInstructions],
    runtime: { name: "node" },
    tools: [{ name: "exec" }],
    workspace: { mode: "write", name: "review", sources: ["repository"] },
  },
}
```

Only include instruction content when the application has explicitly authorized that inspection data for the current viewer.

## Trace only

Use `AgentTrace` when the application already called `deriveTraceRuns()`:

```vue
<AgentTrace v-for="run in runs" :key="run.id" :run="run" />
```

## Data ownership

ViteHub defines invocation and trace records, but the application owns loading, polling, realtime updates, pagination, and authorization. Renderers receive already-authorized data and do not fetch records themselves.
