---
title: Agent Actors
description: Carry trusted caller identity into one Agent Invocation.
navigation.order: 42
navigation.group: Connect
icon: i-lucide-user-check
---

An Agent Actor is the trusted identity of the caller for one Invocation.
Capabilities use it for access rules, rate limits, and state partitions. The
CLI and the Console show it when you inspect an Invocation.

Pass an Actor when the Agent must know who is calling. Your application
authenticates the request. The Actor carries the result of that check into the
Agent. A Channel user or a chat user object is not an authorization decision.

::note
The public API keeps the name `invoker`. Configure Actors with
`defineAgent({ invoker })` and pass one through `context.invoker`. Callbacks
receive the same value as `actor` and `invoker`.
::

## Pass a trusted Actor

Authenticate first. Then pass only validated identity facts:

```ts [server/api/support.post.ts]
import { runAgent } from 'vite-hub/agent'
import { getRuntimeContext } from 'vite-hub/runtime/h3'
import support from '../agents/support'

export default defineEventHandler(async (event) => {
  const user = await requireAuthenticatedUser(event)
  const { prompt } = await readBody<{ prompt: string }>(event)

  const runtime = getRuntimeContext(event)
  try {
    return await runAgent(support, runtime, {
      prompt,
      context: {
        invoker: {
          id: user.id,
          kind: 'customer',
          label: user.email,
          meta: { customer: user.customerId },
        },
      },
    })
  }
  finally {
    await runtime.flushWaitUntil().catch(console.error)
  }
})
```

ViteHub trusts this server-owned value. Never copy unverified request fields
into `context.invoker`. The `finally` block drains tracked background work
when the host has no lifetime API. See
[Runtime Context](/docs/reference/runtime-context#background-work-and-cleanup).

Without an Actor, ViteHub uses an anonymous Actor with the id
`anonymous:<origin>`. A `chat.message` Trigger without `invoker` derives a
`chat` Actor from its `user` field.

## Actor fields

| Field | Required | Purpose |
| --- | --- | --- |
| `id` | Yes | Stable identity for access, limits, state, and inspection. ViteHub rejects an empty id. |
| `kind` | No | Identity family, such as `customer`, `chat`, or `anonymous`. |
| `label` | No | Human-readable value for logs and CLI inspection. |
| `email` | No | Normalized `{ address, domain }`. ViteHub omits an invalid value. |
| `meta` | No | Trusted facts that your application owns. Validate them before the Invocation. |

## Configure profiles

Profiles are known Actors for local development, Schedules, CLI use, and
trusted routes:

```ts [server/agents/support.ts]
import { defineAgent, defineAgentInvoker } from 'vite-hub/agent'

export default defineAgent({
  invoker: defineAgentInvoker({
    profiles: [
      {
        id: 'portal-acme',
        kind: 'customer',
        label: 'Acme Portal',
        meta: { customer: 'acme' },
      },
      {
        id: 'support-admin',
        kind: 'support',
        label: 'Support Admin',
        meta: { scope: 'all' },
      },
    ],
  }),
  driver: { model: 'openai/gpt-5.1-mini' },
})
```

Select a profile with `context.invokerProfileId` for a direct call, or with
top-level `invokerProfileId` for `chat.message`. An unknown id fails the
Invocation. ViteHub does not fall back to another Actor.

## Normalize the Actor

Use `resolve` to normalize or reject the trusted input. ViteHub calls it
before Capabilities and the Driver run:

```ts [server/agents/support-actor.ts]
import { defineAgentInvoker } from 'vite-hub/agent'

export const supportActor = defineAgentInvoker({
  resolve({ context, defaultInvoker, selectedProfile }) {
    const customer = typeof defaultInvoker.meta?.customer === 'string'
      ? defaultInvoker.meta.customer.trim()
      : undefined

    context.set('support.customer', { customer }, { overwrite: true })
    return selectedProfile ?? defaultInvoker
  },
})
```

`defaultInvoker` is the Actor from the input, or the anonymous Actor.
`selectedProfile` is the profile that the input selected. Return `undefined` to
keep the default selection.

## Use Actors for access

Actor metadata can select a Workspace scope. Keep the authorization rule in
code, not in the model:

```ts [server/agents/support.ts]
import { defineAgent } from 'vite-hub/agent'
import { access } from 'vite-hub/agent/capabilities'

export default defineAgent({
  capabilities: [
    access({
      workspace: {
        resolve({ actor }) {
          return actor.meta?.customer === 'acme' ? 'acme' : 'public'
        },
        scopes: {
          public: { paths: ['public'] },
          acme: { paths: ['customers/acme'] },
        },
      },
    }),
  ],
  driver: { model: 'openai/gpt-5.1-mini' },
  workspace: 'product-docs',
})
```

Do not let the model choose its own Actor or access scope. Authenticate first,
normalize once, and let Capabilities use the trusted result. Read
[Access](/docs/agents/capabilities/access) for the scope options.

## API names

| Task | API |
| --- | --- |
| Configure resolution | `defineAgent({ invoker })`, `defineAgentInvoker()` |
| Direct invocation input | `input.context.invoker` |
| `chat.message` input | Top-level `invoker` |
| Read in callbacks | `actor` or `invoker` |
| Read from the context store | `context.get('actor')` or `context.get('invoker')` |
| Public type | `AgentActor`. Invoker-named APIs also expose `AgentInvoker`. |
