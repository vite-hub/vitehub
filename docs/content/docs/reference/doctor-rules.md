---
title: Doctor rules
description: Find ViteHub mistakes in application code with Vite Doctor.
navigation.order: 59
navigation.group: Runtime and output
icon: i-lucide-stethoscope
---

[Vite Doctor](https://github.com/onmax/vite-doctor) checks application code and reports diagnostics with a stable code. ViteHub ships a Doctor Extension with rules for ViteHub mistakes. You do not register it. Install `vite-doctor` and run it, and the ViteHub rules run with the other rules.

## Run the ViteHub rules

With Vite, add the `doctor()` plugin after `vitehub()`. The `vitehub()` plugin gives its Doctor Extension to `doctor()`.

```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'
import { doctor } from 'vite-doctor'

export default defineConfig({
  plugins: [vitehub({ preset: 'node' }), doctor()],
})
```

With Nuxt, add `vite-doctor/nuxt` after `vite-hub/nuxt`, prepare the app, and run the Nuxt Doctor Command:

```ts [nuxt.config.ts]
export default defineNuxtConfig({
  modules: ['vite-hub/nuxt', 'vite-doctor/nuxt'],
})
```

```bash
pnpm nuxt prepare
pnpm nuxt doctor
```

The standalone `vite-doctor` CLI does not load `vite.config.ts`. To run the ViteHub rules from the CLI, register `vite-hub/doctor` in a Doctor config file:

```ts [doctor.config.ts]
import { defineDoctorConfig } from 'vite-doctor/config'
import vitehub from 'vite-hub/doctor'

export default defineDoctorConfig({ extensions: [vitehub] })
```

```bash
pnpm vite-doctor . --config doctor.config.ts
```

In a Nuxt app, `pnpm vite-doctor . --host-extensions` also loads the extension that `vite-hub/nuxt` registers.

| Code | Rule | Severity |
| --- | --- | --- |
| [`VHUB0001`](#vhub0001) | `vitehub/no-internal-imports` | Warning |
| [`VHUB0002`](#vhub0002) | `vitehub/no-server-imports-in-client` | Error |
| [`VHUB0003`](#vhub0003) | `vitehub/destructure-storage-results` | Warning |

## VHUB0001

**Import ViteHub through its public paths.** Rule `vitehub/no-internal-imports`.

Application code imports an internal ViteHub path or a generated file. These paths change without notice:

- `vite-hub/_internal/*` is for generated ViteHub code only.
- `@vite-hub/internal/*`, `@vite-hub/*/internal/*`, and `@vite-hub/*/_internal/*` are package implementation.
- `.vitehub/**` files are build output. ViteHub writes them again on each build.

```ts [server/api/settings.get.ts]
// Invalid
import { kv } from 'vite-hub/_internal/kv'
import { useServerEnv } from '../../.vitehub/env/server'

// Valid
import { kv } from 'vite-hub/kv'
import { useServerEnv } from '#vitehub/env/server'
```

[Import paths](/docs/reference/import-paths) lists every public path.

## VHUB0002

**Keep server-only ViteHub imports out of client code.** Rule `vitehub/no-server-imports-in-client`.

Client code imports a server-only path. ViteHub does not block these imports in client builds. The browser bundle can then include server code, provider bindings, and Server Env values.

The rule checks Vue components and, in Nuxt, files in `app/components`, `app/composables`, `app/layouts`, `app/middleware`, `app/pages`, `app/plugins`, `app/stores`, and `app/utils`. It does not check `import type`, files under a `server/` directory, or `*.server.*` files. It reports these paths:

- `#vitehub/env/server`, `vite-hub/env/secret`, and `@vite-hub/env/secret`
- `vite-hub/database/drizzle` and `@vite-hub/database/drizzle`
- every `vite-hub` or `@vite-hub/*` path with a `server` segment, for example `vite-hub/email/server` and `vite-hub/agent/server/github`

```vue [app/components/Issues.vue]
<!-- Invalid -->
<script setup lang="ts">
import { useServerEnv } from '#vitehub/env/server'

const { github } = useServerEnv()
</script>
```

Read server values in a server route. Read browser-safe values from Public Env:

```vue [app/components/AppName.vue]
<!-- Valid -->
<script setup lang="ts">
import { usePublicEnv } from '#vitehub/env/public'

const { appName } = usePublicEnv()
</script>
```

## VHUB0003

**Destructure KV and Blob results.** Rule `vitehub/destructure-storage-results`.

Every async `kv` and `blob` method returns an `[error, value]` tuple. It does not throw on provider failures. Code that uses the tuple as the value has two problems. A tuple is always truthy, so checks such as `if (await kv.has(key))` always pass. The error is lost.

The rule checks the `kv` and `blob` Runtime Helpers from `vite-hub/kv`, `vite-hub/blob`, `@vite-hub/kv`, and `@vite-hub/blob`, stores from `.store(name)`, and the helpers that Nuxt auto-imports into `server/`. It reports a result that code assigns to a name, tests in a condition, or reads a property from.

```ts [server/api/settings.get.ts]
import { kv } from 'vite-hub/kv'

export default defineEventHandler(async () => {
  // Invalid: `settings` is `[error, value]`.
  const settings = await kv.get('settings')
  return { settings }
})
```

```ts [server/api/settings.get.ts]
import { kv } from 'vite-hub/kv'

export default defineEventHandler(async () => {
  // Valid
  const [error, settings] = await kv.get('settings')
  if (error) throw error
  return { settings }
})
```

The rule accepts a statement that ignores the result, such as `await kv.set(key, value)`, and an index such as `(await blob.head(path))[0]`. Read [KV server API](/docs/kv/server-api) and [Blob server API](/docs/blob/server-api) for each method.

## Related

- [Import paths](/docs/reference/import-paths)
- [Errors and diagnostics](/docs/reference/errors-diagnostics)
- [Generated files](/docs/development/generated-files)
