---
title: Runtime Helpers and stable imports
description: Understand which imports application code uses to call ViteHub.
navigation.order: 21
icon: i-lucide-code-2
---

A Runtime Helper is the documented server API that application code uses to call or inspect a ViteHub feature. ViteHub keeps generated registries, provider bindings, and framework adapters behind that import.

The package page documents what the API returns and which host resources it needs.

## Call the helper from server code

```ts [server/api/health.ts]
import { useServerEnv } from '#vitehub/env/server'

export function health() {
  const env = useServerEnv()
  return { environment: env.APP_ENV }
}
```

Use the package import or generated `#vitehub/...` path documented for the feature. Don't import `.vitehub` registry files directly. The integration can change their structure.

## Keep configuration and runtime code separate

| Part | What it contains |
| --- | --- |
| Runtime Helper | The application call or inspection API. |
| Definition | Named configuration and behavior in application code. |
| Runtime Context | Host resources needed during execution. |
| Provider Output | Generated routes, bindings, functions, workers, or other host artifacts. |

The Runtime Helper can use Runtime Context without making application code construct provider-specific objects.

## Check an import failure

Check the package's documented import, the registered Vite integration, and the generated type files. Read [Import paths](/docs/reference/import-paths) for exact path rules and [Provider Output](/docs/reference/provider-output) for generated files.
