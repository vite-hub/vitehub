---
title: Env troubleshooting
description: Fix missing env values, invalid schemas, generated type issues, and runtime config mismatches.
navigation.title: Troubleshooting
navigation.order: 100
icon: i-lucide-circle-alert
frameworks: [vite, nitro]
---

Use this page when Env declarations are present but generated config or validation is not behaving as expected.

## A required value is missing

Symptom: startup or request handling throws a missing runtime env value.

Cause: the declaration is required and the source env var is not set.

Fix: set the environment variable, add a safe `default`, or mark the declaration optional.

```ts
env: {
  optionalApiBase: env({
    optional: true,
  }),
}
```

## The inferred env var name is wrong

Cause: inferred names come from the config path and optional prefix. For `env.auth.token`, the default source is `AUTH_TOKEN`.

Fix: use an explicit source when the provider uses a different name.

```ts
env: {
  auth: {
    token: env({
      secret: true,
      source: env.source('TELEGRAM_BOT_TOKEN'),
    }),
  },
}
```

## Generated Vite types are missing

Symptom: TypeScript cannot find `virtual:@vitehub/env/build`.

Cause: Vite has not run `configResolved` yet, so `.vitehub/env/vite.d.ts` has not been written.

Fix: start the dev server or run a Vite build once. Confirm the project includes generated declaration files in TypeScript.

## Generated Nitro types are missing

Symptom: TypeScript cannot find `#vitehub/env/server` or the generated runtime config fields.

Cause: Nitro type generation has not run.

Fix: run the framework's prepare or typecheck command so Nitro executes `types:extend`.

## Async schema error

Error:

```txt
[vitehub] ... uses an async schema. Env validation currently requires sync schemas.
```

Cause: the validator returns a Promise.

Fix: use a synchronous schema for Env validation, or validate asynchronously in application code after reading the value.

## Custom runtime schema error

Cause: Nitro runtime registries are serialized and cannot preserve custom schema objects.

Fix: keep runtime declarations on the default string schema, then parse the value in server code.

## Secret value appears missing in diagnostics

Secret diagnostics are masked. A secret declaration can still be valid even though its value is not printed.

Use `diagnostics: 'trace'` to confirm the declaration status and source without exposing the secret value.
