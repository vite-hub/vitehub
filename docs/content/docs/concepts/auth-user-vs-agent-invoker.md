---
title: Auth User vs Agent Invoker
description: Choose the identity for application access and Agent execution.
navigation.group: Choose between
navigation.order: 42
icon: i-lucide-user-check
---

Use an Auth User for application identity and session state. Use an Agent Invoker for the trusted caller of one Agent Invocation, whether that caller is a user, Channel, schedule, webhook, service account, or local fallback.

## The same caller can have both identities

| | Auth User | Agent Invoker |
| --- | --- | --- |
| Scope | The application | One Agent Invocation |
| Source | Auth provider and session | Trusted entry surface or Auth bridge |
| Used by | Routes and application authorization | Agent and Capability code |
| Required | Only where application auth is needed | Every invocation has an invoker identity, including anonymous identities |

Use `authenticated()` when an Agent must require a verified Auth session. Defining Auth alone does not impose that requirement on every Agent.

Read [Auth Users and Agent Invokers](/docs/concepts/auth-users-and-agent-invokers) for the identity model and [Auth](/docs/server-primitives/auth) for setup.
