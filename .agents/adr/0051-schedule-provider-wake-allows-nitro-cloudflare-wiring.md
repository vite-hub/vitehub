# Schedule Provider Wake Allows Nitro Cloudflare Wiring

## Status

Accepted.

## Context

ADR 0040 keeps ViteHub's public framework integration surface Vite-only and rejects package-owned Nitro modules, generated Nitro plugins, and hidden Nitro compatibility wiring. That remains the default rule because ViteHub should not make every package own host-specific adapters.

Schedule has a narrower deployment problem. Cloudflare Cron Triggers enter a deployed Worker through the Worker's `scheduled(controller, env, context)` export. When a Nitro app owns that Worker export, ViteHub Schedule can discover Static Schedule Definitions and generate a Runtime Registry, but the Schedule handler will never run unless Nitro's Cloudflare scheduled event is connected to the Schedule runtime.

The downstream can write a tiny Nitro hook adapter, but ViteHub's Schedule primitive is specifically meant to own Provider Wake behavior. Requiring every Nitro consumer to rebuild the same Cloudflare scheduled hook and Wrangler cron merge keeps Schedule Provider Wake as app plumbing rather than package-owned Provider Output.

## Decision

Schedule is the only accepted exception to ADR 0040's ban on package-owned Nitro wiring. `@vite-hub/schedule` may generate Nitro Cloudflare hook/config files from its Vite Integration when Static Schedule Definitions need to run inside a Nitro-owned Cloudflare Worker. For Nuxt apps, `@vite-hub/schedule/nuxt` may install the Vite Integration and merge that generated Provider Wake output into Nuxt's top-level Nitro config because Nuxt does not consume unknown `nitro` config returned from nested Vite plugins.

This exception is limited to Schedule Provider Wake:

- The public authoring surface remains `defineSchedule(...)` plus `hubSchedule()`.
- The Nuxt module is Provider Wake installation, not a second Schedule Definition authoring model.
- Schedule identity and discovery remain ViteHub-owned Vite Integration behavior, not Nitro discovery.
- Generated Nitro files are Provider Output, not public app-facing imports.
- The generated runtime hook may call ViteHub Schedule runtime helpers, but it must not route execution through Nitro Task.
- The generated config may contribute Cloudflare cron triggers required to wake the Worker.
- This exception does not create public `@vite-hub/schedule/nitro` exports, package-wide Nitro modules, Vite plugin `.nitro` adapters, Nitro-specific discovery, or a precedent for other packages.

## Consequences

Nitro and Nuxt consumers can use ViteHub Schedule Definitions for Cloudflare cron without reintroducing Nitro Task or writing local Schedule bridge code.

This deliberately trades ADR 0040 purity for the Schedule Package's Provider Wake responsibility. The exception should stay narrow. If Agent, Workspace, Env, Blob, Database, or other packages need host-specific runtime entrypoints later, they need their own ADR rather than copying Schedule's Nitro wiring.

Tests and docs should call this Schedule Provider Wake or Cloudflare Provider Output, not a general Nitro Framework Integration.
