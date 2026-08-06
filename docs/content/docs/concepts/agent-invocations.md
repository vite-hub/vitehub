---
title: Agent Invocations
description: "Understand the one-request record that resolves Agent identity, abilities, context, execution, and output."
navigation.group: Core vocabulary
navigation.order: 11
icon: i-lucide-play-circle
---

An Agent Invocation is one runtime request to an Agent. It combines an Agent Definition with one input, one trusted caller identity, the Capabilities selected for that request, the available Workspace context, the Agent Driver, and the result.

The Agent Definition describes reusable behavior. The Agent Invocation records what ran for one request.

## What an invocation resolves

| Phase | Result |
| --- | --- |
| Entry | A route, trigger, schedule, Channel, CLI command, or Agent prepares input and run metadata. |
| Identity | ViteHub resolves the Agent Invoker and Agent Actor for the request. |
| Composition | The Definition and invocation context select the active Capabilities. |
| Context | Capabilities prepare tools, policy, context values, and Workspace Scope. |
| Execution | The Agent Driver processes the prepared input. |
| Completion | ViteHub returns or streams output and records usage, events, and trace state. |

Capability selection happens once. A Capability omitted by the resolver contributes no tools, requirements, policy, hooks, or cleanup work to that invocation.

## Keep nearby terms separate

| Term | Meaning |
| --- | --- |
| Agent Definition | Reusable declaration of what an Agent can do. |
| Agent Invocation | One execution of that declaration for one input. |
| Channel | Origin and delivery metadata around a message-shaped invocation. |
| Workflow Run | Durable orchestration that can carry an invocation across waits or process boundaries. |
| Agent Memory | Persistent context owned by a separate memory boundary, not by the invocation itself. |

One Channel can start many invocations, and one Workflow Run can carry an invocation. Neither term replaces the invocation.

## Inspect an invocation

Inspect the input, invoker, active Channel, resolved Capabilities, Workspace Scope, Agent Driver, trace, usage, and final output together. `vitehub agent info` exposes resolved Agent metadata, while `vitehub agent dev` streams a local invocation.

Read [Invocations](/docs/agents/invocations) for `runAgent()` and `streamAgent()`, or [Runtime policy, approvals, and traces](/docs/concepts/runtime-policy-approvals-and-traces) for the records produced while an invocation runs.
