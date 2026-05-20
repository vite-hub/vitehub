# Env Package

Env Package names ownership boundaries for `@vitehub/env`.

## Language

**Env Package**:
The package that owns typed environment declarations, diagnostics, generated env access, and secret handling.
_Avoid_: Dotenv wrapper, provider secret manager

**Env Declaration**:
The typed declaration of one environment value.
_Avoid_: Process env read, config property

**Build Env**:
Environment values resolved for Vite build and transform usage.
_Avoid_: Runtime secret, server config

**Runtime Env**:
Environment values resolved for server runtime usage.
_Avoid_: Public build value, compile-time define, runtime config

**Server Env**:
The public server-code access surface for Runtime Env.
_Avoid_: Safe runtime config, app config

**Public Env**:
Build Env values intentionally exposed to browser-safe application code.
_Avoid_: Runtime public config, client secret, public runtime env

**Env Source**:
An origin that can provide an Env Declaration value.
_Avoid_: Provider, adapter, dotenv file

**Secret Env**:
A Runtime Env value that redacts by default and requires unsealing before use as its underlying value.
_Avoid_: Private build value, hidden config, masked diagnostic

**Secret Unseal**:
An explicit operation on a Secret Env that reads its underlying value.
_Avoid_: Reveal, unmask, unwrap, decrypt

## Relationships

- The **Env Package** owns **Env Declarations**.
- **Build Env** belongs to Vite integration.
- **Runtime Env** belongs to Nitro integration.
- **Runtime Env** is the Env Package's primary language for server runtime values; Nitro runtime config is currently a transport for those values, not the public Env API name.
- **Server Env** is the public API naming pattern for server-code access to **Runtime Env**.
- **Public Env** is the public API naming pattern for build-time public values.
- Generated env access should use stable `#vitehub/env/*` import paths instead of exposing integration-specific virtual module names.
- A **Secret Env** is a Runtime Env value.
- A **Secret Env** is not interchangeable with its underlying value.
- A **Secret Unseal** can read the underlying value from a **Secret Env**.
- An **Env Source** can provide an Env Declaration value.
- Generated env access should preserve the difference between Build Env and Runtime Env.

## Example Dialogue

> **Dev:** "Can a server token be exposed through the Vite build virtual module?"
> **Domain expert:** "No. That is **Runtime Env**, and if it is sensitive it is **Secret Env**."
>
> **Dev:** "Should app code import the Vite virtual module directly?"
> **Domain expert:** "No. App code uses **Public Env** through the ViteHub public env import path; the virtual module is an integration detail."
>
> **Dev:** "Can I pass a Secret Env directly to a third-party SDK?"
> **Domain expert:** "Only if the SDK accepts the redacted wrapper. Most SDK calls need a **Secret Unseal** at the last responsible moment."

## Flagged Ambiguities

- Build-time and server runtime values were considered one config surface - resolved: use **Build Env** and **Runtime Env**.
- Runtime Env was previously described as safe runtime config - resolved: use **Server Env** for the public server access API, **Runtime Env** for the underlying Env Package concept, and reserve runtime config for Nitro or Chat/Agent contracts that actually expose `runtimeConfig`.
- Public Build Env was previously exposed through a Vite virtual module path - resolved: use **Public Env** as the public app-code concept and hide integration-specific virtual module names behind ViteHub import paths.
- Secret handling was considered provider-specific - resolved: **Secret Env** is ViteHub language for Runtime Env values that redact by default.
- Secret handling was considered only a diagnostics concern - resolved: diagnostics masking is one consequence of **Secret Env**, not the definition.
- Secret Env compatibility with strings was considered - resolved: **Secret Env** is not assignable to its underlying value until a **Secret Unseal**.
