---
title: Agent troubleshooting
description: Common setup issues for ViteHub Agent.
navigation.title: Troubleshooting
navigation.order: 5
icon: i-lucide-triangle-alert
frameworks: [vite, nitro]
---

## No generated Nitro route

Confirm that a Nitro agent exists under `server/agents.ts` or `server/agents/**`. The `*.agent.ts` suffix is Vite-only.

## Unknown agent

The generated route resolves the `[agent]` route param against discovered Nitro server agents. Check the normalized filename or named export.

## Cloudflare native routing fails

Install Cloudflare's `agents` package in the application that uses `defineCloudflareAgentsRouter()`. ViteHub keeps it optional so non-Cloudflare projects do not install the runtime.
