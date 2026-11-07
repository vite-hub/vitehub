---
title: Hosts
navigation.title: Hosts
navigation.order: 5
description: Hosts for ViteHub Logs, powered by Evlog.
icon: i-lucide-logs
---

Local Evlog capture supports Nitro 3 and registers `evlog/nitro/v3`. On Nuxt with Nitro 2, register Evlog yourself through `evlog/nuxt` and use an [existing backend source](/docs/logs/configure#read-an-existing-backend). Do not turn on local `logs: true` capture on Nitro 2. Import the request logger that matches your Nitro: `evlog/nitro/v3` for Nitro 3, `evlog/nitro` for Nitro 2.

## Cloudflare

ViteHub turns on native Worker observability in the generated Cloudflare config. Your own observability settings win. Native capture gives the Console no query adapter.

## Vercel and other hosts

Keep the host's logging and Evlog export. Connect a `LogSource` to its query API for Console and CLI access. That backend sets retention, permissions, and what you can query.

Production builds reject local `logs: true` capture. Use a source module in production, or turn Logs off for the build. The playground turns off local capture in builds and sets up no backend.

An Evlog drain can send to a platform that ViteHub still cannot read. This is also true for OpenTelemetry collectors and PostHog.
