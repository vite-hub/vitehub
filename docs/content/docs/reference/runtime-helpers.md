---
title: Runtime Helpers and stable imports
navigation.title: Runtime Helpers and stable imports
description: Learn which ViteHub imports your server code calls at runtime, and how to fix import failures.
navigation.order: 51.5
navigation.group: Setup
icon: i-lucide-code-2
---

A Runtime Helper is the server function you import to use a ViteHub feature. It hides registries, provider bindings, and framework adapters. Each package page lists what it returns and which host resources it needs.

## Call the helper from server code

```ts [server/api/health.ts] fragment
import { useServerEnv } from 'vite-hub/env'

export function health() {
  const env = useServerEnv()
  return { environment: env.APP_ENV }
}
```

Use the import path from the feature page. Do not import `.vitehub` registry files: their structure can change.

## Keep configuration and runtime code separate

| Part | What it contains |
| --- | --- |
| Runtime Helper | The API your code calls. |
| Definition | Named config and behavior in your code. |
| Runtime Context | Host resources needed at run time. |
| Provider Output | Generated routes, bindings, functions, workers, or other host files. |

The helper reads Runtime Context, so you never build provider objects.

## Check an import failure

Check the import on the package page, the Vite plugin registration, and the generated types. See [Import paths](/docs/reference/import-paths) for path rules and [Provider Output](/docs/reference/provider-output) for generated files.
