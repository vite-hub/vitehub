---
title: Nitro and UnJS
description: Understand the narrow boundary between ViteHub, Nitro, and UnJS server runtimes.
navigation.order: 42
navigation.group: Frameworks
icon: i-lucide-server
---

Use this page to understand how ViteHub uses Nitro. Nitro builds the server
output for every preset, in both Vite and Nuxt applications. ViteHub is not a
Nitro module system: Vite integrations stay the public integration layer, and
packages add Nitro handlers or plugins only where a host needs them.

## Where Nitro comes from

| Framework | Nitro integration | ViteHub sets |
| --- | --- | --- |
| Vite | `nitro()` from `nitro/vite`, next to `vitehub()` | The Nitro preset that matches the ViteHub preset |
| Nuxt | Nuxt's own Nitro build | The Nitro preset, through the `vite-hub/nuxt` module |

Do not select a different Nitro preset. A conflicting `nitro.preset`,
`NITRO_PRESET`, or `SERVER_PRESET` fails the build. Read
[Frameworks and hosts](/docs/frameworks-hosts#choose-a-preset) for the preset
mapping.

## Boundary

| Layer | ViteHub expectation |
| --- | --- |
| Vite | Public integration layer for discovery, generated files, the CLI Agent Dev Loop, and Provider Output. |
| Nitro | Host runtime bridge when a package must register generated handlers, middleware, or runtime hooks. |
| UnJS libraries | Implementation dependencies for server primitives, not public ViteHub framework identity. |
| Application server code | Calls Runtime Helpers and stable handlers without importing generated Nitro internals. |

## Internal server kit

ViteHub packages register generated Nitro handlers and plugins through a private
Server Kit in `@vite-hub/internal`. The kit owns registration, duplicate checks,
and ordering while the package keeps ownership of the generated file and its
runtime behavior.

The kit is an internal seam, not a public Nitro module API. It currently has one
implementation for Nitro 3. A second server adapter will be added only when a
supported host needs different registration semantics.

## Nitro handoffs

| Bridge | Owner | Purpose |
| --- | --- | --- |
| Schedule Provider Wake | Schedule Package | Registers Cloudflare scheduled runtime hooks and cron output for Nitro-shaped hosts. |
| Workspace hosted runtime setup | Workspace Package | Moves generated Workspace runtime setup into Nuxt's top-level Nitro config where hosted stores require it. |
| Database Nuxt D1 host wiring | Database Package | Keeps one D1 Database Host Resource in sync with Nuxt Content and Cloudflare output. |
| Auth route handler | Auth Package | Exposes the configured Auth route through a generated Nitro handler. |
| Agent chat and webhook routes | Agent Package | Dispatches generated Agent route output without making Nitro discovery or route files the app API. |

::warning
Treat generated Nitro handlers as Provider Output. They are not a general Nitro
framework integration or a public `@vite-hub/*/nitro` authoring surface.
::

## Keep application code on Runtime Helpers

Do not treat Nitro route files as the primary ViteHub API. Application code uses
the package's Runtime Helpers or stable server handler. For example, the
[Auth](/docs/auth) package generates its route from the Auth
Definition, and also exposes `createAuthHandler()` for frameworks that mount the
handler themselves. [Node and self-hosted](/docs/frameworks-hosts/node-self-hosted#mount-a-server-handler)
shows that handler.

## Next steps

- Use [Nuxt](/docs/frameworks-hosts/nuxt) for the Nuxt module.
- Use [Runtime and host support](/docs/frameworks-hosts/support-matrix) for the complete qualified matrix.
- Use [Provider output](/docs/reference/provider-output) for generated Nitro and host artifacts.
- Use [Import paths](/docs/reference/import-paths) for public imports.
