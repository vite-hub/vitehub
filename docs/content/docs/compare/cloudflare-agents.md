---
title: ViteHub vs Cloudflare Agents SDK
description: Compare Cloudflare's Durable Object Agent architecture with ViteHub Agent Definitions and host-selected server providers.
navigation.title: Cloudflare Agents
navigation.order: 6
navigation.group: Agent frameworks
icon: i-simple-icons-cloudflare
---

Choose Cloudflare Agents when persistent, individually addressed Durable
Objects are the application's foundation. Choose ViteHub when you want Agent
Definitions and server service APIs with provider selection in Vite config.

ViteHub can deploy supported features to Cloudflare. That does not make a
ViteHub Agent the same abstraction as a Cloudflare Agents SDK instance.

## Compare identity and state

Cloudflare Agents builds on Durable Objects. An instance owns persistent
state and lifecycle behavior. The SDK includes SQLite storage, WebSockets,
scheduling, MCP, and Workflow integration.

ViteHub declares Agents in files. Drivers run invocations, Capabilities grant
operations, and configured stores supply state. Storage lifetime and execution
lifetime depend on those choices. A Definition alone does not provide a
persistent process or durable per-user actor.

For a live room or per-user service with long-lived connections and object
identity, Cloudflare's model can match the design directly. For a Vite app
that needs Agent tools plus server storage across supported hosts, evaluate
ViteHub's separate services.

## Compare host commitments

Cloudflare Agents deliberately uses Cloudflare's runtime architecture. This
can be useful when the app wants Durable Objects rather than a host-neutral
abstraction.

ViteHub keeps supported application imports stable when the provider changes.
The services still have different quotas, consistency, and runtime limits.
Changing a preset does not move object state or make every feature available
on every host. Consult the
[support matrix](/docs/frameworks-hosts/support-matrix).

## Verify the application model

Test the behavior that depends on identity: two concurrent callers, a process
restart, and a reconnect. Confirm where the state lives and who can access it.
For ViteHub, also test the selected provider's persistence contract.

Sources checked on 29 October 2026:
[Cloudflare Agents documentation](https://developers.cloudflare.com/agents/)
and [SDK repository](https://github.com/cloudflare/agents).
Read [ViteHub Agent Definitions](/docs/agents/agent-definitions) and
[Cloudflare output](/docs/frameworks-hosts/cloudflare) for its integration.
