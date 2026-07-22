---
title: Auth Users and Agent Invokers
description: Keep application authentication separate from trusted Agent Invocation identity.
navigation.order: 10
icon: i-lucide-user-check
---

An Auth User is the application user identified by Auth. An Agent Invoker is the trusted caller identity for one Agent Invocation, exposed as `context.invoker`.

These concepts are related, but they are not the same. Auth proves application identity and session state; Agent Invoker gives Agent and Capability code a stable invocation identity.

## Why it exists

Agents may be invoked by app users, chat adapters, the CLI Dev Loop, schedules, webhooks, service accounts, or anonymous local development. Collapsing those callers into Auth User would make non-user invocations awkward and would make Auth look required for every Agent.

ViteHub provides an origin-specific anonymous fallback when no trusted identity is supplied. Apps can then opt into stricter identity where the entry surface requires it.

## Use Auth when it owns identity

The Auth Package can map a verified Auth Session and Auth User into an Agent Invoker through the authenticated helper.

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

`authenticated()` is opt-in at the Agent or Entry Surface boundary. Merely defining Auth does not make every Agent Invocation require Auth.

When a required Auth Session is missing, the bridge throws `AuthenticationRequiredError` with code `AUTHENTICATION_REQUIRED` and `statusCode: 401`, so Agent and HTTP entry surfaces can recognize the same failure without parsing its message.

When the default Better Auth session lookup fails, the bridge throws `AuthenticationProviderError` with code `AUTH_PROVIDER_OPERATION_FAILED` and safe operation details; raw provider diagnostics remain available only through `cause`. Existing Auth errors, structural `AbortError` objects, and application-owned `source` exceptions keep their identity. Malformed provider responses remain `TypeError` contract failures.

## What Agent Invoker carries

| Field | Meaning |
| --- | --- |
| `id` | Stable trusted caller id for the invocation. |
| `kind` | Caller kind such as `authUser`, `chat`, `anonymous`, or an app-specific value. |
| `label` | Optional display label for humans and inspection surfaces. |
| `meta` | Application-owned structured metadata. |

Use `meta` for facts that Access, Rate Limit, instructions, or app callbacks need to share. Do not put secrets or raw session payloads there.

## How it fits with Capabilities

The Access Capability can read `context.invoker` to admit or reject chat-origin invocations and select a Workspace Scope. Rate Limit can consume Agent Invoker identity for invocation budgets. Prompt or instruction callbacks can read the same invoker metadata without making access roles model-facing by default.

## Next steps

- Read [Auth](/docs/server-primitives/auth) for Auth setup.
- Read [Workspace and Sources](/docs/concepts/workspace-and-sources) for Workspace Scope.
- Read [Capabilities API](/docs/concepts/capabilities-api) for Access and Rate Limit boundaries.
