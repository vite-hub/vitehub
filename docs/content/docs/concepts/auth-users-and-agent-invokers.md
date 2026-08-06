---
title: Auth Users and Agent Invokers
description: Keep application authentication separate from trusted Agent Invocation identity.
navigation.group: Core vocabulary
navigation.order: 14
icon: i-lucide-user-check
---

An Auth User is the application user identified by Auth. An Agent Invoker is the trusted caller identity for one Agent Invocation, exposed as `context.invoker`.

Auth proves application identity and session state. Agent Invoker gives Agent and Capability code a stable caller identity for the current invocation.

## Auth is one source of invocation identity

Agents can also be invoked by chat adapters, schedules, webhooks, service accounts, the CLI Dev Loop, or local development. Auth must stay optional for those entry points.

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

`authenticated()` makes the Auth-to-Invoker mapping explicit. Defining Auth in an application does not make every Agent require a session.

## What the Agent Invoker carries

| Field | Meaning |
| --- | --- |
| `id` | Stable trusted caller id for the invocation. |
| `kind` | Caller type such as `authUser`, `chat`, `anonymous`, or an app-specific value. |
| `label` | Optional display label for inspection. |
| `meta` | Structured application metadata used by Capabilities and callbacks. |

Do not put secrets or raw session payloads in `meta`.

Read [Auth](/docs/server-primitives/auth) for session setup and [Access](/docs/capabilities/access) for Capability decisions based on invoker identity.
