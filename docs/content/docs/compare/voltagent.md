---
title: ViteHub vs VoltAgent
description: Compare ViteHub and VoltAgent for TypeScript Agent configuration, tools, workflows, server services, and inspection.
navigation.title: VoltAgent
navigation.order: 3
navigation.group: Agent frameworks
icon: i-lucide-bot
---

Choose VoltAgent when its Agent runtime, supervisor and subagent APIs, and
VoltOps tools fit the application. Choose ViteHub when the application's Vite
build should discover Agents and configure the server services around them.

Both projects have tools, memory, workflows, and inspection features. Both
support server deployments. A hosted dashboard is not required to use either
project's open-source runtime.

## Compare the units you configure

VoltAgent documents Agents, supervisor orchestration, tools, memory, retrieval,
guardrails, workflows, and evals. VoltOps adds operational tools with cloud and
self-hosted forms.

ViteHub discovers Agent Definitions and composes their behavior with
[Capabilities](/docs/agents/capabilities). Workspaces and Sources declare file
access. Separate server services supply storage, queues, schedules, email, and
other operations that trusted application code can also call.

A team assistant with several specialist Agents can fit VoltAgent's supervisor
model. An existing Vite app that needs an Agent plus Blob, KV, and scheduled
work can evaluate ViteHub's shared configuration and server imports.

## Check the target host

VoltAgent documents Node and serverless deployment options, including
Cloudflare. Check its current host guide for runtime and console restrictions.
Do not infer that every Node integration runs unchanged in a Worker.

ViteHub also has per-host restrictions. Check the
[support matrix](/docs/frameworks-hosts/support-matrix) and each enabled
service's Hosts page. The Codex and Claude Code provider Drivers require
their documented Node process environment.

## Compare operation with a failed run

Build the same tool task in both projects. Check how you configure access,
store history, inspect a tool error, and retry work. Include the storage and
deployment setup in the comparison rather than counting only Agent code.

Do not assume stored memory, conversation records, or workflow runs can move
between the frameworks without a migration.

Sources checked on 29 October 2026:
[VoltAgent repository and feature overview](https://github.com/VoltAgent/voltagent),
[deployment overview](https://github.com/VoltAgent/voltagent/blob/main/website/docs/deployment.md),
and [Cloudflare deployment guide](https://github.com/VoltAgent/voltagent/blob/main/website/deployment-docs/cloudflare-workers.md).
Start with [First Agent](/docs/getting-started/first-agent) to test ViteHub.
