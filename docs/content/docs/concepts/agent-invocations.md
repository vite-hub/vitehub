---
title: Agent Invocations
description: Understand what ViteHub resolves and records for one Agent request.
navigation.order: 11
navigation.lanes: [agents]
icon: i-lucide-play-circle
---

An Agent Invocation is one request to run an Agent. It carries the input, trusted caller, selected Capabilities, available context, Agent Driver, and result for that request.

An Agent Definition describes reusable behavior. An Invocation records one execution of that behavior.

## One invocation resolves the request

| Stage | What ViteHub resolves |
| --- | --- |
| Entry | A route, Channel, schedule, webhook, CLI command, or another caller provides input. |
| Identity | ViteHub resolves the trusted Agent Invoker and Actor. |
| Capabilities | The Definition and invocation context select the abilities for this request. |
| Context | Capabilities receive tools, policy, context values, and Workspace Scope. |
| Execution | The Agent Driver processes the prepared request. |
| Result | ViteHub returns or streams output and records events and usage. |

The resolved Capability list is the complete list for that invocation. A Capability that is not selected contributes no tools, requirements, policy, hooks, or cleanup work.

## Keep the request separate from nearby records

| Term | Describes |
| --- | --- |
| Agent Definition | Reusable Agent behavior. |
| Agent Invocation | One execution for one input. |
| Channel | Message origin and delivery facts around an invocation. |
| Workflow Run | Durable work that can continue across waits or process boundaries. |
| Agent Memory | Persistent context stored by a separate memory feature. |

A Channel can start many Invocations, and a Workflow Run can carry an Invocation. Neither one replaces the request record.

## Inspect an invocation

Inspect the input, invoker, Channel, Capabilities, Workspace Scope, Driver, events, usage, and final output together. Use `vitehub agent info` for resolved Agent metadata and `vitehub agent dev` to stream a local invocation.

Read [Invocations](/docs/agents/invocations) for `runAgent()` and `streamAgent()`, or [Runtime policy, approvals, and traces](/docs/concepts/runtime-policy-approvals-and-traces) for the records produced during execution.
