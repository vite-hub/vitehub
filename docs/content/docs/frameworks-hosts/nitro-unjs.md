---
title: Nitro and UnJS
description: Understand the narrow boundary between ViteHub, Nitro, and UnJS server runtimes.
navigation.order: 42
navigation.group: Frameworks
icon: i-lucide-server
---

Nitro builds the server output for every host, in Vite and Nuxt apps.
ViteHub is not a Nitro module system. Vite integrations are the public layer,
and packages add Nitro handlers or plugins only where a host needs them.

## Where Nitro comes from

| Framework | Nitro integration | ViteHub sets |
| --- | --- | --- |
| Vite | Included in `vitehub()`. If the app also adds `nitro()`, ViteHub uses that one. | The Nitro preset that matches the ViteHub host |
| Nuxt | Nuxt's own Nitro build | The Nitro preset, through the `vite-hub/nuxt` module |

Do not select a different Nitro preset. A conflicting `nitro.preset`,
`NITRO_PRESET`, or `SERVER_PRESET` fails the build. See the
[host mapping](/docs/frameworks-hosts#choose-a-host).

## Boundary

| Layer | ViteHub expectation |
| --- | --- |
| Vite | Public layer for discovery, generated files, the CLI Agent Dev Loop, and Provider Output (generated host files). |
| Nitro | Host runtime bridge when a package must register generated handlers, middleware, or hooks. |
| UnJS libraries | Dependencies behind server primitives, not part of the public ViteHub API. |
| Application server code | Calls Runtime Helpers and stable handlers, never generated Nitro internals. |

## Internal server kit

ViteHub packages register generated Nitro handlers and plugins through a
private Server Kit in `@vite-hub/internal`. The kit owns registration,
duplicate checks, and order. The package owns the generated file and its
runtime behavior.

The kit is internal, not a public Nitro module API. It has one implementation,
for Nitro 3. A second adapter comes only when a supported host needs different
registration rules.

## Nitro handoffs

| Bridge | Owner | Purpose |
| --- | --- | --- |
| Schedule Provider Wake | Schedule Package | Registers Cloudflare scheduled hooks and cron output for Nitro hosts. |
| Workspace hosted runtime setup | Workspace Package | Moves generated Workspace runtime setup into Nuxt's top-level Nitro config when hosted stores need it. |
| Database Nuxt D1 host wiring | Database Package | Keeps one D1 Database Host Resource in sync with Nuxt Content and Cloudflare output. |
| Auth route handler | Auth Package | Exposes the configured Auth route through a generated Nitro handler. |
| Agent chat and webhook routes | Agent Package | Dispatches generated Agent routes without making Nitro route files the app API. |

::warning
Generated Nitro handlers are Provider Output. They are not a general Nitro
integration or a public `@vite-hub/*/nitro` API.
::

## Keep application code on Runtime Helpers

Nitro route files are not the main ViteHub API. Your code uses the package's
Runtime Helpers or stable server handler. For example, [Auth](/docs/auth)
generates its route from the Auth Definition and also exports
`createAuthHandler()` for frameworks that mount the handler themselves.
[Node and self-hosted](/docs/frameworks-hosts/node-self-hosted#mount-a-server-handler)
shows it.

## Next steps

- Use [Nuxt](/docs/frameworks-hosts/nuxt) for the Nuxt module.
- Use [Runtime and host support](/docs/frameworks-hosts/support-matrix) for the complete qualified matrix.
- Use [Provider output](/docs/reference/provider-output) for generated Nitro and host artifacts.
- Use [Import paths](/docs/reference/import-paths) for public imports.
