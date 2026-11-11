---
title: Logs hosts
navigation.title: Hosts
navigation.order: 5
description: "Where ViteHub Logs captures events: Nitro 3 local capture, Cloudflare Worker observability, and an existing backend on Vercel and other hosts."
icon: i-lucide-logs
---

Local Evlog capture supports Nitro 3, in Vite and in Nuxt 5, and registers `evlog/nitro/v3`. Import the request logger from `evlog/nitro/v3`.

## Cloudflare

ViteHub turns on native Worker observability in the generated Cloudflare config. Your own observability settings win. Native capture gives the Console no query adapter.

## Vercel and other hosts

Keep the host's logging and Evlog export. Connect a `LogSource` to its query API for Console and CLI access. That backend sets retention, permissions, and what you can query.

Production builds reject local `observability: { logs: true }` capture. Use a source module in production, or turn Logs off for the build. The playground turns off local capture in builds and sets up no backend.

An Evlog drain can send to a platform that ViteHub still cannot read. This is also true for OpenTelemetry collectors and PostHog.
