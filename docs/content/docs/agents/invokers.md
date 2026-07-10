---
title: Invokers
description: Resolve trusted caller identity for Agent Invocations.
navigation.order: 27
icon: i-lucide-user-check
---

An Agent Invoker is the trusted caller identity for one Agent Invocation. ViteHub exposes the resolved identity as both the Agent Actor and `context.invoker`, with a stable `id`, optional `kind`, optional display `label`, optional normalized `email`, and application-owned `meta`.

Agent Invokers are not Auth Users, Channels, or Access roles. Auth and Channels may help produce an Agent Invoker, and Access may consume it, but the concepts stay separate.

## Pass an invoker from server code

Server-owned invocation surfaces can pass an Agent Invoker through invocation context after authenticating the request.

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

ViteHub trusts this value because it comes from server code. Validate request signatures, sessions, and product permissions before creating it.

## Configure profiles

Agent Invoker Profiles are static selectable invokers on an Agent Definition. They are useful for DevTools, local development, and trusted app routes that need a known profile id.

```ts [server/agents/support.ts]
import { gateway } from '@ai-sdk/gateway'
import { defineAgent, defineAgentInvoker } from '@vite-hub/agent'

export default defineAgent({
  driver: {
    model: gateway('openai/gpt-5.1-mini'),
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

A caller selects a profile with `input.context['invoker.profileId']`, `input.context.invokerProfileId`, `input.context['invoker.profile']`, or `input.context.invokerProfile`.

## Resolve and normalize

Use `invoker.resolve` when the Agent needs to normalize trusted invocation metadata before Capabilities run. The resolver can also store Agent Invocation Context Values for later callbacks.

```ts [server/agents/support.ts]
import { defineAgentInvoker } from '@vite-hub/agent'

export const supportInvoker = defineAgentInvoker({
  resolve({ context, defaultInvoker, selectedProfile }) {
    const customer = typeof defaultInvoker.meta?.customer === 'string'
      ? defaultInvoker.meta.customer.trim()
      : undefined

    context.set('support.customer', { customer }, { overwrite: true })
    return selectedProfile ?? defaultInvoker
  },
})
```

When a selected profile and a request-provided invoker both contain `meta`, ViteHub keeps request metadata and lets profile metadata override matching keys.

## Read normalized email

ViteHub exposes a valid identity email as `actor.email.address` and `actor.email.domain`. It lowercases the address, derives the domain, and omits the field when the address is malformed. This normalization does not verify that the address belongs to the actor.

A valid top-level email takes precedence over `meta.email`. ViteHub falls back to `meta.email` when the top-level value is missing or malformed, and it preserves the original metadata.

## Use invokers for access

Access decisions should use the Agent Invoker rather than channel identity. A shared channel can contain multiple users with different permissions.

```ts [server/agents/support.ts]
import { access } from '@vite-hub/agent/capabilities'

export const supportAccess = access({
  workspace: {
    resolve({ invoker }) {
      if (invoker.meta?.scope === 'all') {
        return { all: true, scope: 'support' }
      }

      const customer = String(invoker.meta?.customer ?? '')
      return {
        grants: [{ path: `customers/${customer}` }],
        scope: customer || 'public',
      }
    },
  },
})
```

Keep Access roles inside the Access Capability. Keep the caller identity on the Agent Invoker.

Capability callbacks receive the same resolved identity as `actor` and `invoker`. Access resolvers can use `actor.email?.address` or `actor.email?.domain` without parsing application metadata.

## Next steps

- Read [Channels](/docs/agents/channels) for delivery metadata.
- Read [Workspace context](/docs/agents/workspace-context) for scoped files.
- Read [Capabilities](/docs/capabilities) for `access()` and rate-limit identity behavior.
