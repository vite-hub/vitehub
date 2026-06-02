# Server and Public Env Are the App-Facing Runtime Env APIs

Updated by [ADR 0039: Vite-First Framework Integrations](./0039-vite-first-framework-integrations.md): generated Env access now belongs to Vite Integrations only.

Env-owned APIs distinguish the underlying **Runtime Env** concept from the app-facing access surfaces. Server code reads Runtime Env through **Server Env**, browser-safe build values read through **Public Env**, and app code uses stable `#vitehub/env/*` import paths instead of integration-specific virtual module ids.

## Considered Options

- Keep the previous runtime-config-named compatibility aliases.
- Rename only documentation while leaving generated declarations and runtime helpers on runtime config wording.
- Use `RuntimeEnv` and `useRuntimeEnv()` directly as the public API.
- Use `ServerEnv` and `useServerEnv()` for server runtime access, with `PublicEnv` and `usePublicEnv()` for browser-safe public values.

## Decision

Use **Runtime Env** for the Env Package concept and **Server Env** for the public server-code API. Generated `#vitehub/env/server` declarations, examples, and documentation expose `ServerEnv` and `useServerEnv(event?: unknown)`.

Use **Public Env** for app-code access to browser-safe build values. Generated public declarations expose `PublicEnv` and `usePublicEnv()` through `#vitehub/env/public`. The Vite virtual module remains an implementation detail rather than the documented import path.

Remove the old public compatibility aliases because there are no external users yet. Do not introduce `SecretEnv` or `.unseal()` in this decision.

Private integration code should describe applying Runtime Env rather than applying Env registry values to runtime config.

## Consequences

Server code imports `useServerEnv()` and the generated `ServerEnv` interface from `#vitehub/env/server`.

Browser-safe application code imports `usePublicEnv()` and the generated `PublicEnv` interface from `#vitehub/env/public`.

Chat and Agent keep their public `runtimeConfig` contracts. Env-generated type augmentation can still shape those contracts, but Env documentation should not present runtime config as the Env-owned API name.
