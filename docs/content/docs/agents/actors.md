---
title: Agent Actors
description: Carry trusted caller identity into one Agent Invocation.
navigation.order: 42
navigation.group: Connect
icon: i-lucide-user-check
---

An Agent Actor is the trusted caller identity for one invocation. It can drive access, rate limits, state partitioning, and inspection without turning a Channel or chat user object into an authorization decision.

The current public fields retain the name `invoker`: configure Actors with `defineAgent({ invoker })`, pass one through `context.invoker`, and read the normalized Actor as `actor` or `invoker` in callbacks.

## Pass a trusted Actor

Authenticate at the application boundary, then pass only validated identity facts.

```ts [server/api/support.post.ts]
import { runAgent } from 'vite-hub/agent'
import support from '../agents/support'
import { getRuntimeContext } from '../runtime-context'

export default defineEventHandler(async (event) => {
  const user = await requireAuthenticatedUser(event)
  const { prompt } = await readBody<{ prompt: string }>(event)

  return runAgent(support, getRuntimeContext(event), {
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
})
```

ViteHub trusts this server-owned value. Never copy unverified request fields into `context.invoker`.

## Actor fields

| Field | Required | Purpose |
| --- | --- | --- |
| `id` | Yes | Stable identity for access, limits, state, and inspection. Empty ids are rejected. |
| `kind` | No | Identity family such as `customer`, `chat`, or `anonymous`. |
| `label` | No | Human-readable value for logs and CLI inspection. |
| `email` | No | Normalized `{ address, domain }`; invalid values are omitted. |
| `meta` | No | Application-owned trusted facts. Validate them before invocation. |

## Configure profiles

Profiles provide known Actors for local development, schedules, CLI use, and trusted routes.

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

Select a profile with `context.invokerProfileId` for direct invocation or top-level `invokerProfileId` for `chat.message`. Unknown ids fail instead of falling back silently.

Use `invoker.resolve` to normalize or reject the trusted input before Capabilities run:

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

Resolution happens before Capabilities and the Driver run.

## Use Actors for access

Actor metadata can select a Workspace Scope, but authorization must remain deterministic.

```ts [server/agents/support.ts]
import { defineAgent } from 'vite-hub/agent'
import { access } from 'vite-hub/agent/capabilities'

export default defineAgent({
  capabilities: [
    access({
      workspace: {
        resolve({ invoker }) {
          return invoker.meta?.customer === 'acme' ? 'acme' : 'public'
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

Do not ask the model to decide its own Actor or access scope. Authenticate first, normalize once, and let Capabilities consume the trusted result.

## Current API names

| Task | API |
| --- | --- |
| Configure resolution | `defineAgent({ invoker })`, `defineAgentInvoker()` |
| Direct invocation input | `input.context.invoker` |
| `chat.message` input | top-level `invoker` |
| Read in callbacks | `actor` or `invoker` |
| Read from context store | `context.get('actor')` or `context.get('invoker')` |
| Public type | `AgentActor`; invoker-named APIs also expose `AgentInvoker` |
