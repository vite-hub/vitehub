---
title: Sandbox
description: Run named isolated work through an explicit Sandbox Provider boundary.
navigation.order: 12
icon: i-lucide-terminal-square
---

Sandbox owns isolated execution. Use it when named work should run away from the request process or when execution needs a provider-managed boundary.

Sandbox is not Shell. Sandbox owns isolated Sandbox Runs; Shell owns controlled Unix-like command sessions and Shell Observations.

## Quick start

::steps{level="3"}

### Install

```bash [Terminal]
pnpm add @vite-hub/sandbox
```

### Configure

```ts [vite.config.ts]
import { hubSandbox } from '@vite-hub/sandbox/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [hubSandbox()],
})
```

### Start using it

```ts [server/sandboxes/release-notes.ts]
import { defineSandbox } from '@vite-hub/sandbox'

export default defineSandbox(async (payload: { notes?: string } = {}) => {
  return { text: payload.notes?.toUpperCase() || 'No notes' }
})
```

```ts [server/api/release-notes.post.ts]
import { runSandbox } from '@vite-hub/sandbox'

export default defineEventHandler(async () => {
  return runSandbox('release-notes', { notes: 'ship it' })
})
```

::

## Public imports

| Import | Use |
| --- | --- |
| `defineSandbox` from `@vite-hub/sandbox` | Declare a Sandbox Definition. |
| `runSandbox` from `@vite-hub/sandbox` | Execute a named Sandbox Definition. |
| `defineDockerfileFragment` from `@vite-hub/sandbox/cloudflare` | Add Cloudflare-only build layers to the generated Sandbox image. |
| `hubSandbox` from `@vite-hub/sandbox/vite` | Register Sandbox discovery, generated types, and provider runtime wiring. |
| `@vite-hub/sandbox/runtime/providers/cloudflare` | Cloudflare runtime provider loader entry. |
| `@vite-hub/sandbox/runtime/providers/vercel` | Vercel runtime provider loader entry. |
| `@vite-hub/sandbox/sandbox/providers/cloudflare` | Cloudflare direct Sandbox client provider. |
| `@vite-hub/sandbox/sandbox/providers/vercel` | Vercel direct Sandbox client provider. |

Sandbox Definition, Provider, Execution Options, and Run Result types are exported from `@vite-hub/sandbox`.

When a Cloudflare build discovers exactly one Sandbox Definition, it can colocate static image layers beside that definition. Use `defineDockerfileFragment` as a top-level tagged template; ViteHub supplies the installed Cloudflare Sandbox base image and keeps this build-only statement out of the runtime bundle.

```ts [src/tools/image.sandbox.ts]
import { defineSandbox } from '@vite-hub/sandbox'
import { defineDockerfileFragment } from '@vite-hub/sandbox/cloudflare'

defineDockerfileFragment`
RUN apt-get update \
  && apt-get install -y imagemagick
`

export default defineSandbox(async () => null)
```

This surface belongs to Cloudflare's current app-level Sandbox image. Multiple definitions, interpolation, `FROM`, other hosts, and an application-owned container image are rejected instead of implying per-definition or provider-neutral image support.

## Configure the Vite Integration

```ts [vite.config.ts]
import { hubSandbox } from '@vite-hub/sandbox/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [hubSandbox()],
})
```

The Vite config key is `sandbox`.

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `sandbox: false` | `false` | enabled | Disables Sandbox discovery and provider runtime output. |
| `provider` | `SandboxProvider` | inferred from hosting | Selects `cloudflare` or `vercel`. Omit it only when hosting inference is enough. |
| `name` | `string` | package default | Shared provider resource name hint. |
| Cloudflare provider options | `CloudflareSandboxDefinitionProviderOptions` | `sandboxId`: URL-encoded Definition name; `sleepAfter`: `5m` | `binding`, `className`, `migrationTag`, `sandboxId`, `sleepAfter`, `keepAlive`, and `normalizeId`. |
| Vercel provider options | `VercelSandboxProviderOptions` | provider defaults | `runtime`, `timeout`, `cpu`, `ports`, `source`, `networkPolicy`, `token`, `teamId`, and `projectId`. |

Provider inference supports Cloudflare and Vercel hosting. Netlify cannot infer a Sandbox Provider; set `sandbox.provider` explicitly when a build target needs sandbox output.

