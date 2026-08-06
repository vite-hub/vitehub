---
title: Auth User vs Agent Invoker
description: Choose the right identity when an application user starts an Agent Invocation.
navigation.group: Choose between
navigation.order: 42
icon: i-lucide-user-check
---

Use an Auth User to represent application identity and session state. Use an Agent Invoker to represent the trusted caller of one Agent Invocation, whether that caller is a user, chat adapter, schedule, webhook, service account, or local fallback.

## The distinction

| | Auth User | Agent Invoker |
| --- | --- | --- |
| Scope | Application authentication | One Agent Invocation |
| Source | Auth provider and session | Trusted entry surface or Auth bridge |
| Used by | Routes and application authorization | Agent and Capability code |
| Required for every Agent | No | Every invocation has an invoker identity, including anonymous identities |

`authenticated()` is the explicit bridge when an Agent should require a verified Auth session. Defining Auth alone does not impose that requirement on every Agent.

Read [Auth Users and Agent Invokers](/docs/concepts/auth-users-and-agent-invokers) for the full identity model and [Auth](/docs/server-primitives/auth) for setup.
