---
title: Compare ViteHub with other TypeScript tools
description: Compare ViteHub with Mastra, VoltAgent, AI SDK, LangGraph, Cloudflare Agents, NuxtHub, and Nitro by scope and deployment model.
navigation.title: Overview
navigation.order: 1
icon: i-lucide-columns-2
---

Choose a tool from the application you need to build. ViteHub combines Agent
Definitions and server services through Vite integrations. Some tools below
solve a similar problem. Others are libraries or server frameworks you can
use with ViteHub.

## Agent frameworks and libraries

- [ViteHub vs Mastra](/docs/compare/mastra) compares application structure,
  workflow choices, and deployment.
- [ViteHub vs VoltAgent](/docs/compare/voltagent) compares Agent configuration,
  server integration, and operational tools.
- [ViteHub and Vercel AI SDK](/docs/compare/ai-sdk) separates model and UI APIs
  from the server services around an Agent.
- [ViteHub vs LangGraph JS](/docs/compare/langgraph) compares discovered
  Definitions with explicit state graphs.
- [ViteHub vs Cloudflare Agents](/docs/compare/cloudflare-agents) compares
  host-selected services with a Durable Object architecture.

## Server frameworks and services

- [ViteHub vs NuxtHub](/docs/compare/nuxthub) compares Nuxt server services,
  framework scope, and migration work.
- [ViteHub and Nitro](/docs/compare/nitro) explains the server foundation that
  ViteHub uses.

## Hosts

- [Vercel vs Netlify vs Cloudflare](/docs/compare/vercel-netlify-cloudflare)
  compares queues, cron, storage, sandboxes, and pricing models on each host.

## When ViteHub is the wrong choice

Use another tool in these cases:

- **Your framework has no ViteHub integration.** ViteHub integrates with Vite,
  through `vitehub()` and Nitro, and with Nuxt 4.5.2 or newer. Next.js and
  other frameworks with their own server build have no integration. Read
  [Frameworks and hosts](/docs/frameworks-hosts#choose-a-framework).
- **You need a stable API today.** ViteHub releases can change the public API.
- **You need MySQL.** ViteHub Database supports SQLite, libSQL, Cloudflare D1,
  and Postgres.
- **You need retrieval with a vector store.** ViteHub has no vector store and
  no embedding pipeline. Mastra has both.
- **You build only for Cloudflare and want one stateful object for each agent.**
  The Cloudflare Agents SDK gives each agent instance its own SQL storage,
  WebSocket connections, and schedules.
- **Your host does not provide the feature.** For example, ViteHub has no Rate
  Limit driver for Vercel, and Queue on Netlify needs a Cloudflare or Vercel
  provider. Check the [support matrix](/docs/frameworks-hosts/support-matrix)
  before you choose.
- **You want a hosted agent platform.** ViteHub has no hosted runtime. It runs
  inside your app, on your host account.

These pages cite official documentation checked on 29 October 2026. They do not
rank speed, cost, security, or production readiness. ViteHub is early and its
API still changes. Check the installed versions and the
[support matrix](/docs/frameworks-hosts/support-matrix) before choosing a host.

For a task-based starting point, read
[Choose a TypeScript Agent framework](/docs/guides/typescript-agent-frameworks).
