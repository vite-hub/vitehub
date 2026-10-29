---
title: Hosts
navigation.title: Hosts
navigation.order: 5
description: Hosts for ViteHub Logs, powered by Evlog.
icon: i-lucide-logs
---

Local Evlog capture currently supports Nitro 3 and registers `evlog/nitro/v3`. Nuxt with Nitro 2 must register Evlog separately through `evlog/nuxt` and use an [existing backend source](/docs/logs/configure#read-an-existing-backend) for ViteHub Logs. Do not enable local `logs: true` capture on Nitro 2. Keep request logger imports aligned with the installed Nitro version: `evlog/nitro/v3` for Nitro 3 and `evlog/nitro` for Nitro 2.

## Cloudflare

ViteHub enables native Worker observability by default in generated Cloudflare configuration. Explicit observability settings remain authoritative. Native Worker capture does not create a query adapter for the Console.

## Vercel and other hosts

Keep the host's existing logging and Evlog export pipeline. Connect a `LogSource` to its query API for Console and CLI access. Host log retention, permissions, and query availability depend on that backend.

Production builds reject local `logs: true` capture. Use a source module for production, or disable Logs for the build. The playground disables local capture when building and does not provision a backend.

An Evlog drain can send to a supported platform without making that platform readable through ViteHub. This distinction also applies to OpenTelemetry collectors and PostHog.
