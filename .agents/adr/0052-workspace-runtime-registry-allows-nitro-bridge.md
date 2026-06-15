# Workspace Runtime Registry Allows Nitro Bridge

## Status

Accepted.

## Context

ADR 0040 keeps ViteHub's public framework integration surface Vite-only and rejects package-owned Nitro wiring by default. That remains the correct default. Workspace has a narrower runtime binding problem: Nitro-built server code can call Workspace Runtime Helpers such as `useWorkspace("mirror")`, but the package import fallback for the Workspace Runtime Registry is intentionally empty unless a Vite Integration or generated runtime bridge installs discovered Workspace Definitions.

For plain Vite server builds, the Vite Integration resolves `#vitehub-workspace-registry`. For Nuxt and Nitro builds, server routes may be bundled by Nitro after the Vite Integration has discovered Workspace Definitions, so the runtime can see an empty registry even though `hubWorkspace()` ran. Downstream apps can install `setWorkspaceRuntimeRegistry(...)` manually, but that repeats ViteHub registry plumbing in every Nitro consumer.

## Decision

`@vite-hub/workspace` may generate a Nitro plugin from its Vite Integration as a narrow Workspace Runtime Registry bridge.

This exception is limited to Workspace runtime binding:

- The public authoring surface remains `defineWorkspace(...)`, Workspace Source helpers, Workspace Runtime Helpers, and `hubWorkspace()`.
- Workspace identity and discovery remain ViteHub-owned Vite Integration behavior, not Nitro discovery.
- Generated Nitro files are Provider Output and Runtime Config wiring, not public app-facing imports.
- The generated plugin may call `setWorkspaceRuntimeRegistry(...)`.
- The generated plugin may call `configureCloudflareWorkspaceRuntime(...)` only when Integration Options resolve to a hosted Workspace Store that needs provider runtime configuration.
- The generated plugin must not create public `@vite-hub/workspace/nitro` exports, package-wide Nitro modules, Nitro-specific discovery, or app-level Workspace workflows.

## Consequences

Nuxt and Nitro consumers can call Workspace Runtime Helpers from server routes, plugins, and scheduled handlers without rebuilding the Runtime Registry bridge locally.

This deliberately keeps ViteHub's public Framework Integration surface Vite-only while accepting a generated runtime bridge for a package-owned primitive. Additional host-specific Workspace behavior still needs a separate decision.
