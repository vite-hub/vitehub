---
title: Compare ViteHub with other TypeScript tools
description: Compare ViteHub with Mastra, VoltAgent, AI SDK, LangGraph, Cloudflare Agents, NuxtHub, and Nitro by scope and deployment model.
navigation.title: Overview
navigation.order: 1
icon: i-lucide-columns-2
---

Pick a tool from the app you need to build. ViteHub adds Agents and server
services to your app through Vite. Some tools below solve the same problem.
You can use the others with ViteHub.

## Agent frameworks and libraries

- [ViteHub vs Mastra](/docs/compare/mastra): app structure, workflows, deploys.
- [ViteHub vs VoltAgent](/docs/compare/voltagent): Agent config, server
  integration, operations tools.
- [ViteHub and Vercel AI SDK](/docs/compare/ai-sdk): model and UI APIs versus
  the server services around an Agent.
- [ViteHub vs LangGraph JS](/docs/compare/langgraph): Agents found from files
  versus explicit state graphs.
- [ViteHub vs Cloudflare Agents](/docs/compare/cloudflare-agents): services
  that the host selects versus a Durable Object design.

## Server frameworks and services

- [ViteHub vs NuxtHub](/docs/compare/nuxthub): Nuxt server services, scope,
  migration.
- [ViteHub and Nitro](/docs/compare/nitro): the server base that ViteHub uses.

## Hosts

- [Vercel vs Netlify vs Cloudflare](/docs/compare/vercel-netlify-cloudflare):
  queues, cron, storage, sandboxes, pricing.

## When ViteHub is the wrong choice

- **Your framework has no ViteHub integration.** ViteHub works with Vite
  (through `vitehub()` and Nitro) and Nuxt 5. Next.js and other
  frameworks with their own server build do not work. Read
  [Frameworks and hosts](/docs/frameworks-hosts#choose-a-framework).
- **You need a stable API today.** ViteHub releases can change the public API.
- **You need MySQL.** ViteHub Database supports SQLite, libSQL, Cloudflare D1,
  and Postgres.
- **You need retrieval with a vector store.** ViteHub has no vector store or
  embedding pipeline. Mastra has both.
- **You build only for Cloudflare and want one stateful object for each agent.**
  The Cloudflare Agents SDK gives each agent instance its own SQL storage,
  WebSocket connections, and schedules.
- **Your host does not provide the feature.** For example, ViteHub has no Rate
  Limit driver for Vercel, and Queue on Netlify needs a Cloudflare or Vercel
  provider. Check the [support matrix](/docs/frameworks-hosts/support-matrix).
- **You want a hosted agent platform.** ViteHub runs inside your app, on your
  host account.

These pages cite official docs checked on 29 October 2026. They do not rank
speed, cost, security, or production readiness. Check the installed versions
and the support matrix before you choose a host.

To start from a task, read
[Choose a TypeScript Agent framework](/docs/guides/typescript-agent-frameworks).
