---
title: ViteHub
description: ViteHub is an open-source Vite plugin. Use one API for databases, storage, queues, workflows, and AI Agents, and deploy to Cloudflare, Vercel, Netlify, or Node.
---

# The server layer for Vite apps

ViteHub gives Vite apps one API for databases, storage, queues, workflows, schedules, and more. Each of these Server Primitives works alone or with the others.

## Write once. Deploy anywhere.

Same code on every host. The host picks the provider: Workers KV or Upstash Redis for KV, R2 or Vercel Blob for Blob, Cloudflare Queues or Vercel Queues for Queue. Support differs per primitive and provider, so check the [support matrix](/docs/frameworks-hosts/support-matrix).

## Define an Agent in one file.

Your Agents live in your app, not beside it. A file in `server/agents/` picks the Agent's Channels, Driver, Workspace, and Capabilities (its tools). Capabilities use the same primitives as your routes, so a route can read the KV store that an Agent writes.

ViteHub builds on UnJS. Use TypeScript, native responses, and your usual Vite and Nuxt tools.

- [Build your first Server Primitive](/docs/getting-started/first-server-primitive)
- [Build your first Agent](/docs/getting-started/first-agent)
- [Migrate from NuxtHub](/docs/getting-started/migrate-from-nuxthub)
- [Choose a host](/docs/frameworks-hosts)
- [Browse docs](/docs)
