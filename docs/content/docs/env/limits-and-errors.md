---
title: Env limits and errors
description: Handle structured Env errors with stable codes and JSON-safe context, and check Env configuration before production.
navigation.title: Limits and errors
navigation.order: 7
icon: i-lucide-circle-alert
---

## Structured errors

Env resolution failures use `ViteHubError` with closed, stable codes and JSON-safe context. The codes distinguish invalid declarations, synchronous access to provider-backed values, missing required values, invalid runtime values, and failed sources. Custom build source resolvers keep application-owned errors unchanged.

```ts
import { getViteHubErrorShape } from '@vite-hub/runtime'

try {
  await resolveEnv()
}
catch (error) {
  const shape = getViteHubErrorShape(error)
  if (shape?.code === 'ENV_SOURCE_FAILED') {
    console.error('Env source failed', shape.details?.source)
  }
  throw error
}
```

Each code owns a fixed public message and bounded details. Source details use identifiers such as `git:branch`, `package.json`, `env`, `provider`, or `custom`; raw variable names, provider keys, package paths, labels, and provider diagnostics remain behind `cause`. `error.toJSON()` includes `code`, `message`, and `details`; it omits `cause`, which remains available only on the in-memory error. Invalid declaration helper calls and schema results use package-owned `ENV_R####` Nostics codes. Build integration defects use `ENV_B####` codes.

## Seal errors

[`unseal()`](/docs/env/app-secret#seal-a-value) returns these codes as `[error, undefined]`. Each error has `code`, `why`, `fix`, and `docs`.

### ENV_SEAL_EXPIRED

The `ttl` that `seal()` got has passed. `why` gives the expiry time. Seal a new value, or give `seal()` a longer `ttl`.

### ENV_SEAL_INVALID

The string is not a value from `seal()`, someone changed it, or another root secret sealed it. A rotation of `VITEHUB_SECRET` gives this code for every value sealed before it. Treat the string as untrusted and seal a new value.

### ENV_SEAL_SCHEMA_MISMATCH

The value opened, but it does not match the `schema` that `unseal()` got. `error.cause` has the schema issues; `why` and `error.toJSON()` do not include them, because they can contain the value. A value that an older deployment sealed can have an older shape. Seal a new value.

### ENV_SEAL_WRONG_PURPOSE

The value was sealed for another purpose. Pass the purpose that `seal()` used. This code shows that a token of one kind, such as a review token, was sent where another kind was expected.

### ENV_SEAL_ARGUMENT_INVALID

`seal()` and `unseal()` throw this code for a bad argument: an empty purpose, a `ttl` that is not a positive number of seconds, a value that `JSON.stringify()` cannot write, or a `secret` shorter than 32 characters.

## Production checks

Public Env and Vite define values are visible to built client code. Put secrets only in Server Env with `secret: true`.

Secret Env provides type friction and default redaction, but it is not a complete leak-prevention system. Unseal secrets as late as possible and avoid returning them in responses, logs, traces, or Agent output.
