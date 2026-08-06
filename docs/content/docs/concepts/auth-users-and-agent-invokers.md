---
title: Auth Users and Agent Invokers
description: Understand how application identity becomes trusted invocation identity.
navigation.order: 14
navigation.lanes: [agents]
icon: i-lucide-user-check
---

An Auth User is the application user identified by Auth. An Agent Invoker is the trusted caller of one Agent Invocation, exposed to Agent and Capability code as `context.invoker`.

Auth answers “who is signed in?” Agent Invoker answers “who or what started this invocation?”

## Auth can provide the invoker

Agents can also start from a Channel, schedule, webhook, service account, CLI command, or local development. Auth is optional for those entry points.

```ts [server/agents/support.ts]
import { defineAgent } from '@vite-hub/agent'
import { authenticated } from '@vite-hub/auth/agent'

export default defineAgent({
  invoker: authenticated(),
  driver: {
    run: ({ invoker }) => ({ invoker }),
  },
})
```

`authenticated()` makes the Auth-to-Invoker mapping explicit. Defining Auth does not make every Agent require a user session.

## The invoker carries trusted caller data

| Field | Meaning |
| --- | --- |
| `id` | Stable caller id for the invocation. |
| `kind` | Caller type such as `authUser`, `chat`, or `anonymous`. |
| `label` | Optional label for inspection. |
| `meta` | Structured application data used by Capabilities and callbacks. |

Keep secrets and raw session payloads out of `meta`.

Read [Auth](/docs/server-primitives/auth) for session setup and [Access](/docs/capabilities/access) for decisions based on invoker identity.
