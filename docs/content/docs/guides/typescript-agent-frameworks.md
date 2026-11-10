---
title: How to choose a TypeScript Agent framework
description: Choose between ViteHub, Mastra, VoltAgent, AI SDK, LangGraph JS, and Cloudflare Agents from execution, state, deployment, and UI requirements.
navigation.title: Choose an Agent framework
navigation.order: 3
navigation.group: Agents
icon: i-lucide-list-checks
---

Decide how your Agent runs and what state it keeps before you compare
features. A chat tool loop, a state graph, and a Durable Object solve different
problems.

We checked each project's docs on 29 October 2026. This guide does not rank by
popularity, speed, or production readiness.

## Start with the application requirement

| Main requirement | Evaluate first | Reason |
| --- | --- | --- |
| Model calls, tools, and streamed chat in an existing app. | [AI SDK](/docs/compare/ai-sdk) | Model, Agent, and UI APIs with no new server stack. |
| Graph workflows, memory, retrieval, and Studio. | [Mastra](/docs/compare/mastra) | These are central to the framework. |
| Agent orchestration with supervisor APIs and VoltOps tools. | [VoltAgent](/docs/compare/voltagent) | Runtime and ops tools built around Agents. |
| Explicit state transitions, checkpoints, and human interrupts. | [LangGraph JS](/docs/compare/langgraph) | Its main unit is a persisted state graph. |
| A persistent service with Durable Object identity and connections. | [Cloudflare Agents](/docs/compare/cloudflare-agents) | Built on Cloudflare's stateful runtime. |
| Agents plus server services, set up through Vite. | [ViteHub](/docs/getting-started/first-agent) | Agent files plus services that match the host. |

These are starting points. Each comparison links its sources and says when
another choice fits.

## Write down execution limits

Can the request wait for the result? If not, name the provider that runs the
job after the response. Check maximum duration, retries, and cancellation on
the real host.

Not every driver and feature works on every supported host. For ViteHub, see
the
[support matrix](/docs/frameworks-hosts/support-matrix). For other tools, use
the deployment guides linked from the comparisons.

## Decide what state must survive

List the state that must survive a restart: chat history, tool results,
workflow position, files, or pending approvals. Name the store and the process
that owns each one.

An in-memory chat history is not a checkpoint or a durable job record. Stop
the process and test recovery. Do not assume a storage integration covers all
run state.

## Build one representative task

Pick a task that calls a tool, writes a result, and can fail. Count the auth,
storage, and deploy code. After a failed request, check the trace and recovery.

For ViteHub, start with [First Agent](/docs/getting-started/first-agent), then
[deploy the same Agent on two hosts](/docs/guides/deploy-agent-cloudflare-vercel).
Add only the Capabilities (access rights) and services the task needs.

## Keep existing services when they fit

A new Agent framework does not mean new app services. AI SDK works with
ViteHub, and an Agent can call routes that use your NuxtHub services. Nitro
stays the server base of a ViteHub app.

Count the migration cost too. Existing records, checkpoints, and files need a
migration plan.
