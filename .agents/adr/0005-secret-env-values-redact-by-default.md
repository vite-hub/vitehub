# Secret Env Values Redact By Default

Runtime Env declarations with `secret: true` resolve to `SecretEnv<T>` objects instead of raw strings. `SecretEnv` redacts through string coercion, template literals, JSON serialization, and Node inspect output. Application code must call `.unseal()` at the boundary that needs the raw secret value.

## Considered Options

- Returning raw strings was rejected because accidental logging, interpolation, or response serialization can expose Secret Env values.
- Hiding secrets only in diagnostics was rejected because diagnostics are not the only place Runtime Env values can leak.
- Replacing the existing runtime config helper names was rejected for this decision; `useSafeRuntimeConfig()`, `SafeRuntimeConfig`, and the Nitro runtime config bridge stay as the public access surface.
- Making optional missing secrets resolve to an empty Secret Env was rejected because optional missing Runtime Env already means `undefined`.

## Consequences

Generated `#vitehub/env/server` types emit `SecretEnv<string>` for required Secret Env declarations and `SecretEnv<string> | undefined` for optional Secret Env declarations. Present Secret Env values are explicit to unseal, while missing optional secrets remain `undefined`. Non-secret Runtime Env declarations continue to resolve as their generated runtime value types.
