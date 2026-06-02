# Vite-First Framework Integrations

ViteHub's public framework integration surface is Vite-first. Packages expose Vite Integrations, Stable ViteHub Import Paths, Runtime Registries, Runtime Helpers, and Provider Output. Nitro is a supported server host composition target, not a first-class public ViteHub integration.

Package-specific `@vite-hub/*/nitro` modules are no longer the target public installation model. Nitro-powered wiring may remain as an internal or compatibility adapter while ViteHub replaces the route, runtime config, registry, auto-import, DevTools bridge, and Provider Output responsibilities that existing Nitro modules handled.

## Considered Options

- Keeping Vite and Nitro as equal public integrations was rejected because it duplicates package setup, makes users choose between framework surfaces, and preserves host-specific plumbing as ViteHub API.
- Removing Nitro compatibility outright was rejected because current ViteHub packages and downstream apps still rely on Nitro for host output, H3 routes, runtime config, Cloudflare Worker output, and generated server handlers.
- Treating `server/**` discovery as Nitro-owned was rejected for the long-term model. Server file conventions can remain compatibility or host conventions, but Discovery Identity belongs to ViteHub's package-owned discovery rules.

## Consequences

Docs and examples should teach Vite Integrations first. Nitro apps can still use ViteHub primitives through normal composition: a Vite-driven Nitro app can install ViteHub Vite plugins, and explicit Nitro/H3 route files can import stable ViteHub Runtime Helpers or handler factories.

Package-specific public `./nitro` exports should stay removed. If Nitro-powered behavior is still required, it should live behind Vite Integrations, stable Runtime Helpers, Provider Output, or explicit internal adapter paths. Keeping Nitro wiring internally is acceptable when it protects working Provider Output or runtime behavior.

ADR 0011 is compatibility guidance only after this decision. Nitro auto imports are not a reason to keep Nitro first-class. ADR 0025 remains correct about location-derived Discovery Identity, but Nitro server discovery should be read as an existing host convention rather than a permanent public Framework Integration.
