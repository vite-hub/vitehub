---
title: Runtime Helpers and stable imports
navigation.title: Runtime Helpers
description: Learn which ViteHub imports your server code calls at runtime, and how to fix import failures.
navigation.order: 2
navigation.group: Start
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

## Write a time as a duration

The options below read the same duration string: a number, an optional space, and a unit.

```ts [server/api/session.post.ts] fragment
const [kvError] = await kv.set('session', session, { ttl: '1h' })
if (kvError) throw kvError
const [workflowError] = await startWorkflow('reminder', payload, { delay: '3 days' })
if (workflowError) throw workflowError
```

| Unit | Long names |
| --- | --- |
| `ms` | `millisecond`, `milliseconds` |
| `s` | `sec`, `secs`, `second`, `seconds` |
| `m` | `min`, `mins`, `minute`, `minutes` |
| `h` | `hr`, `hrs`, `hour`, `hours` |
| `d` | `day`, `days` |
| `w` | `week`, `weeks` |

- A lifetime, such as KV and `seal()` `ttl`, Blob `sign({ expiresIn })`, Auth `stateless({ maxAge })`, and Queue `retention`, also takes a number. The number is seconds, so `{ ttl: 60 }` is one minute.
- Workflow and Queue `delay`, Webhooks `debounce`, and Auth `recheck` do not take a bare number. A number fails with [`RUNTIME_DURATION_INVALID`](/docs/runtime/diagnostics/runtime_duration_invalid), and its fix shows the string to write. Workflow `delay` also takes a `Date`.
- Rate Limit `window` requires a duration string. A non-string fails with `RATE_LIMIT_R0031` at runtime or `RATE_LIMIT_R0001` during discovery.
- `parseDuration()` and the `Duration` type from `vite-hub/runtime` read the same strings, for your own options. `parseDuration('5m')` returns `300000` milliseconds.
