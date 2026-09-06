---
title: Auth Users and Agent Invokers
description: Understand how application identity becomes trusted invocation identity.
navigation.order: 14
navigation.group: Application model
navigation.lanes: [agents]
icon: i-lucide-user-check
---

An Auth User is the person signed in to your application. An Agent Invoker is the trusted caller of one Agent Invocation. Agent and Capability code read that caller from `context.invoker`.

Auth answers "who is signed in?" An Agent Invoker answers "who or what started this invocation?"

## Choose the identity you need

| | Auth User | Agent Invoker |
| --- | --- | --- |
| Scope | The application session | One Agent Invocation |
| Source | An auth provider | A trusted entry point or Auth bridge |
| Used by | Routes and application authorization | Agent and Capability code |
| Required | Only where the application requires auth | Every invocation, including anonymous calls |

## Auth can provide the invoker

An Agent can also start from a Channel, schedule, webhook, service account, CLI command, or local development. Those entry points don't need an Auth User, but they still provide an Agent Invoker.

```ts [server/agents/support.ts]
import { defineAgent } from 'vite-hub/agent'
import { authenticated } from 'vite-hub/auth/agent'

export default defineAgent({
  invoker: authenticated(),
  driver: {
    run: ({ invoker }) => ({ invoker }),
  },
})
```

`authenticated()` maps the signed-in user to the Agent Invoker. Configuring Auth alone does not require a user session for every Agent.

## The invoker carries trusted caller data

| Field | Meaning |
| --- | --- |
| `id` | Stable caller ID for the invocation. |
| `kind` | Caller type such as `authUser`, `chat`, or `anonymous`. |
| `label` | Optional label for inspection. |
| `meta` | Structured application data used by Capabilities and callbacks. |

Don't put secrets or raw session payloads in `meta`.

Read [Auth](/docs/server-primitives/auth) for session setup and [Access](/docs/capabilities/access) for decisions based on invoker identity.
