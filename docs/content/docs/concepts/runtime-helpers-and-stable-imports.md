---
title: Runtime Helpers and stable imports
description: Understand the application-facing imports that hide generated host details while keeping runtime behavior inspectable.
navigation.group: Runtime execution
navigation.order: 21
icon: i-lucide-code-2
---

A Runtime Helper is the stable server API that application code uses to call or inspect a ViteHub primitive. It keeps generated registries, provider bindings, and framework adapters behind the package boundary.

Stable imports hide implementation details without hiding the runtime contract. The package page documents what the helper returns, which host resources it needs, and which outputs it can produce.

## Use the helper from server code

```ts [server/api/health.ts]
import { getEnv } from '#vitehub/env/server'

export function health() {
  return { environment: getEnv('APP_ENV') }
}
```

Use the documented package import or generated `#vitehub/...` path. Do not import `.vitehub` registry files directly; those files are Provider Output and can change when the integration changes.

## Runtime Helper, Definition, and Provider Output

| Surface | Carries |
| --- | --- |
| Runtime Helper | The application call or inspection API. |
| Definition | Portable named configuration and behavior. |
| Runtime Context | Host-owned execution facts and resources. |
| Provider Output | Generated routes, bindings, functions, workers, or other host artifacts. |

The helper can require Runtime Context even though application code does not construct the provider-specific pieces itself.

## Inspect the import boundary

When an import fails, check the package's documented path, the registered Vite Integration, and the generated type files. Open [Import paths](/docs/reference/import-paths) for exact path rules and [Provider Output](/docs/reference/provider-output) for generated artifact ownership.
