---
title: How to choose a TypeScript Agent framework
description: Choose between ViteHub, Mastra, VoltAgent, AI SDK, LangGraph JS, and Cloudflare Agents from execution, state, deployment, and UI requirements.
navigation.title: Choose an Agent framework
navigation.order: 3
navigation.group: Agents
icon: i-lucide-list-checks
---

Choose the execution and state model before comparing feature counts.
A chat tool loop, a state graph, and a persistent Durable Object solve
different problems even when each can call a model.

This guide compares documented scope checked on 29 October 2026. It does not
rank projects by popularity, speed, or production readiness.

## Start with the application requirement

| Main requirement | Evaluate first | Reason |
| --- | --- | --- |
| Model calls, tools, and streamed chat in an existing app. | [AI SDK](/docs/compare/ai-sdk) | It supplies model, Agent, and UI APIs without requiring a new server stack. |
| An Agent framework with graph workflows, memory, retrieval, and Studio. | [Mastra](/docs/compare/mastra) | These are central parts of its documented framework. |
| Agent orchestration with supervisor APIs and VoltOps tools. | [VoltAgent](/docs/compare/voltagent) | It organizes the runtime and operational tools around Agents. |
| Explicit state transitions, checkpoints, and human interrupts. | [LangGraph JS](/docs/compare/langgraph) | Its main unit is a state graph with persistence. |
| A persistent service with Durable Object identity and connections. | [Cloudflare Agents](/docs/compare/cloudflare-agents) | It uses Cloudflare's stateful runtime architecture. |
| Agents plus server services discovered and configured through Vite. | [ViteHub](/docs/getting-started/first-agent) | It combines Agent Definitions with host-selected service integrations. |

These are starting points, not exclusive capabilities. Read each linked
comparison for official sources and the cases where another choice fits.

## Write down execution limits

Decide whether a request can wait for the result. If the job must outlive the
request, identify the provider that owns execution after the response.
Check maximum duration, retry behavior, and cancellation on the actual host.

A framework supporting several hosts does not mean every driver and feature
works on all of them. For ViteHub, inspect the
[support matrix](/docs/frameworks-hosts/support-matrix). For other tools, use
their current deployment guides linked from the comparisons.

## Decide what state must survive

List the state that must remain after a restart: conversation history,
tool results, workflow position, files, or pending approvals. Name the store
and the process that owns each item.

Do not treat an in-memory chat history as a checkpoint or durable job record.
Test recovery with the process stopped rather than assuming that a storage
integration covers all execution state.

## Build one representative task

Use a task that calls a tool, writes a result, and exposes a failure. Include
the authentication, storage, and deployment code in your assessment.
Check the trace and recovery path after a failed external request.

For ViteHub, begin with [First Agent](/docs/getting-started/first-agent), then
[deploy the same Agent on two hosts](/docs/guides/deploy-agent-cloudflare-vercel).
Add only the Capabilities and services that the task needs.

## Keep existing services when they fit

Changing an Agent framework does not require replacing every application
service. AI SDK can work with ViteHub, and an Agent can call routes backed by
existing NuxtHub services. Nitro remains the server foundation in a ViteHub app.

Compare the cost of migration as well as the new configuration. Existing
records, checkpoints, and stored files need an explicit migration plan.
