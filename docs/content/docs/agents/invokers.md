---
title: Auth Users and Agent Invokers
navigation.title: Auth Users and Agent Invokers
description: Learn how a signed-in user becomes the trusted caller of an Agent run.
navigation.order: 32
navigation.group: History and context
icon: i-lucide-user-check
navigation.kind: Concepts
---

An Auth User is the person signed in to your app. An Agent Invoker is the trusted caller who started one Agent Invocation (one run of an Agent). Agent and Capability code read it from `context.invoker`.

## Choose the identity you need

| | Auth User | Agent Invoker |
| --- | --- | --- |
| Scope | The application session | One Agent Invocation |
| Source | An auth provider | A trusted entry point or Auth bridge |
| Used by | Routes and application authorization | Agent and Capability code |
| Required | Only where the application requires auth | Every invocation, including anonymous calls |

## Auth can provide the invoker

A Channel, schedule, webhook, service account, CLI command, or local development can also start an Agent. These need no Auth User, but still give an invoker.

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

`authenticated()` makes the signed-in user the Agent Invoker. Auth alone does not make every Agent require a user session.

## The invoker carries trusted caller data

| Field | Meaning |
| --- | --- |
| `id` | Stable caller ID. |
| `kind` | Caller type such as `authUser`, `chat`, or `anonymous`. |
| `label` | Optional label shown in inspection. |
| `meta` | App data for Capabilities and callbacks. |

Do not put secrets or raw session payloads in `meta`.

Read [Auth](/docs/auth) to set up sessions and [Access](/docs/agents/capabilities/access) to allow or deny by invoker.
