---
title: Hosts
navigation.title: Hosts
navigation.order: 5
description: Hosts for ViteHub Logs, powered by Evlog.
icon: i-lucide-logs
---

Local Evlog capture uses the Nitro integration. Vite with Nitro 3 uses `evlog/nitro/v3`. Nuxt with Nitro 2 uses `evlog/nitro`. Keep adapter imports aligned with the installed Nitro version.

## Cloudflare

ViteHub enables native Worker observability by default in generated Cloudflare configuration. Explicit observability settings remain authoritative. Native Worker capture does not create a query adapter for the Console.

## Vercel and other hosts

Keep the host's existing logging and Evlog export pipeline. Connect a `LogSource` to its query API for Console and CLI access. Host log retention, permissions, and query availability depend on that backend.

Production builds reject local `logs: true` capture. Use a source module for production, or disable Logs for the build. The playground disables local capture when building and does not provision a backend.

An Evlog drain can send to a supported platform without making that platform readable through ViteHub. This distinction also applies to OpenTelemetry collectors and PostHog.
