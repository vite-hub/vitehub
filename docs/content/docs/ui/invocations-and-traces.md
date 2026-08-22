---
title: Invocations and Traces
description: Present persisted Agent Invocation status and derived runtime trace runs.
navigation.order: 31
navigation.group: Agent work
icon: i-ph-activity-light
---

`AgentInvocation` accepts the structural shape of ViteHub's `AgentInvocationRecord`. This avoids a client dependency on the complete Agent runtime while preserving the server contract.

```vue
<AgentInvocation :invocation="record">
  <template #title="{ invocation }">
    {{ invocation.agentName }} · {{ invocation.createdAt }}
  </template>
  <template #step="{ step }">
    <TraceStep :step="step" />
  </template>
</AgentInvocation>
```

The component displays pending, running, completed, failed, and cancelled states; a terminal error; and every trace run derived from `record.observations`.

## Trace only

Use `AgentTrace` when the application already called `deriveTraceRuns()`:

```vue
<AgentTrace v-for="run in runs" :key="run.id" :run="run" />
```

## Data ownership

ViteHub defines invocation and trace records, but the application owns loading, polling, realtime updates, pagination, and authorization. Renderers receive already-authorized data and do not fetch records themselves.
