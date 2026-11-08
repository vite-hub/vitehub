---
title: Agent Actors
description: Pass the trusted caller into an Agent run, clean up its fields, and use it to control access.
navigation.order: 33
navigation.group: History and context
icon: i-lucide-user-check
navigation.kind: Guides
---

An Agent Actor is the trusted caller of one Invocation (one Agent run).
Capabilities use it for access rules, rate limits, and state partitions. The
CLI and the Console show it.

Pass an Actor when the Agent must know who calls. Your app authenticates the
request, and the Actor carries the result into the Agent. A Channel user or a
chat user object is not an authorization decision.

::note
The API uses the name `invoker`. Configure Actors with
`defineAgent({ invoker })` and pass one in `context.invoker`. Callbacks get
the same value as `actor` and `invoker`.
::

## Pass a trusted Actor

Authenticate first. Then pass only checked identity facts:

```ts [server/api/support.post.ts] fragment
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

ViteHub trusts this server value. Never copy unchecked request fields into
`context.invoker`. The `finally` block finishes tracked background work when
the host has no lifetime API. See
[Runtime Context](/docs/reference/runtime-context#background-work-and-cleanup).

Without an Actor, ViteHub uses an anonymous one with the id
`anonymous:<origin>`. A `chat.message` Trigger without `invoker` builds a
`chat` Actor from its `user` field.

## Actor fields

| Field | Required | Purpose |
| --- | --- | --- |
| `id` | Yes | Stable identity for access, limits, state, and inspection. ViteHub rejects an empty id. |
| `kind` | No | Identity family, such as `customer`, `chat`, or `anonymous`. |
| `label` | No | Readable value for logs and the CLI. |
| `email` | No | Normalized `{ address, domain }`. ViteHub omits an invalid value. |
| `meta` | No | Trusted facts your app owns. Validate them before the Invocation. |

## Configure profiles

Profiles are fixed Actors for local development, Schedules, the CLI, and
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

Pick a profile with `context.invokerProfileId` for a direct call, or with
top-level `invokerProfileId` for `chat.message`. An unknown id fails the
Invocation, with no fallback to another Actor.

## Normalize the Actor

Use `resolve` to clean up or reject the trusted input. It runs before
Capabilities and the Driver:

```ts [server/utils/support-actor.ts]
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

`defaultInvoker` is the input Actor or the anonymous Actor.
`selectedProfile` is the profile the input picked. Return `undefined` to keep
the default.

## Use Actors for access

Actor metadata can pick a Workspace scope. Keep the rule in code, not in the
model:

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

Never let the model choose its Actor or scope. Authenticate, normalize once,
and let Capabilities use the result. Read
[Access](/docs/agents/capabilities/access) for scope options.

## API names

| Task | API |
| --- | --- |
| Configure resolution | `defineAgent({ invoker })`, `defineAgentInvoker()` |
| Direct invocation input | `input.context.invoker` |
| `chat.message` input | Top-level `invoker` |
| Read in callbacks | `actor` or `invoker` |
| Read from the context store | `context.get('actor')` or `context.get('invoker')` |
| Public type | `AgentActor`. Invoker-named APIs also expose `AgentInvoker`. |
