---
title: Session
description: Present an application-owned chat session with the same AI SDK message contract.
navigation.order: 16
navigation.group: Chat
icon: i-ph-chats-circle-light
---

AI SDK defines UI messages and chat state, but it does not impose a persistence schema for sessions. `ViteHubUISession` therefore stays deliberately small: an ID, messages, optional title and timestamps, and application metadata.

::component-preview{name="SessionExample" flush}
::

```ts
const session: ViteHubUISession = {
  id: "session_01",
  title: "Production deploy failure",
  messages,
  metadata: { projectId: "project_01" },
};
```

Render it with `AgentSession`:

```vue
<AgentSession :session :status>
  <template #header="{ session }">
    <SessionHeader :session />
  </template>
  <template #message="{ message }">
    <AgentChatMessage :message />
  </template>
</AgentSession>
```

The component adds session structure around `AgentChat`; it does not fetch, mutate, or persist the record. Applications can extend the session type and retain full control of tenancy and authorization.
