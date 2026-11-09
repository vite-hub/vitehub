---
title: ViteHub and Nitro
description: Learn what Nitro does as a server runtime and deploy tool, and what ViteHub adds on top of it.
navigation.title: Nitro
navigation.order: 8
navigation.group: Server frameworks
icon: i-lucide-server
---

Use Nitro when its routes, utilities, and deploy output cover your app. Add
ViteHub for Agents found from files or shared server service APIs. ViteHub
runs on Nitro, so you can use both.

## Separate the server from service definitions

Nitro owns the server build and runtime: routing, deploy presets, storage,
caching, database utilities, tasks, and WebSockets. It is more than an HTTP
router.

ViteHub adds services to that server. A ViteHub host picks the host output
and the default providers for the services you turn on. Each feature package
owns its Definitions, runtime APIs, and provider code.

For example, a Nitro route can call ViteHub KV or run an Agent.

## Choose by the contract you need

Keep Nitro APIs when they already do the job. A server with routes, cache, and
database access does not need an Agent framework to deploy.

Look at ViteHub when the app needs Agents found from files, explicit
Capabilities, shared server APIs, or host resources that a service generates.

Do not set conflicting Nitro presets and ViteHub deployment hosts. Read
[Nitro and UnJS](/docs/frameworks-hosts/nitro-unjs) to see who owns what.

## Check the Nitro generation

ViteHub's Vite setup uses Nitro v3, which the Nitro docs still call beta on
the date below. Use the versions in
[Installation](/docs/getting-started/installation). Do not mix Nitro v2 and v3
examples.

Nuxt has its own Nitro integration. Use `vite-hub/nuxt` there, check the
required Nuxt and Nitro versions, and do not add another Nitro Vite plugin.

Sources checked on 29 October 2026:
[Nitro documentation](https://nitro.build/docs),
[Nitro migration guide](https://nitro.build/docs/migration), and
[Nitro repository](https://github.com/nitrojs/nitro).
