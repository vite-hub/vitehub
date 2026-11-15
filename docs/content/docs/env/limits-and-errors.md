---
title: Env limits and errors
description: Handle structured Env errors with stable codes and JSON-safe context, and check Env configuration before production.
navigation.title: Limits and errors
navigation.order: 7
icon: i-lucide-circle-alert
---

## Structured errors

A failed Env read throws a `ViteHubError` with a stable code and JSON-safe details. Codes separate invalid declarations, sync reads of provider values, missing values, invalid runtime values, and failed sources. Errors from your own build source resolvers stay unchanged.

```ts fragment
import { getViteHubErrorShape } from 'vite-hub/runtime'

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

Each code has a fixed message and small details. Source details name the source: `git:branch`, `package.json`, `env`, `provider`, or `custom`. Raw variable names, provider keys, package paths, labels, and provider diagnostics stay in `cause`. `error.toJSON()` returns `code`, `message`, and `details`, never `cause`.

Wrong declaration helper calls and schema results use `ENV_R####` Nostics codes. Build integration bugs use `ENV_B####`.

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

### ENV_NOT_GENERATED

`useServerEnv()`, `usePublicEnv()`, or another accessor of `vite-hub/env` ran outside a Vite build, for example in a plain `node` script or a test without the Vite plugin. The Env Vite plugin generates the registry that these accessors read. Run the code through `vite dev`, `vite build`, or a framework that uses them, with `vitehub()` and Env on.

## Production checks

Built client code can see Public Env and Vite define values. Put secrets only in Server Env with `secret: true`.

> [!WARNING]
> Secret Env adds type friction and hides values by default, but it does not stop every leak. Unseal late. Never return a secret in responses, logs, traces, or Agent output.
