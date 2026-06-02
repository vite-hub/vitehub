# Secret Env Values Redact By Default

Updated by [ADR 0040: Vite-First Framework Integrations](./0040-vite-first-framework-integrations.md): Env's public access surface is the Vite-generated Server Env/Public Env import paths, not runtime-config compatibility helpers.

Runtime Env declarations with `secret: true` resolve to `SecretEnv<T>` objects instead of raw strings. `SecretEnv` redacts through string coercion, template literals, JSON serialization, and Node inspect output. Application code must call `.unseal()` at the boundary that needs the raw secret value.

## Considered Options

- Returning raw strings was rejected because accidental logging, interpolation, or response serialization can expose Secret Env values.
- Hiding secrets only in diagnostics was rejected because diagnostics are not the only place Runtime Env values can leak.
- Replacing the existing runtime config helper names was deferred in this decision and later superseded by Server Env/Public Env naming.
- Making optional missing secrets resolve to an empty Secret Env was rejected because optional missing Runtime Env already means `undefined`.

## Consequences

Generated `#vitehub/env/server` types emit `SecretEnv<string>` for required Secret Env declarations and `SecretEnv<string> | undefined` for optional Secret Env declarations. Present Secret Env values are explicit to unseal, while missing optional secrets remain `undefined`. Non-secret Runtime Env declarations continue to resolve as their generated runtime value types.