Hosting inference is activated by discovered Sandbox Definitions. Definition-free consumers such as a Workspace using `runtime: 'sandbox'` must configure `sandbox.provider` explicitly so ViteHub knows to provision provider output.

## Providers

| Provider | Configure with | Provider output | Nuance |
| --- | --- | --- | --- |
| Cloudflare | Inferred from hosting or `sandbox: { provider: 'cloudflare' }` | Durable Object binding, migration, and runtime provider loader output. | Uses request environment bindings. `binding` defaults to `SANDBOX`; the URL-encoded Definition name defaults `sandboxId`; `sleepAfter` defaults to `5m`. |
| Vercel | `sandbox: { provider: 'vercel' }` | Vercel Sandbox runtime provider output. | Requires `@vercel/sandbox` at runtime. Supported runtimes are currently `node22` and `node24`. |

Cloudflare and Vercel expose different lifecycle, credential, network, and file behavior. Keep provider credentials in Server Env or provider configuration, not in Sandbox Payloads.

Cloudflare runs remain available until their idle timeout so later runs of the same Definition can reuse them. Each invocation removes its isolated temporary files on success or failure. Vercel runs are stopped immediately.

## Define sandbox work

Create a Sandbox Definition for work that can run through a Sandbox Provider.

```ts [server/sandboxes/release-notes.ts]
import { defineSandbox } from '@vite-hub/sandbox'

export default defineSandbox(async (payload: { notes?: string } = {}) => {
  return {
    text: payload.notes?.toUpperCase() || 'No notes',
  }
})
```

## Sandbox Definition options

`defineSandbox(handler, options?)` accepts these options. The discovered file name provides the Definition name.

| Option | Type | Description |
| --- | --- | --- |
| `timeout` | `number` | Runtime timeout in milliseconds when the provider supports ViteHub-side timeout enforcement. |
| `env` | `Record<string, string>` | Environment variables passed to the Sandbox Definition process. |
| `runtime.command` | `string` | Custom command used to launch the Sandbox Definition. |
| `runtime.args` | `string[]` | Arguments passed to `runtime.command`. |

The handler receives optional Sandbox Payload and optional `context` values supplied by Invocation Options.

## Run it at runtime

Use `runSandbox()` from server code.

```ts [server/api/release-notes.post.ts]
import { runSandbox } from '@vite-hub/sandbox'

export default defineEventHandler(async (event) => {
  return runSandbox('release-notes', await readBody(event), {
    sandboxId: 'release-notes-preview',
  })
})
```

The payload is Sandbox Payload. Provider reuse hints such as Sandbox Identity belong to Invocation Options, not to the portable Sandbox Definition identity.

## Invocation options

| Option | Type | Description |
| --- | --- | --- |
| `context` | `Record<string, unknown>` | Trusted runtime context passed as the handler second argument. |
| `sandboxId` | `string` | Provider sandbox identity or reuse hint for this run. |

`runSandbox()` returns a `SandboxRunResult`: `isOk()` results contain `value`, and `isErr()` results contain a normalized `SandboxError`.

## Pair it with Workspace

Use Workspace when isolated execution should operate on a file tree.

```ts [server/tasks/test-workspace.ts]
import { useWorkspace } from '@vite-hub/workspace'

export async function testWorkspace() {
  const session = await useWorkspace('docs', { mode: 'write' }).startSession()

  await session.exec('pnpm', ['test'])
  const diff = await session.diff()
  await session.close()

  return diff
}
```

Workspace owns files, rules, snapshots, diffs, and commit behavior. Sandbox owns the isolated provider execution boundary.

## Connect it to Agents

An Agent can execute isolated work only through an attached Sandbox Capability or through app-owned server behavior that you explicitly expose. Do not attach execution Capabilities casually.

Limit commands, inspect outputs, and prefer read-only Workspace access until the Agent has a real need to mutate files.

## Production boundaries

Sandbox execution can create cost, persistence, credential, and isolation concerns. Treat provider credentials as Server Env secrets and keep payloads free of raw secret material.

Use Shell when the app needs a controlled command session over a declared filesystem boundary. Use Sandbox when isolation and provider-managed execution are the main requirement.

## Next steps

- Use [Shell](/docs/server-primitives/shell) for controlled command sessions.
- Use [Workspace](/docs/server-primitives/workspace) for file-tree state.
- Expose execution to agents through [Official capabilities](/docs/capabilities/official-capabilities).
