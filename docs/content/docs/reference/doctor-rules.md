---
title: Doctor rules
description: Find ViteHub mistakes in application code with Vite Doctor, add the ViteHub rules, and read what each VHUB rule reports.
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

Some rules read the whole project, not only one file:

- [`VHUB0013`](#vhub0013), [`VHUB0014`](#vhub0014), [`VHUB0015`](#vhub0015), [`VHUB0020`](#vhub0020), and [`VHUB0022`](#vhub0022) read the Definitions that each ViteHub package discovers, with the same discovery code that the build uses. They use the server directories of the Nuxt layers that Doctor resolves, including `serverDir` and `extends`. Run `nuxt prepare` so Doctor can read them. Without it, they use `server/` or a literal `serverDir` in `nuxt.config`, and in a Nuxt app also the `server/` directory of each layer under `layers/`.
- [`VHUB0004`](#vhub0004) and [`VHUB0007`](#vhub0007) read the generated `.vitehub/env/description.mjs` to find secret and provider values. Run the dev server or a build once to generate it. Before that, these two rules report nothing.

| Code | Rule | Severity |
| --- | --- | --- |
| [`VHUB0001`](#vhub0001) | `vitehub/no-internal-imports` | Warning |
| [`VHUB0002`](#vhub0002) | `vitehub/no-server-imports-in-client` | Error |
| [`VHUB0003`](#vhub0003) | `vitehub/destructure-result-tuples` | Warning |
| [`VHUB0004`](#vhub0004) | `vitehub/unseal-secret-env` | Error |
| [`VHUB0005`](#vhub0005) | `vitehub/no-literal-credentials` | Error |
| [`VHUB0006`](#vhub0006) | `vitehub/await-async-helpers` | Error |
| [`VHUB0007`](#vhub0007) | `vitehub/load-provider-env` | Error |
| [`VHUB0008`](#vhub0008) | `vitehub/check-rate-limit-decision` | Error |
| [`VHUB0009`](#vhub0009) | `vitehub/rate-limiter-at-module-scope` | Error |
| [`VHUB0010`](#vhub0010) | `vitehub/auth-runtime-options` | Error |
| [`VHUB0011`](#vhub0011) | `vitehub/no-agent-connection-actor` | Error |
| [`VHUB0012`](#vhub0012) | `vitehub/no-nested-blob-reference-schema` | Error |
| [`VHUB0013`](#vhub0013) | `vitehub/known-definition-names` | Error |
| [`VHUB0014`](#vhub0014) | `vitehub/definition-default-export` | Error |
| [`VHUB0015`](#vhub0015) | `vitehub/definition-location` | Error |
| [`VHUB0016`](#vhub0016) | `vitehub/queue-payload-options` | Warning |
| [`VHUB0017`](#vhub0017) | `vitehub/no-module-scope-dispatch` | Warning |
| [`VHUB0018`](#vhub0018) | `vitehub/no-destructure-non-tuples` | Error |
| [`VHUB0019`](#vhub0019) | `vitehub/check-response-results` | Error |
| [`VHUB0020`](#vhub0020) | `vitehub/workflow-step-names` | Error |
| [`VHUB0021`](#vhub0021) | `vitehub/valid-schedule-cron` | Error |
| [`VHUB0022`](#vhub0022) | `vitehub/manual-schedule-run` | Error |
| [`VHUB0023`](#vhub0023) | `vitehub/valid-outbound-channel` | Error |
| [`VHUB0024`](#vhub0024) | `vitehub/realtime-carets` | Warning |
| [`VHUB0025`](#vhub0025) | `vitehub/realtime-persistence` | Error |
| [`VHUB0026`](#vhub0026) | `vitehub/forge-error-imports` | Warning |
| [`VHUB0027`](#vhub0027) | `vitehub/sandbox-runtime-options` | Error |
| [`VHUB0028`](#vhub0028) | `vitehub/define-agent-from-vite-hub` | Warning |
| [`VHUB0029`](#vhub0029) | `vitehub/rate-limit-capability-limiter` | Error |
| [`VHUB0030`](#vhub0030) | `vitehub/no-vitehub-plugin-in-nuxt` | Warning |
| [`VHUB0031`](#vhub0031) | `vitehub/valid-vitehub-options` | Warning |
| [`VHUB0032`](#vhub0032) | `vitehub/no-nuxthub-leftovers` | Warning |
| [`VHUB0033`](#vhub0033) | `vitehub/no-removed-apis` | Error |
| [`VHUB0034`](#vhub0034) | `vitehub/markdown-file-path` | Warning |
| [`VHUB0035`](#vhub0035) | `vitehub/comments-entry` | Error |

## VHUB0001

**Import ViteHub through its public paths.** Rule `vitehub/no-internal-imports`.

Application code imports an internal ViteHub path or a generated file. These paths change without notice:

- `vite-hub/_internal/*` is for generated ViteHub code only.
- `@vite-hub/internal/*`, `@vite-hub/*/internal/*`, and `@vite-hub/*/_internal/*` are package implementation.
- `.vitehub/**` and `.nuxt/vitehub/**` files are build output. ViteHub writes them again on each build.
- `#vitehub/*` aliases other than `#vitehub/env/public`, `#vitehub/env/server`, `#vitehub/auth/server`, `#vitehub/emails/<name>`, and `#vitehub/schedule/registry` are generated modules for ViteHub runtime code, for example `#vitehub/agent/registry`.

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

- `#vitehub/env/server` and `#vitehub/auth/server`
- every `vite-hub` or `@vite-hub/*` path with a `server` segment, for example `vite-hub/email/server` and `vite-hub/agent/server/github`
- package entries that load server runtime code, such as generated registries, Node.js built-ins, or `process.env`: `agent`, `agent/capabilities`, `agent/channels`, `agent/mcp`, `blob`, `browser` and its subpaths, `channels`, `comments`, `content`, `database/drizzle`, `env` and its server subpaths, `forge`, `gateways`, `kv`, `markdown-template/file`, `queue`, `rate-limit`, `sandbox`, `sandbox/ssh`, `sandbox/task`, `schedule/runtime` and its subpaths, `workflow`, `workspace`, and `workspace/runtime`

Each name is the path after `vite-hub/` or `@vite-hub/`. Browser entries such as `vite-hub/agent/vue`, `vite-hub/blob/vue`, `vite-hub/blob/client`, and `vite-hub/realtime/vue` are allowed.

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

**Destructure `[error, value]` results.** Rule `vitehub/destructure-result-tuples`.

Some Runtime Helpers return an `[error, value]` tuple and do not throw on failures. Code that uses the tuple as the value has two problems. A tuple is always truthy, so checks such as `if (await kv.has(key))` always pass. The error is lost.

The rule checks these calls:

- every async method of the `kv` and `blob` Runtime Helpers, of stores from `.store(name)`, and of `blob.media`
- `email.send()` from `vite-hub/email/server`
- `runQueue()`, `dynamicQueue.run()`, and `send()` and `sendBatch()` of a client from `getQueue()`
- `send()` of a Channel from `useChannel()` or `createChannel()`
- `callMcpTool()` from `vite-hub/agent/mcp`
- `runAgent(agent, input)` from `vite-hub/agent`, and `runAgent(agent, input, { output: 'drained' })`

It follows imports from `vite-hub/*` and `@vite-hub/*`, local aliases, and the helpers that Nuxt auto-imports into `server/`. It reports a result that code:

- assigns to a name
- tests in a condition, negates, or compares
- reads a property from, iterates with `for...of`, spreads, or puts in a template literal or object property
- returns from a route handler, so the client receives the tuple with status 200. A route handler is a function passed to `defineEventHandler()`, or the default export of a file under `api/`, `routes/`, or `middleware/` of an active server directory: `server/`, or the Nuxt `serverDir` of the app and its layers

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

The rule accepts a statement that ignores the result, such as `await kv.set(key, value)`, a pattern such as `const [error] = await kv.del(key)`, a name that code later indexes or destructures, an index such as `(await blob.head(path))[0]`, and a tuple that a helper function returns to its caller. `runAgent(agent, context, input)` with a Runtime Context returns the value and throws, so the rule does not check it. Read [KV server API](/docs/kv/server-api) and [Blob server API](/docs/blob/server-api) for each method.

## VHUB0004

**Call `.unseal()` before using a secret Server Env value.** Rule `vitehub/unseal-secret-env`.

A secret Server Env value is a `SecretEnv`. When code converts it to a string, the result is `<redacted>`. A request then sends `Bearer <redacted>`, and a comparison with the secret is always false. ViteHub does not report this at runtime.

The rule reads the secret paths from `.vitehub/env/description.mjs`, which ViteHub writes when Vite resolves the config, for example on `vite dev`, `vite build`, `nuxt dev`, or `nuxt build`. It does not run before that file exists. It checks values from `useServerEnv()` and `await loadServerEnv()` of `#vitehub/env/server`, and names destructured from them. It follows bindings, so a parameter or `catch` variable with the same name is not a secret. It reports a secret in a template literal, with `+`, `==`, or `!=`, compared with `===` or `!==` to a value, as an argument of `String()`, `JSON.stringify()`, `Buffer.from()`, `encodeURIComponent()`, `btoa()`, or `encode()`, and as a value in a `headers` object. It does not report a secret that goes into `console.*()` or a logger call such as `logger.info()`, where `<redacted>` is the intended output. It still reports a secret that another call uses first, as in `logger.info(await fetch(url, { headers }))`.

```ts [server/api/issues.get.ts]
import { useServerEnv } from '#vitehub/env/server'

export default defineEventHandler(async (event) => {
  const { github } = useServerEnv(event)
  // Invalid: sends `Bearer <redacted>`.
  return await fetch('https://api.github.com/issues', {
    headers: { Authorization: `Bearer ${github.token}` },
  })
})
```

```ts [server/api/issues.get.ts]
import { useServerEnv } from '#vitehub/env/server'

export default defineEventHandler(async (event) => {
  const { github } = useServerEnv(event)
  // Valid
  return await fetch('https://api.github.com/issues', {
    headers: { Authorization: `Bearer ${github.token.unseal()}` },
  })
})
```

The rule accepts a `SecretEnv` passed to a function, because the function can call `.unseal()`. Read [Server Env](/docs/env/server-api).

## VHUB0005

**Keep credentials out of source and build output.** Rule `vitehub/no-literal-credentials`.

A credential is written in source code, or a config file reads it when Vite loads the config. ViteHub writes the `env.server` registry and Email options into the generated server module, so these values are in the build output.

In `vite.config.*` and `nuxt.config.*`, the rule reports these items in `env.server`, including `vitehub.env.server` in Nuxt:

- a value or a `default` that reads `process.env` or `import.meta.env`
- a `default` on a declaration with `secret: true`
- a string literal for a key whose name ends in `secret`, `token`, `password`, `apiKey`, or `privateKey`

It also reports credential options of `hubEmail()` and of the `email` option that are string literals or `process.env` reads. In server code, it reports string literals for credential keys in `defineAuth()`, `google()` and `apiKey()` from `vite-hub/connections`, and the Gateway presets from `vite-hub/gateways`, including their `headers`.

```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { env } from '@vite-hub/env/vite'

export default defineConfig({
  env: {
    server: {
      // Invalid: the token is in the build output.
      githubToken: env({ secret: true, default: 'ghp_123' }),
      airtableToken: process.env.AIRTABLE_TOKEN,
    },
  },
})
```

```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { env } from '@vite-hub/env/vite'

export default defineConfig({
  env: {
    server: {
      // Valid
      githubToken: env({ secret: true, source: env.source('GITHUB_TOKEN') }),
      airtableToken: env({ secret: true, source: env.source('AIRTABLE_TOKEN') }),
    },
  },
})
```

The rule accepts literal values for other keys, such as `logLevel: 'info'`, and runtime reads in server code, such as `apiKey: () => tenant.key`. Read [Configure Env](/docs/env/configure).

## VHUB0006

**Await ViteHub guards and async Server Env helpers.** Rule `vitehub/await-async-helpers`.

`requireRateLimit()` and `checkRateLimit()` from `vite-hub/rate-limit` are async. Without `await`, the handler continues before the limit is checked, and a request over the limit is not stopped. `deriveSecret()` and `loadServerEnv()` from `#vitehub/env/server` return promises. Without `await`, code reads the promise, for example `[object Promise]` in a string.

The rule reports a guard used as a statement or as a condition without `await`. It reports `deriveSecret()` and `loadServerEnv()` in a string, a comparison, an object value, a destructuring pattern, or a property read. It reports a variable that holds the promise when later code reads it in one of these ways. Returning the promise or passing it to `Promise.all()` or `.then()` is fine.

```ts [server/api/upload.post.ts]
import { requireRateLimit } from 'vite-hub/rate-limit'

export default defineEventHandler(async (event) => {
  // Invalid: the handler does not wait for the check.
  requireRateLimit(event, 'upload', { limit: 10, window: '1m' })
})
```

```ts [server/api/upload.post.ts]
import { requireRateLimit } from 'vite-hub/rate-limit'

export default defineEventHandler(async (event) => {
  // Valid
  await requireRateLimit(event, 'upload', { limit: 10, window: '1m' })
})
```

The rule accepts a promise that the code returns, passes to a function, chains with `.then()`, or awaits later.

## VHUB0007

**Read provider-backed Server Env with `loadServerEnv()`.** Rule `vitehub/load-provider-env`.

A Server Env value with `source: env.provider(...)` comes from an Env provider, which reads it asynchronously. `useServerEnv()` is synchronous, so reading that value through it throws `ENV_ASYNC_REQUIRED` when the request runs.

The rule reads provider-backed paths from `.vitehub/env/description.mjs`. It does not run before ViteHub writes that file. It reports property reads and destructuring of those paths from `useServerEnv()`.

```ts [server/api/crm.get.ts]
import { useServerEnv } from '#vitehub/env/server'

export default defineEventHandler((event) => {
  // Invalid: `crm.key` comes from a provider.
  const { crm } = useServerEnv(event)
  return crm.key
})
```

```ts [server/api/crm.get.ts]
import { loadServerEnv } from '#vitehub/env/server'

export default defineEventHandler(async (event) => {
  // Valid
  const { crm } = await loadServerEnv(event)
  return crm.key
})
```

`useServerEnv()` stays correct for host and literal values. Read [Env providers](/docs/env/server-api).

## VHUB0008

**Check `decision.allowed` from a Rate Limit.** Rule `vitehub/check-rate-limit-decision`.

`checkRateLimit()` and the `consume()` method of a limiter from `createRateLimiter()` use a token and return a decision object. They do not stop the request. A decision object is always truthy, so `if (await checkRateLimit(...))` never sees a reached limit. A decision that the code ignores lets the operation run.

```ts [server/api/og.get.ts]
import { checkRateLimit } from 'vite-hub/rate-limit'

export default defineEventHandler(async (event) => {
  // Invalid: the decision is always truthy.
  if (!(await checkRateLimit(event, 'og', { limit: 10, window: '1m' }))) return
})
```

```ts [server/api/og.get.ts]
import { checkRateLimit } from 'vite-hub/rate-limit'

export default defineEventHandler(async (event) => {
  // Valid
  const decision = await checkRateLimit(event, 'og', { limit: 10, window: '1m' })
  if (!decision.allowed) return
})
```

Use `requireRateLimit()` when the request must fail with status 429. Read [Rate Limit server API](/docs/rate-limit/server-api).

## VHUB0009

**Create memory Rate Limiters once per module.** Rule `vitehub/rate-limiter-at-module-scope`.

`memoryRateLimitDriver()` keeps its counters in the driver object. A route handler that creates the driver creates new counters for each request, so the limit is never reached.

The rule reports `memoryRateLimitDriver()` from `@vite-hub/rate-limit/drivers/memory` inside a route handler: a function passed to `defineEventHandler()`, or the default export of a file under `api/`, `routes/`, or `middleware/` of an active server directory: `server/`, or the Nuxt `serverDir` of the app and its layers. It does not report a driver that the handler assigns to a name outside the handler, as in `limiter ??= createRateLimiter(...)`, and it does not check test files.

```ts [server/api/search.get.ts]
import { createRateLimiter } from 'vite-hub/rate-limit'
import { memoryRateLimitDriver } from '@vite-hub/rate-limit/drivers/memory'

export default defineEventHandler(async () => {
  // Invalid: every request gets new counters.
  const limiter = createRateLimiter({ driver: memoryRateLimitDriver(), limit: 10, window: '1m' })
  return await limiter.consume({ key: 'search' })
})
```

```ts [server/api/search.get.ts]
import { createRateLimiter } from 'vite-hub/rate-limit'
import { memoryRateLimitDriver } from '@vite-hub/rate-limit/drivers/memory'

// Valid
const limiter = createRateLimiter({ driver: memoryRateLimitDriver(), limit: 10, window: '1m' })

export default defineEventHandler(async () => await limiter.consume({ key: 'search' }))
```

## VHUB0010

**Resolve Auth runtime options in the `defineAuth()` callback.** Rule `vitehub/auth-runtime-options`.

`defineAuth()` resolves `baseURL`, `secret`, and `secrets` at runtime. The build accepts them in the static options object, then `defineAuth()` throws `AUTH_C0037` when the server loads the Auth Definition.

```ts [server/auth.ts]
import { defineAuth } from 'vite-hub/auth'

// Invalid
export default defineAuth({ baseURL: 'https://example.com', emailAndPassword: { enabled: true } })
```

```ts [server/auth.ts]
import { defineAuth } from 'vite-hub/auth'

// Valid
export default defineAuth(({ env, requestOrigin }) => ({
  baseURL: requestOrigin,
  secret: env.auth.secret.unseal(),
  emailAndPassword: { enabled: true },
}))
```

Read [Configure Auth](/docs/auth/configure).

## VHUB0011

**Do not claim an Agent actor in `useConnection()`.** Rule `vitehub/no-agent-connection-actor`.

Only the Agent runtime can act as an Agent. `useConnection(name, { actor: 'agent:…' })` throws `CONNECTIONS_INVALID_ACTOR` on its first call.

```ts [server/api/labels.get.ts]
import { useConnection } from 'vite-hub/connections/server'

// Invalid
export default defineEventHandler(() => useConnection('google', { actor: 'agent:labeller' }))
```

```ts [server/api/labels.get.ts]
import { useConnection } from 'vite-hub/connections/server'

// Valid
export default defineEventHandler(() => useConnection('google', { actor: 'schedule:gmail' }))
```

Give the Agent the Connection through its Connection Capability. Read [Connections server API](/docs/connections/server-api).

## VHUB0012

**Do not nest Blob reference schemas in Valibot objects.** Rule `vitehub/no-nested-blob-reference-schema`.

`image()` and `file()` from `vite-hub/blob` are Standard Schemas, not Valibot schemas. A Valibot object accepts them as entries, then fails when it parses a value.

The rule reports `image()` and `file()` as entries of `object()`, `looseObject()`, `strictObject()`, and `objectWithRest()` from `valibot`. It does not check Zod, because `z.object()` already throws when it gets one.

```ts [server/schemas.ts]
import * as v from 'valibot'
import { image } from 'vite-hub/blob'

// Invalid
export const post = v.object({ title: v.string(), cover: image() })
```

```ts [server/schemas.ts]
import { image } from 'vite-hub/blob'

// Valid
export const cover = image()
export const checkCover = (value: unknown) => cover['~standard'].validate(value)
```

Read [Blob server API](/docs/blob/server-api#use-with-other-schema-libraries).

## VHUB0013

**Use the name of a discovered Definition.** Rule `vitehub/known-definition-names`.

A Runtime Helper gets a literal name that matches no Definition that ViteHub discovers. The call fails only when it runs, for example with `QUEUE_DEFINITION_NOT_FOUND`.

The rule checks the first argument of `runQueue()`, `deferQueue()`, `getQueue()`, `runWorkflow()`, `deferWorkflow()`, `getWorkflowRun()`, `cancelWorkflow()`, `useDatabase()`, `useChannel()`, `runBrowser()`, `runSandboxTask()`, `runSchedule()`, `useConnection()`, and `useAgent()` from `vite-hub/agent/vue`. Workflow names include Agents that run as Workflows, and Workflows that the same file registers with `createWorkflow(name, handler)`, `createWorkflow({ name, handler })`, or an Agent `runtime: workflow(name)`. `useDatabase('default')` is always accepted. The rule does not check `runSchedule(name, { registry })`, which reads its own registry, and it does not see Workflows that another file registers with `createWorkflow()`.

```ts [server/api/signup.post.ts]
import { runQueue } from 'vite-hub/queue'

// Invalid: the file is server/queues/welcome-email.ts
await runQueue('welcom-email', { email })

// Valid
await runQueue('welcome-email', { email })
```

Doctor runs the discovery of each owner package. It does not check a kind that has no Definition files, because plugins can contribute Definitions that Doctor cannot see. It does not check names that are not string literals.

## VHUB0014

**Default-export each discovered Definition.** Rule `vitehub/definition-default-export`.

ViteHub discovers every source file in a Definition directory, such as `server/queues/`, `server/workflows/`, `server/schedules/`, `server/agents/`, or `server/connections/`. A file without a default export still becomes a Definition, and it fails when it is used. The rule also checks the numbered step files of a folder Workflow, because the Workflow calls their default export.

```ts [server/queues/utils.ts]
// Invalid: ViteHub discovers this helper as the `utils` Queue.
export function formatEmail(email: string) {
  return email.trim()
}
```

Move helpers out of the Definition directory, for example to `server/utils/`, and default-export each Definition:

```ts [server/queues/welcome-email.ts]
// Valid
import { defineQueue } from 'vite-hub/queue'

export default defineQueue(async ({ payload }) => {})
```

## VHUB0015

**Put each Definition where ViteHub discovers it.** Rule `vitehub/definition-location`.

A file default-exports `defineQueue()`, `defineWorkflow()`, `defineSchedule()`, `defineBrowser()`, `defineRealtime()`, `defineOutboundChannel()`, `defineAgent()`, `defineConnection()`, or `defineSandboxTask()`, but ViteHub does not discover the file. The Definition is never registered: a Schedule never runs, and calls by name fail.

A discovered file can re-export a Definition from another module, as in `export { default } from '../utils/email-queue'`. The rule does not report that module.

```ts [server/utils/report.ts]
// Invalid: ViteHub does not scan server/utils/.
import { defineSchedule } from 'vite-hub/schedule'

export default defineSchedule({ cron: '0 8 * * *', handler })
```

```ts [server/schedules/report.ts]
// Valid
import { defineSchedule } from 'vite-hub/schedule'

export default defineSchedule({ cron: '0 8 * * *', handler })
```

An Agent can extend an Agent from any file, so the rule checks `defineAgent()` only in files under an `agents/` directory or with an `.agent.ts` suffix. [Definition discovery](/docs/development/definition-discovery) lists each convention.

## VHUB0016

**Pass Queue options as the third argument.** Rule `vitehub/queue-payload-options`.

`runQueue()`, `deferQueue()`, `dynamicQueue.run()`, and `dynamicQueue.defer()` take the payload and the options as separate arguments. ViteHub does not read enqueue options from the payload. A call that wraps the payload with `delaySeconds`, `idempotencyKey`, `retentionSeconds`, or `contentType` sends the whole object as the payload, and the options have no effect.

```ts [server/api/signup.post.ts]
import { runQueue } from 'vite-hub/queue'

// Invalid
await runQueue('welcome-email', { payload: { email }, delaySeconds: 60 })

// Valid
await runQueue('welcome-email', { email }, { delaySeconds: 60 })
```

The rule accepts a payload with a `payload` field and no option keys, because that is application data.

## VHUB0017

**Dispatch jobs inside a request.** Rule `vitehub/no-module-scope-dispatch`.

`runQueue()`, `deferQueue()`, `getQueue()`, `runWorkflow()`, `deferWorkflow()`, `runSandboxTask()`, and `runBrowser()` run at module scope. The call runs once when the module loads, outside a request. ViteHub reads host bindings and `waitUntil` from the active request, so the call can fail or the job can be dropped on Cloudflare and Vercel.

```ts [server/plugins/warmup.ts]
import { runQueue } from 'vite-hub/queue'

// Invalid
await runQueue('warmup', {})
```

```ts [server/api/warmup.post.ts]
import { runQueue } from 'vite-hub/queue'

// Valid
export default defineEventHandler(async () => {
  const [error] = await runQueue('warmup', {})
  if (error) throw error
})
```

The rule does not check test files.

## VHUB0018

**Do not destructure results that are not tuples.** Rule `vitehub/no-destructure-non-tuples`.

Code destructures `[error, value]` from an API that does not return a tuple. These APIs return their value and throw on failure: `runWorkflow()`, `deferWorkflow()`, `getWorkflowRun()`, `cancelWorkflow()`, `resumeWorkflowSignal()`, and `getQueue()`. `runSchedule()` returns a Schedule Run record: a failed handler resolves with `status: "failed"`. `runSandboxTask()` and `runBrowser()` return a Web `Response`, which is not iterable.

```ts [server/api/onboard.post.ts]
import { runWorkflow } from 'vite-hub/workflow'

// Invalid
const [error, run] = await runWorkflow('onboard-user', body)

// Valid
const run = await runWorkflow('onboard-user', body)
```

The rule does not check `runAgent()`. Its tuple forms are tuples, and `runAgent(agent, context, input)` returns the Agent's output, which can be an array.

## VHUB0019

**Read Sandbox Task and Browser results as a Response.** Rule `vitehub/check-response-results`.

`runSandboxTask()` and `runBrowser()` return a Web `Response`. A failed run returns a `Response` with an error status, not your data. Code that reads a data field from the response gets `undefined`.

```ts [server/api/resize.post.ts]
import { runSandboxTask } from 'vite-hub/sandbox/task'

// Invalid
const { width } = await runSandboxTask('resize', payload)
```

```ts [server/api/resize.post.ts]
import { runSandboxTask } from 'vite-hub/sandbox/task'

// Valid
const response = await runSandboxTask('resize', payload)
if (!response.ok) throw new Error(await response.text())
const { width } = await response.json()
```

The rule reports property reads and object destructuring that use a name that is not a `Response` property.

## VHUB0020

**Call folder Workflow steps by their file names.** Rule `vitehub/workflow-step-names`.

In a folder Workflow, each numbered file is a step. ViteHub removes the number prefix and converts the rest to camelCase: `01.send-email.ts` becomes `steps.sendEmail`. The rule reports `steps.<name>` in `index.ts` that matches no step file, and step files that become the same property or an empty one. A folder Workflow without `index.ts` gets the step file reports on each step file. These errors appear only when the Workflow runs.

```ts [server/workflows/onboard-user/index.ts]
import { defineWorkflow } from 'vite-hub/workflow'

// The folder has 01.create-user.ts and 02.send-welcome.ts.
export default defineWorkflow(async ({ payload, steps }) => {
  const user = await steps.createUser(payload)
  // Invalid: there is no send-welcome-email step file.
  return await steps.sendWelcomeEmail(user)
  // Valid
  // return await steps.sendWelcome(user)
})
```

## VHUB0021

**Use a valid portable cron expression.** Rule `vitehub/valid-schedule-cron`.

`defineSchedule()` checks only that the cron has five fields. The rule checks a literal cron in `defineSchedule({ cron })` or `defineSchedule(cron, handler)`:

- each value is in its range: minute 0-59, hour 0-23, day of month 1-31, month 1-12, day of week 0-7
- ranges do not run backwards, and steps are positive numbers

The rule does not report names such as `MON` or a cron that sets both day fields. The process runtime accepts them, and the build for Cloudflare, Vercel, or Netlify rejects them with `SCHEDULE_R0003`.

```ts [server/schedules/digest.ts]
import { defineSchedule } from 'vite-hub/schedule'

// Invalid: the hour 24 is outside 0-23.
export default defineSchedule({ cron: '0 24 * * 1', handler })

// Valid
export default defineSchedule({ cron: '0 8 * * 1', handler })
```

## VHUB0022

**Run only manual Schedules by name.** Rule `vitehub/manual-schedule-run`.

`runSchedule(name)` from `vite-hub/schedule/runtime` runs only a Schedule that sets `manual: true`. Other Schedules throw `SCHEDULE_MANUAL_RUN_DISABLED` when the call runs.

```ts [server/api/report.post.ts]
import { runSchedule } from 'vite-hub/schedule/runtime'

// Invalid: server/schedules/report.ts does not set manual: true.
export default defineEventHandler(() => runSchedule('report'))
```

```ts [server/schedules/report.ts]
// Valid
import { defineSchedule } from 'vite-hub/schedule'

export default defineSchedule({ cron: '0 8 * * *', manual: true, handler })
```

## VHUB0023

**Configure each outbound Channel connector.** Rule `vitehub/valid-outbound-channel`.

`defineOutboundChannel()` throws when its module loads if `connectors` is empty (`CHANNELS_C0003`), a connector has no `send` function (`CHANNELS_C0004`), or `defaultConnector` is not a connector name (`CHANNELS_C0005`). The registry loads the module on the first `send()`, so the error appears as a returned error at that moment. The rule reports these mistakes in object literals.

```ts [server/channels/alerts.ts]
import { defineOutboundChannel } from 'vite-hub/channels'

// Invalid
export default defineOutboundChannel({
  connectors: { slack: { url: 'https://hooks.slack.com/...' } },
  defaultConnector: 'email',
})
```

```ts [server/channels/alerts.ts]
import { defineOutboundChannel } from 'vite-hub/channels'

// Valid
export default defineOutboundChannel({
  connectors: { slack: { send: async text => sendToSlack(text) } },
  defaultConnector: 'slack',
})
```

The rule does not check connectors that a call or a spread creates.

## VHUB0024

**Use the Realtime carets option instead of CollaborationCaret.** Rule `vitehub/realtime-carets`.

A file imports `@tiptap/extension-collaboration-caret` in an app that uses ViteHub Realtime. That extension has its own copy of y-tiptap. It cannot find the sync plugin that Realtime installs, so it draws nothing. `realtime.extensions` already draws the carets of other people.

```vue [app/components/Editor.vue]
<!-- Invalid -->
<script setup lang="ts">
import CollaborationCaret from '@tiptap/extension-collaboration-caret'
import { useRealtimeTiptap } from 'vite-hub/realtime/vue'
</script>
```

```vue [app/components/Editor.vue]
<!-- Valid -->
<script setup lang="ts">
import { useRealtimeTiptap } from 'vite-hub/realtime/vue'

const realtime = useRealtimeTiptap('notes', id, {
  carets: { render: user => renderCaret(user) },
})
</script>
```

The rule checks files that import a `vite-hub/realtime` path at runtime, not only types, so an editor that ViteHub Realtime does not sync can keep the extension. Read [Carets](/docs/realtime/server-api#carets).

## VHUB0025

**Give Realtime persistence valid timings.** Rule `vitehub/realtime-persistence`.

`defineRealtime({ persistence })` has a `maxWait` that is less than `debounce`, or a timing that is not a number of milliseconds of 0 or more. Realtime throws `REALTIME_INVALID_PERSISTENCE` when the first room opens. An unset value uses its default: `debounce` 2000 ms and `maxWait` 10000 ms. So `debounce: 20000` alone is also invalid.

```ts [server/realtime/notes.ts]
// Invalid
export default defineRealtime({
  document: { workspace: 'docs' },
  persistence: { debounce: 5000, maxWait: 1000 },
})
```

```ts [server/realtime/notes.ts]
// Valid
export default defineRealtime({
  document: { workspace: 'docs' },
  persistence: { debounce: 500, maxWait: 5000 },
})
```

The rule reads number literals only. It does not check values from variables or a spread.

## VHUB0026

**Import Forge error classes from `@vite-hub/forge`.** Rule `vitehub/forge-error-imports`.

An app that depends on `@vite-hub/forge` imports `NotFoundError`, `ForgeApiError`, `ForgeTimeoutError`, `MergeBlockedError`, `RateLimitedError`, or `BranchMovedError` from `forges`. `@vite-hub/forge` bundles its own copy of these classes, and `forgeProvider()` throws that copy. An `instanceof` check against the `forges` class is always false.

```ts [server/utils/pull-request.ts]
// Invalid
import { NotFoundError } from 'forges'

// Valid
import { NotFoundError } from '@vite-hub/forge'
```

The rule does not report `import type`.

## VHUB0027

**Give Sandbox definitions a valid runtime.** Rule `vitehub/sandbox-runtime-options`.

A literal Sandbox definition in `resolveSandbox()` or in the `sandbox` option of `defineAgent()` fails on each call:

- `runtime: 'cloudflare'` as a string. Cloudflare needs its Durable Objects namespace, so it has only the tagged form. Other unknown runtime names fail too (`SANDBOX_R0031`).
- `runtime: { kind }` with a kind other than `crabbox`, `trusted-host`, `cloudflare`, or `vercel` (`SANDBOX_R0033`).
- Both `cwd` and `checkout` (`SANDBOX_R0035`).
- The `crabbox` runtime without `cwd` or `checkout` (`SANDBOX_R0091`).

```ts [server/utils/sandbox.ts]
// Invalid
const sandbox = await resolveSandbox({ runtime: 'cloudflare' }, {})

// Valid
const sandbox = await resolveSandbox({
  runtime: { kind: 'cloudflare', namespace: env.SANDBOX },
}, {})
```

The rule skips a definition with a spread, and runtimes from variables. Read [Sandbox](/docs/sandbox).

## VHUB0028

**Import `defineAgent` from `vite-hub/agent`.** Rule `vitehub/define-agent-from-vite-hub`.

An app that depends on `vite-hub` imports `defineAgent` from the owner package `@vite-hub/agent`. That version does not apply the app-wide `agent.invocations` journal or the Console journal, so ViteHub does not record Invocations of the Agent. A string `invocations` setting, such as `'database'`, also fails when the module loads.

```ts [server/agents/support.ts]
// Invalid
import { defineAgent } from '@vite-hub/agent'

// Valid
import { defineAgent } from 'vite-hub/agent'
```

The rule reads the dependencies in the project `package.json`. It does not report `import type`.

## VHUB0029

**Give the `rateLimit` Capability a limiter.** Rule `vitehub/rate-limit-capability-limiter`.

`rateLimit()` from `vite-hub/agent/capabilities` has no `limiter`. The inline `limit`, `window`, and `store` options were removed. The Capability throws `AGENT_R0162` on the first Invocation.

```ts [server/agents/support.ts]
// Invalid
capabilities: [rateLimit({ limit: 20, window: '1m' })]
```

```ts [server/agents/support.ts]
// Valid
import { createRateLimiter } from '@vite-hub/rate-limit'
import { memoryRateLimitDriver } from '@vite-hub/rate-limit/drivers/memory'

const limiter = createRateLimiter({ driver: memoryRateLimitDriver(), limit: 20, window: '1m' })

capabilities: [rateLimit({ limiter })]
```

The rule skips options from a variable or a spread.

## VHUB0030

**Configure ViteHub in Nuxt through the module only.** Rule `vitehub/no-vitehub-plugin-in-nuxt`.

`nuxt.config.ts` lists `vite-hub/nuxt` in `modules` and also calls `vitehub()` in `vite.plugins`. The module installs the `vitehub()` plugins itself, but it keeps a plugin from `vite.plugins` with the same name in place of its own. The options of that `vitehub()` call then silently replace the module options.

```ts [nuxt.config.ts]
// Invalid
export default defineNuxtConfig({
  modules: ['vite-hub/nuxt'],
  vite: { plugins: [vitehub({ preset: 'node' })] },
})

// Valid
export default defineNuxtConfig({
  modules: ['vite-hub/nuxt'],
  vitehub: { preset: 'node' },
})
```

Plugins that add Database tables, such as `hubDb()`, can stay in `vite.plugins`.

## VHUB0031

**Use ViteHub options that take effect.** Rule `vitehub/valid-vitehub-options`.

The `vitehub()` options in `vite.config.ts`, or the `vitehub` key and inline `vite-hub/nuxt` options in `nuxt.config.ts`, have a value that ViteHub ignores or rejects later:

- `sandbox` was renamed to `sandboxTask`.
- `devtools` was removed with the browser DevTools.
- `sandboxTask: { ... }` turns Sandbox Tasks off. ViteHub turns them on only for `true`.
- `queue: { ... }` ignores its fields. The preset selects the Queue provider.
- In Vite, `vitehub({ env: { server, public, define } })` ignores these sections. They belong to the top-level `env` key of the Vite config.
- In Nuxt, `connections` is not supported yet. `nuxt dev` runs, but `nuxt build` fails with `VITE_HUB_B0012`.

```ts [vite.config.ts]
// Invalid
export default defineConfig({
  plugins: [vitehub({ preset: 'vercel', env: { server: { token: env({ secret: true }) } } })],
})

// Valid
export default defineConfig({
  env: { server: { token: env({ secret: true }) } },
  plugins: [vitehub({ preset: 'vercel' })],
})
```

Read [Config options](/docs/reference/config-options).

## VHUB0032

**Finish the move from NuxtHub.** Rule `vitehub/no-nuxthub-leftovers`.

An app that uses ViteHub still has NuxtHub parts:

- `@nuxthub/core` in `modules` of `nuxt.config.ts`. NuxtHub and ViteHub both register `kv`, `blob`, and database helpers.
- A `hub` key in `nuxt.config.ts`. `vite-hub/nuxt` does not read it, so these features stay off.
- `hub:db`, `hub:kv`, `hub:blob`, or `@nuxthub/*` imports.

```ts [nuxt.config.ts]
// Invalid
export default defineNuxtConfig({
  modules: ['vite-hub/nuxt'],
  hub: { kv: true },
})

// Valid
export default defineNuxtConfig({
  modules: ['vite-hub/nuxt'],
  vitehub: { preset: 'node', kv: true },
})
```

The rule runs when `package.json` lists `vite-hub` or `nuxt.config.ts` lists `vite-hub/nuxt`. Read [Migrate from NuxtHub](/docs/getting-started/migrate-from-nuxthub).

## VHUB0033

**Replace removed ViteHub APIs.** Rule `vitehub/no-removed-apis`.

Code uses a ViteHub API that a release removed or renamed:

| Removed | Use |
| --- | --- |
| `vite-hub/box` | `vite-hub/sandbox` |
| `vite-hub/sandbox-task`, `@vite-hub/sandbox-task` | `vite-hub/sandbox/task`, `@vite-hub/sandbox/task` |
| `vite-hub/content/presets/cms`, `@vite-hub/content/presets/cms` | `vite-hub/cms`, `@vite-hub/cms` |
| `vite-hub/schedule/runtime/driver` | `defineSchedule()` in `server/schedules/` |
| `cost()` from `vite-hub/agent/capabilities` | `usage()` |
| `gmail({ mode })` | `gmail({ operations })` |
| `documents({ route })` | `documents({ url })` |
| `AgentChat`, `AgentChatMessage`, `AgentChatPrompt`, `AgentSession`, `AgentMarkdown` from `@vite-hub/ui` | `Chat`, `ChatMessage`, `PromptInput`, `ChatSession`, `Markdown` |
| `AgentCodeView`, `AgentFile`, `AgentFileDiff`, `AgentMultiFileDiff`, `AgentPatchDiff`, `AgentUnresolvedFile` | `CodeView`, `FileView`, `FileDiff`, `MultiFileDiff`, `PatchDiff`, `UnresolvedFile` |
| `AgentFileTree`, `useAgentFileTree`, `useAgentFileTreeSelection`, `AgentToolList`, `AgentTrace` | `FileTree`, `useFileTree`, `useFileTreeSelection`, `ToolList`, `TraceRun` |

A removed import fails the build without the replacement. The `mode` and `route` options fail silently: `gmail()` keeps only the `search` and `read` tools, and document URLs fall back to the document id.

```ts [server/agents/inbox.ts]
// Invalid
capabilities: [gmail({ mode: 'draft' })]

// Valid
capabilities: [gmail({ operations: ['search', 'read', 'draft'] })]
```

The rule checks script imports. It does not check component tags in templates.

## VHUB0034

**Pass `renderMarkdownFile()` a path that does not depend on the working directory.** Rule `vitehub/markdown-file-path`.

`renderMarkdownFile()` gets a relative string path such as `'./reply.md'`. Node resolves it from the working directory of the process, not from the file that calls it. The call reads a different file, or none, when the server starts in another directory. Deployed bundles do not include the Markdown file.

```ts [server/agents/review/agent.ts]
// Invalid
const prompt = await renderMarkdownFile('./reply.md')

// Valid
import renderReply from './reply.template.md'

const prompt = await renderReply({ pullRequest })
```

To read the file at runtime, pass `new URL('./reply.md', import.meta.url)`. Read [Markdown templates](/docs/reference/markdown-templates).

## VHUB0035

**Export the live Comments API as `comments`.** Rule `vitehub/comments-entry`.

ViteHub reads `server/comments.ts` without running it. A default export selects Comment operations, and only a named `comments` export installs the live-site API. The rule reports:

- A default export next to `export const comments`. ViteHub never installs the live API.
- `defineComments()` exported under another name, with no default export. The entry selects Comment operations.
- A `database` option that is not a string literal, in the live-site form. ViteHub then stores Comments in the default Database.

```ts [server/comments.ts]
// Invalid
export const threads = defineComments({ database: DATABASE_NAME })

// Valid
export const comments = defineComments({ database: 'analytics' })
```

Read [Comments server API](/docs/comments/server-api).

## Related

- [Import paths](/docs/reference/import-paths)
- [Errors and diagnostics](/docs/reference/errors-diagnostics)
- [Generated files](/docs/development/generated-files)
