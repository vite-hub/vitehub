# Workspace Hosted Runtime Setup Allows Nuxt Nitro Handoff

## Status

Accepted.

## Context

ADR 0040 keeps ViteHub's public framework integration surface Vite-only. ADR 0051 creates a Schedule-only exception for Provider Wake because Cloudflare Cron Triggers enter Nitro-owned Workers through the host's scheduled event.

Workspace has a different hosted runtime problem. Hosted Workspace Stores such as GitHub and Cloudflare Artifacts need runtime setup so `useWorkspace()` can resolve the generated Workspace Runtime Registry and provider-backed store config. The Workspace Vite Integration already owns Workspace discovery, generated registries, and hosted runtime setup, but Nuxt does not consume unknown `nitro` config returned from nested Vite plugins. A Nuxt app can therefore generate `.vitehub/nitro/workspace/*` while Nitro still bundles the empty Workspace registry.

The downstream can write a local Nitro plugin, but that repeats Workspace Package runtime setup in every app and makes provider store internals app plumbing. Workspace Package ownership is the right boundary because Workspace owns the Workspace Runtime Surface, Workspace Stores, and generated backing layers.

## Decision

`@vite-hub/workspace` may expose `@vite-hub/workspace/nuxt` only to install the existing Workspace Vite Integration and merge generated hosted Workspace runtime setup into Nuxt's top-level Nitro config for hosted Workspace Stores.

This exception is limited to hosted Workspace runtime setup:

- The public authoring surface remains `defineWorkspace(...)`, `useWorkspace(...)`, and `hubWorkspace()`.
- The Nuxt module is a config lifecycle handoff, not a second Workspace Definition authoring model.
- Workspace identity and discovery remain ViteHub-owned Vite Integration behavior, not Nitro discovery.
- Generated Nitro files are Provider Output and Runtime Config transport, not public app-facing imports.
- Hosted Workspace Provider Adapters remain behind Workspace configuration and generated runtime wiring.
- Apps should reuse `vite.workspace` options rather than duplicate Workspace configuration in module options.
- This exception does not create public `@vite-hub/workspace/nitro` exports, package-wide Nitro modules, Vite plugin `.nitro` adapters, Nitro-specific discovery, or a precedent for packages that do not own hosted runtime setup.

## Consequences

Nuxt consumers can run hosted Workspace Stores inside Nitro-owned Workers without importing internal Workspace runtime state, provider store constructors, or generated files.

This deliberately trades ADR 0040 purity for Workspace Package ownership of hosted Workspace runtime setup. The exception should stay narrower than Schedule's Provider Wake exception: Workspace may ensure its runtime registry and store config reach Nitro, but it must not own generic Nitro routes, lifecycle, discovery, or provider wake behavior.

Tests and docs should call this hosted Workspace runtime setup or Nuxt Nitro handoff, not a general Nitro Framework Integration.
