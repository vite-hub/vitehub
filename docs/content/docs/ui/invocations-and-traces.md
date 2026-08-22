---
title: Invocations and traces
description: Present a persisted Agent Invocation as an inspectable coding session.
navigation.order: 31
navigation.group: Agent work
icon: i-ph-activity-light
---

`AgentInvocation` accepts the structural shape of ViteHub's `AgentInvocationRecord`. It turns append-only observations into a coding-session thread: assistant prose stays unlabelled, user input remains visually distinct, and compact tool rows expand in place. `AgentInvocationInspector` presents the invocation metadata separately so the host can put it in a splitter, drawer, or its own route.

Rich session replay requires a trace log created with `{ content: "full" }`. The default metadata-only trace policy records activity milestones but strips prompts, message text, tool input, and tool output. Agent Invocation journals still bound full-content records to 512 characters per string, 32 collection items, four nesting levels, and 256 observations per invocation.

```vue
<AgentInvocation :invocation="record" />

<AgentInvocationInspector :invocation="record">
  <template #metadata="{ invocation }">
    <DeploymentMetadata :invocation="invocation" />
  </template>
</AgentInvocationInspector>
```

The components display pending, running, completed, failed, and cancelled states, terminal errors, conversation messages, reasoning, commands, product actions, approvals, file changes, and usage snapshots. The optional `configuration` field populates the inspector with the resolved Agent Definition, driver, model, runtime, Capabilities, tools, Workspace, Sources, and instruction document.

The renderers do not own session navigation or panel state. Put the thread beside the application's session list and compose the inspector with the host framework's responsive panel primitives.

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
