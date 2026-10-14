---
title: ViteHub
description: Server primitives for Vite. Write server code once and deploy it across supported hosts.
---

# The server layer for Vite apps

ViteHub gives Vite apps one API for storage, queues, workflows, schedules, and more. Use each Server Primitive on its own or combine them in your application.

## Write once. Deploy anywhere.

Same code on every host. The host picks the provider: Workers KV or Upstash Redis for KV, R2 or Vercel Blob for Blob, Cloudflare Queues or Vercel Queues for Queue. Host support depends on the primitive and provider. Check the [support matrix](/docs/frameworks-hosts/support-matrix) for each target.

## Define an Agent in one file.

Your Agents live in your app, not beside it. An Agent Definition in `server/agents/` picks its Channels, Driver, Workspace, and Capabilities. Capabilities wrap the same primitives your routes call, so a route can read the KV store an Agent writes.

ViteHub builds on the UnJS ecosystem. Use TypeScript, native responses, and the tools you already use with Vite and Nuxt.

- [Build your first Server Primitive](/docs/getting-started/first-server-primitive)
- [Build your first Agent](/docs/getting-started/first-agent)
- [Migrate from NuxtHub](/docs/getting-started/migrate-from-nuxthub)
- [Choose a host](/docs/frameworks-hosts)
- [Browse docs](/docs)
