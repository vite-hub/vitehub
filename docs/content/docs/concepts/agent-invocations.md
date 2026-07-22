---
title: Agent Invocations
description: Understand the request boundary that resolves identity, abilities, context, execution, and output for an Agent.
navigation.order: 5
icon: i-lucide-play-circle
---

An Agent Invocation is one runtime request to an Agent. It resolves the reusable Agent Definition into the identity, Capabilities, Workspace context, Agent Driver execution, lifecycle state, and output for that request.

The invocation is the composition boundary. An Agent Definition describes what can run, while an Agent Invocation records what actually ran for one input.

## Why it exists

Agents can be reached from server routes, Agent Triggers, schedules, Channels, the CLI Dev Loop, or other Agents. Each entry surface can supply different input, trusted caller identity, run metadata, and context without creating a different Agent Definition.

Keeping that variation inside an invocation makes runtime behavior inspectable. ViteHub can show which Agent Actor, Capabilities, Workspace Scope, Agent Driver, and output belonged to one request instead of treating them as ambient Agent state.

## Invocation lifecycle

| Phase | What resolves |
| --- | --- |
| Entry | A trusted server helper or Agent Trigger prepares prompt, message, or structured input with run metadata. |
| Identity | ViteHub resolves the Agent Actor from trusted invocation input, a configured profile or resolver, or the fallback identity. |
| Composition | The Agent Definition and active Channel select the Capabilities that apply to this invocation. |
| Context | Capabilities can prepare context values, policy, tools, and the visible Workspace Scope before execution. |
| Execution | The selected Agent Driver processes the prepared input through model-backed, harness-backed, or custom-run-backed execution. |
| Completion | ViteHub normalizes output and usage, runs finish behavior, records trace state, and returns or streams the result. |

Capability selection happens once for the invocation. A Capability omitted by an invocation-time resolver contributes no tools, requirements, policy, hooks, or cleanup work to that request.

## Keep neighboring concepts separate

| Concept | Responsibility |
| --- | --- |
| Agent Definition | Declares the reusable Agent composition and its possible runtime behavior. |
| Agent Invocation | Resolves and runs that composition once for one input. |
| Agent Trigger | Maps a product event into Agent Invocation input and run metadata. |
| Channel | Names reachability, origin, message facts, and delivery behavior around an invocation. |
| Chat Session | Selects which conversational messages are eligible for one invocation's Chat History Window. |
| Workflow Run | Provides a durable execution boundary when the Agent Invocation runs through a Workflow. |

A Channel can start many Agent Invocations, and a Chat Session can supply history to many Agent Invocations. Neither becomes the invocation itself. A Workflow Run can carry one hosted Agent Invocation across a durable boundary, but Workflow remains responsible for durability and orchestration.

## Inline and Workflow-backed invocations

Direct calls using the discovery-default Workflow binding run inline without a discovered Agent host identity. An explicit `runtime: workflow('name')` binding still routes direct calls through the named Workflow. Discovered Agent Definitions run through Workflows by default unless the Definition opts out or selects another Workflow binding.

Both paths still create one Agent Invocation. Workflow-backed execution adds a durable serialization boundary, so process-local objects such as an in-memory Trace Event Log do not cross into the Workflow Run.

## Invocation state is not Agent memory

Invocation context, run metadata, tools, and trace state belong to one request. Chat History, Agent Memory, Workspace files, and application stores persist only through the boundaries that own them.

Do not use an Agent Invocation as an implicit conversation or persistence layer. Configure Chat History for prior messages, Memory for durable learned context, and Workspace for file-tree state.

## Inspect an invocation

Inspect the prepared input, Agent Actor, active Channel, resolved Capabilities, visible Workspace Scope, Agent Driver, trace, usage, and final output together. These values explain the runtime request without requiring you to infer behavior from the Agent Definition alone.

`vitehub agent info` exposes resolved Agent metadata, while `vitehub agent dev` streams a local Agent Invocation. Server code can use invocation hooks, traces, and run events when the application needs programmatic inspection or progress reporting.

## Next steps

- Read [Invocations](/docs/agents/invocations) for `runAgent()`, `streamAgent()`, Agent Triggers, hooks, and run events.
- Read [Capabilities API](/docs/concepts/capabilities-api) for invocation-resolved abilities.
- Read [Runtime policy, approvals, and traces](/docs/concepts/runtime-policy-approvals-and-traces) for inspectable runtime decisions.
