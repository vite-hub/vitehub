---
title: Env limits and errors
description: Handle structured Env errors with stable codes and JSON-safe context, and check Env configuration before production.
navigation.title: Limits and errors
navigation.order: 7
icon: i-lucide-circle-alert
---

## Structured errors

A failed Env read throws a `ViteHubError` with a stable code and JSON-safe details. Codes separate invalid declarations, sync reads of provider values, missing values, invalid runtime values, and failed sources. Errors from your own build source resolvers stay unchanged.

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

Each code has a fixed message and small details. Source details name the source: `git:branch`, `package.json`, `env`, `provider`, or `custom`. Raw variable names, provider keys, package paths, labels, and provider diagnostics stay in `cause`. `error.toJSON()` returns `code`, `message`, and `details`, never `cause`.

Wrong declaration helper calls and schema results use `ENV_R####` Nostics codes. Build integration bugs use `ENV_B####`.

## Production checks

Built client code can see Public Env and Vite define values. Put secrets only in Server Env with `secret: true`.

> [!WARNING]
> Secret Env adds type friction and hides values by default, but it does not stop every leak. Unseal late. Never return a secret in responses, logs, traces, or Agent output.
