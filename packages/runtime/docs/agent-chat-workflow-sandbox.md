---
title: Agent, Chat, Workflow, And Sandbox
description: Responsibility boundaries between ViteHub runtime, agent, chat, workflow, and sandbox packages.
navigation.title: Architecture Boundaries
navigation.order: 2
---

ViteHub keeps common runtime contracts below the feature packages.

| Package | Responsibility |
| --- | --- |
| `@vitehub/runtime` | Execution context, capabilities, policy, approvals, tracing, leases |
| `@vitehub/agent` | Model loop orchestration, tools, step policy, run and stream calls |
| `@vitehub/agent` | Chat SDK adapters, webhooks, thread interaction, agent handoff |
| `@vitehub/agent` | Serializable message and stream state |
| `@vitehub/workflow` | Durable orchestration, checkpoints, retries, deferred work |
| `@vitehub/sandbox` | Isolated execution sessions, files, shell, snapshots |

Agent may consume a sandbox capability, but sandbox owns sandbox lifecycle. Chat may call an agent, but agent owns model execution. Workflow may run from chat or agent entrypoints, but workflow owns durability and resume semantics.
