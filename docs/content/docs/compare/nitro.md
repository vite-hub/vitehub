---
title: ViteHub and Nitro
description: Understand Nitro's server runtime and deployment role, and the Agent Definitions and server service integrations ViteHub adds on top.
navigation.title: Nitro
navigation.order: 8
navigation.group: Server frameworks
icon: i-lucide-server
---

Use Nitro when its server routes, runtime utilities, and deployment output
cover the application. Add ViteHub when you want discovered Agent Definitions
or its shared server service APIs. ViteHub uses Nitro, so these are not
mutually exclusive frameworks.

## Separate the server from service definitions

Nitro owns the server build and runtime. It provides routing, deployment
presets, storage, caching, database utilities, tasks, and WebSockets.
It is inaccurate to describe Nitro as only an HTTP router.

ViteHub composes service integrations with that server. A ViteHub preset
selects host output and default providers for enabled services. Feature
packages own Definitions, runtime APIs, and their provider contributions.

For example, a Nitro route can call ViteHub KV or run an Agent. The route
belongs to the server, while ViteHub supplies the selected service contract.

## Choose by the contract you need

Keep direct Nitro APIs when they already express the job. A server with routes,
cache, and existing database access does not need an Agent framework merely
to deploy.

Evaluate ViteHub when the app needs discovered Agents, explicit Capabilities,
shared server APIs, or service-specific generated host resources. Compare
those requirements with the Nitro utilities you already use.

Do not configure conflicting Nitro and ViteHub deployment presets. Follow
[Nitro and UnJS](/docs/frameworks-hosts/nitro-unjs) for integration ownership.

## Check the Nitro generation

Nitro v3 introduces the Vite integration used by ViteHub's Vite setup. Its
documentation still identifies v3 as beta on the date below. Follow the
versions in [Installation](/docs/getting-started/installation), rather than
mixing examples from Nitro v2 and v3.

Nuxt supplies its own Nitro integration. Use `vite-hub/nuxt` there and confirm
the required Nuxt and Nitro versions. Do not register another Nitro Vite
plugin in the Nuxt app.

Sources checked on 29 October 2026:
[Nitro documentation](https://nitro.build/docs),
[Nitro migration guide](https://nitro.build/docs/migration), and
[Nitro repository](https://github.com/nitrojs/nitro).
