---
title: Agent Invocations
description: Understand what ViteHub resolves and records for one Agent request.
navigation.order: 11
navigation.lanes: [agents]
icon: i-lucide-play-circle
---

An Agent Invocation is one request to run an Agent. It includes the input, trusted caller, selected Capabilities, available context, execution method, and result.

An Agent Definition describes reusable behavior. An Invocation records one execution of that behavior.

## What happens during an Invocation

| Stage | What happens |
| --- | --- |
| Entry | A route, Channel, schedule, webhook, CLI command, or another caller provides input. |
| Identity | ViteHub identifies the trusted Agent Invoker and Actor. |
| Capabilities | The Definition and invocation context select the abilities available to this request. |
| Context | ViteHub prepares tools, policy, context values, and Workspace Scope. |
| Execution | The Agent Driver processes the prepared request. |
| Result | ViteHub returns or streams output and records events and usage. |

The Agent can use only the Capabilities selected for that Invocation. A Capability that isn't selected contributes nothing to the request.

## Don't confuse an Invocation with related records

| Term | Describes |
| --- | --- |
| Agent Definition | Reusable Agent behavior. |
| Agent Invocation | One execution for one input. |
| Channel | Message origin and delivery facts around an invocation. |
| Workflow Run | Durable work that can continue across waits or server restarts. |
| Agent Memory | Persistent context stored outside the Invocation. |

A Channel can start many Invocations, and a Workflow Run can carry an Invocation. Neither one replaces the request record.

## Inspect an invocation

Inspect the input, invoker, Channel, Capabilities, Workspace Scope, Driver, events, usage, and output together. Run `vitehub agent info` to inspect the Agent definition and `vitehub agent dev` to stream a local Invocation.

Read [Invocations](/docs/agents/invocations) for `runAgent()` and `streamAgent()`, or [Runtime policy, approvals, and traces](/docs/concepts/runtime-policy-approvals-and-traces) for the records produced during execution.
