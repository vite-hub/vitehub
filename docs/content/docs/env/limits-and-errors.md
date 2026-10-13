---
title: Env limits and errors
description: Handle structured Env errors and check Env before production.
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

## Production checks

Public Env and Vite define values are visible to built client code. Put secrets only in Server Env with `secret: true`.

Secret Env provides type friction and default redaction, but it is not a complete leak-prevention system. Unseal secrets as late as possible and avoid returning them in responses, logs, traces, or Agent output.
