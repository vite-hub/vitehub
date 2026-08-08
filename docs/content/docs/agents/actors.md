---
title: Agent Actors
description: Carry trusted caller identity into one Agent Invocation while using the current invoker-named API fields.
navigation.order: 27
icon: i-lucide-user-check
---

An Agent Actor is the trusted caller identity for one Agent Invocation. It carries a stable `id`, optional `kind`, optional display `label`, normalized `email`, and application-owned `meta`.

Agent Actors are not Auth Users, Channels, or Access roles. Auth and Channels can establish an Actor, and Access can use it, but each boundary keeps its own responsibility.

## Use the current API names

The public concept is Agent Actor. The current configuration and invocation fields retain their `invoker` names.

| Purpose | Current API |
| --- | --- |
| Configure profiles and resolution | `defineAgent({ invoker })` and `defineAgentInvoker()` |
| Pass a trusted Actor to `runAgent()` or `streamAgent()` | `input.context.invoker` |
| Pass a trusted Actor to `chat.message` | top-level `invoker` trigger input |
| Select a profile for a direct invocation | `input.context.invokerProfileId` |
| Select a profile for `chat.message` | top-level `invokerProfileId` trigger input |
| Read the resolved Actor in callbacks | `actor` or `invoker` |
| Read the resolved Actor from the context store | `context.get('actor')` or `context.get('invoker')` |
| Type the public concept | `AgentActor`; `AgentInvoker` remains the type used by invoker-named APIs |

Both callback properties and both context-store keys contain the same normalized Actor. Use `actor` in domain-facing callback code and keep the exact `invoker` spelling at configuration and invocation boundaries.

## Actor fields

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `id` | `string` | Yes | Stable identity used by Access, rate limits, state partitioning, and inspection. Empty ids are rejected. |
| `kind` | `string` | No | Identity family such as `anonymous`, `chat`, `customer`, or an app-owned value. |
| `label` | `string` | No | Human-readable display value for CLI inspection and logs. |
| `email` | `{ address, domain }` | No | Normalized lowercase email output. ViteHub derives `domain` from the address and omits invalid email values. |
| `meta` | `Record<string, unknown>` | No | Application-owned trusted facts. Validate them before invocation. |

## Pass an Actor from server code

Server-owned invocation surfaces can pass an Agent Actor after authenticating the request. The current trusted input key is `context.invoker`.

```ts [server/api/support.post.ts]
import { runAgent } from '@vite-hub/agent'
import support from '../agents/support'

export default defineEventHandler(async (event) => {
  const body = await readBody<{ prompt: string }>(event)
  const user = await requireAuthenticatedUser(event)

  return runAgent(support, { runtime: 'unknown' }, {
    prompt: body.prompt,
    context: {
      invoker: {
        id: user.id,
        kind: 'customer',
        label: user.email,
        meta: { customer: user.customer },
      },
    },
  })
})
```

ViteHub trusts this value because it comes from server code. Validate signatures, sessions, and product permissions before creating it.

When no Actor is supplied, ViteHub creates an anonymous fallback Actor from Agent Run metadata.

## Configure Actor profiles

Profiles are static selectable Actors on an Agent Definition. They are useful for CLI inspection, local development, schedules, and trusted app routes that need a known profile id.

```ts [server/agents/support.ts]
import { defineAgent, defineAgentInvoker } from '@vite-hub/agent'

export default defineAgent({
  driver: {
    model: 'openai/gpt-5.1-mini',
    instructions: 'Answer support requests.',
  },
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
})
```

Select one profile with `input.context.invokerProfileId`. The `chat.message` trigger accepts the same selector as top-level `invokerProfileId`. Unknown profile ids fail the invocation instead of falling back silently.

```ts
await runAgent(support, runtime, {
  context: { invokerProfileId: 'support-admin' },
  prompt: 'Summarize open incidents.',
})
```

| `invoker` option | Type | Description |
| --- | --- | --- |
| `profiles` | `readonly AgentInvokerProfile[]` | Declares an ordered list of unique Actor profiles. |
| `resolve` | callback | Normalizes, replaces, or rejects the selected Actor before Capabilities run. Returning `null` or `undefined` keeps the selected or fallback Actor. |

## Resolve and normalize an Actor

Use `invoker.resolve` when an Agent needs to normalize trusted invocation metadata before Capabilities run. The resolver can also store typed Agent Invocation Context Values for later callbacks.

```ts [server/agents/support.ts]
import { defineAgentInvoker } from '@vite-hub/agent'

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

| Resolver value | Description |
| --- | --- |
| `defaultInvoker` | Trusted input Actor, or the fallback Actor when the input omitted one. |
| `selectedProfile` | Profile selected by `invokerProfileId`, when present. |
| `profiles` | All configured profiles for this Definition. |
| `input` | Full Agent Invocation input. |
| `context` | Mutable Agent Invocation Context Store. |
| `run` | Optional origin, channel, thread, message, schedule, and run metadata. |

When a selected profile and an input Actor both contain `meta`, ViteHub keeps input metadata and lets profile metadata override matching keys. A profile email takes precedence over the input email.

## Use Actors for access

Access decisions should use the Agent Actor rather than Channel identity. A shared Channel can contain multiple users with different permissions.

```ts [server/agents/support.ts]
import { access } from '@vite-hub/agent/capabilities'

export const supportAccess = access({
  workspace: {
    resolve({ actor }) {
      if (actor.meta?.scope === 'all') {
        return { all: true, scope: 'support' }
      }

      const customer = String(actor.meta?.customer ?? '')
      return {
        grants: [{ path: `customers/${customer}` }],
        scope: customer || 'public',
      }
    },
  },
})
```

Keep Access roles inside the Access Capability and caller identity on the Agent Actor. A normalized Actor email is available as `actor.email?.address` and `actor.email?.domain`; normalization does not verify ownership of the address.

## Next steps

- Read [Channels](/docs/agents/channels) for origin and delivery metadata.
- Read [Invocations](/docs/agents/invocations) for trusted input and lifecycle behavior.
- Read [Capabilities](/docs/capabilities) for Access and rate-limit policy.
