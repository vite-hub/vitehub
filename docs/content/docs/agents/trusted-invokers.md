---
title: Trusted Invokers
description: Carry trusted caller identity into one Agent Invocation, normalize Invoker fields, and use Invokers for access decisions.
navigation.order: 33
navigation.group: History and context
icon: i-lucide-user-check
navigation.kind: Guides
---

An Agent Invoker is the trusted identity of the caller for one Invocation.
Capabilities use it for access rules, rate limits, and state partitions. The
CLI and the Console show it.

Pass an Invoker when the Agent must know who is calling. Your application
authenticates the request. The Invoker carries the result of that check into the
Agent. A Channel user or a chat user object is not an authorization decision.

Configure Invokers with `defineAgent({ invoker })`, pass one through
`context.invoker`, and read it as `invoker` in callbacks.

## Pass a trusted Invoker

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
    const [error, result] = await runAgent(support, {
      prompt,
      context: {
        invoker: {
          id: user.id,
          kind: 'customer',
          label: user.email,
          meta: { customer: user.customerId },
        },
      },
    }, { runtimeContext: runtime })
    if (error) throw error
    return { text: result.text }
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

Without an Invoker, ViteHub uses an anonymous Invoker with the id
`anonymous:<origin>`. A `chat.message` Trigger without `invoker` derives a
`chat` Invoker from its `user` field.

## Invoker fields

| Field | Required | Purpose |
| --- | --- | --- |
| `id` | Yes | Stable identity for access, limits, state, and inspection. ViteHub rejects an empty id. |
| `kind` | No | Identity family, such as `customer`, `chat`, or `anonymous`. |
| `label` | No | Readable value for logs and the CLI. |
| `email` | No | Normalized `{ address, domain }`. ViteHub omits an invalid value. |
| `meta` | No | Trusted facts your app owns. Validate them before the Invocation. |

## Configure profiles

Profiles are known Invokers for local development, Schedules, CLI use, and
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
Invocation. ViteHub does not fall back to another Invoker.

## Normalize the Invoker

Use `resolve` to clean up or reject the trusted input. It runs before
Capabilities and the Driver:

```ts [server/utils/support-invoker.ts]
import { defineAgentInvoker } from 'vite-hub/agent'

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

`defaultInvoker` is the Invoker from the input, or the anonymous Invoker.
`selectedProfile` is the profile that the input selected. Return `undefined` to
keep the default selection.

## Use Invokers for access

Invoker metadata can select a Workspace scope. Keep the authorization rule in
code, not in the model:

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

Do not let the model choose its own Invoker or access scope. Authenticate first,
normalize once, and let Capabilities use the trusted result. Read
[Access](/docs/agents/capabilities/access) for the scope options.

## API names

| Task | API |
| --- | --- |
| Configure resolution | `defineAgent({ invoker })`, `defineAgentInvoker()` |
| Direct invocation input | `input.context.invoker` |
| `chat.message` input | Top-level `invoker` |
| Read in callbacks | `invoker` |
| Read from the context store | `context.get('invoker')` |
| Public type | `AgentInvoker` |
