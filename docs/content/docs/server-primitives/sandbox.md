---
title: Sandbox
description: Run named package projects in an isolated Cloudflare or Vercel Sandbox.
navigation.order: 12
navigation.group: Files and execution
icon: i-lucide-terminal-square
---

Use a Sandbox Definition to run a named package project in an isolated Box. The package supplies the code and dependencies. The Box provider (Cloudflare Sandbox or Vercel Sandbox) runs the process. Server code calls the Definition by name and gets a native Web `Response`.

Use Sandbox when work needs its own dependencies, a real filesystem, or child processes that must not run in your server process. Sandbox works without Agents.

::tip
- [Workspace](/docs/server-primitives/workspace) stores durable files and handles Sources, snapshots, diffs, commits, and rollbacks.
- [Source](/docs/server-primitives/source) reads content from an external location. It does not run code.
- Sandbox discovers Definitions, prepares package projects, serializes values, applies timeouts, and coordinates each run.
- [Shell](/docs/server-primitives/shell) runs Unix-like commands with a declared policy through a Shell provider.
- [Box](/docs/agents/boxes) provides process isolation, runtime files, caches, ports, and provider-specific deployment output. Sandbox runs on a Box. Workspace never selects a Box provider.
::

## Quick start

::steps{level="3"}

### Install

Install Sandbox and the provider package for your deployment. This example uses Vercel Sandbox:

```bash [Terminal]
pnpm add @vite-hub/sandbox @vercel/sandbox
```

For Cloudflare, install `@cloudflare/sandbox` instead. Sandbox requires Node.js 24 or newer.

### Configure

```ts [vite.config.ts]
import { hubSandbox } from '@vite-hub/sandbox/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [hubSandbox({ provider: 'vercel' })],
})
```

With the `vite-hub` distribution, set `sandbox: true`. The `cloudflare` and `vercel` presets select the matching provider:

```ts [vite.config.ts]
import { vitehub } from 'vite-hub'

export default {
  plugins: vitehub({ preset: 'vercel', sandbox: true }),
}
```

### Start using it

Every discovered Definition belongs to a real package project. ViteHub never writes a manifest into your repository, so create the smallest valid one:

```json [server/sandboxes/release-notes/package.json]
{
  "private": true,
  "type": "module",
  "vitehub": {
    "sandbox": {
      "timeout": 30000
    }
  }
}
```

```ts [server/sandboxes/release-notes/index.ts]
interface SandboxPayload {
  notes?: string
}

export default async function releaseNotes(payload: SandboxPayload = {}) {
  return { text: payload.notes?.toUpperCase() || 'No notes' }
}
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
| `runSandbox` from `@vite-hub/sandbox` | Invoke a discovered Definition by name. Returns a native `Response`. |
| `defineSandbox` from `@vite-hub/sandbox` | Declare a free-form `<path>.sandbox.ts` Definition. |
| `resolveSandboxRunner` from `@vite-hub/sandbox` | Resolve a runner and read its `executionAuthority` before execution. |
| `readRequestPayload`, `readValidatedPayload` from `@vite-hub/sandbox` | Read a request body, then validate it with a Standard Schema or a validation function. |
| `hubSandbox` from `@vite-hub/sandbox/vite` | Register discovery, types, package preparation, and Provider Output. |

Applications that use the `vite-hub` distribution import the same runtime APIs from `vite-hub/sandbox`.

## Package projects

Under `server/sandboxes`, use one folder per package project with an adjacent `package.json` and an `index.ts`, `index.mts`, `index.js`, or `index.mjs` entrypoint. The folder path supplies the Definition name. Other files in the package are ordinary helpers, not separate Sandboxes.

```text
server/sandboxes/
├── image/
│   ├── package.json
│   └── index.ts
└── metadata/
    ├── package.json
    └── index.ts
```

ViteHub selects the package manager from the manifest's `packageManager` field, then a lockfile at that package root, then npm. A nested independent package never inherits an unrelated ancestor lockfile. Lockfiles enable frozen installation. ViteHub installs the project inside the Box before the entrypoint starts. Installed dependencies are not written back to your repository.

ViteHub also understands a standard pnpm Workspace without ViteHub-specific configuration:

```text
server/sandboxes/
├── package.json
├── pnpm-lock.yaml
├── pnpm-workspace.yaml
└── image/
    ├── package.json
    └── index.ts
```

Installation runs at the pnpm Workspace root, and the Definition runs from `server/sandboxes/image`. ViteHub carries every local package in the transitive `workspace:*` dependency closure. pnpm stays responsible for installation and linking. Other Workspace packages stay outside the runtime project.

Package entrypoints are ESM projects. Keep `"type": "module"` and use explicit relative ESM imports for local `.ts` and `.mts` files. ViteHub compiles reachable local TypeScript without bundling package dependencies. It rejects CommonJS, local package aliases and self-references, imports that escape the package, and Workspace dependencies that expose TypeScript runtime entries.

### Free-form Definitions

Outside `server/sandboxes`, name a file `<path>.sandbox.ts` (or `.mts`, `.cts`, `.js`, `.mjs`, `.cjs`) and default-export `defineSandbox()`. A free-form Definition uses its nearest `package.json`, so several files can share one package project.

```ts [server/tools/resize.sandbox.ts]
import { defineSandbox } from '@vite-hub/sandbox'

export default defineSandbox({
  timeout: 60000,
  run: async (payload: { width: number }) => ({ width: payload.width }),
})
```

## Definition options

| Option | Where | Type | Description |
| --- | --- | --- | --- |
| `vitehub.sandbox.timeout` | `package.json` | `number` | Timeout for one execution attempt in milliseconds. This is the only supported manifest key. |
| `run` | `defineSandbox()` | `function` | Required handler. Called with `(payload, context)`. |
| `timeout` | `defineSandbox()` | `number` | Timeout for one execution attempt in milliseconds. |
| `env` | `defineSandbox()` | `Record<string, string>` | Environment variables for the run. |
| `project` | `defineSandbox()` | `boolean` | Force package-project packaging on or off. Omit it to detect project use. |

Each timeout must be a positive integer no greater than `2_147_483_647`. `defineSandbox()` options must be static JSON values because ViteHub reads them at build time.

## Package entry point

The package `index.ts` default-exports an ordinary async function. ViteHub calls it with the invocation payload and context, then returns its awaited result. The entrypoint does not import `@vite-hub/sandbox`.

```ts [server/sandboxes/image/index.ts]
export default async function optimize(
  payload: { image: Blob },
  context: { requestId: string },
) {
  return await optimizeImage(payload.image, context.requestId)
}
```

The entrypoint gets normal JavaScript, package imports, top-level await, `process.cwd()`, environment variables, and a filesystem, without a runtime framework import.

## Run a Sandbox

`runSandbox(name, payload?, options?)` infers its payload type from the default function and returns a native Web `Response`. A zero-argument function accepts an `unknown` payload.

```ts [server/api/release-notes-json.post.ts]
import { runSandbox } from '@vite-hub/sandbox'

export default defineEventHandler(async () => {
  const response = await runSandbox('release-notes', { notes: 'ship it' }, {
    context: { requestId: 'release-notes-42' },
  })
  if (!response.ok)
    throw new Error(await response.text())
  return await response.json()
})
```

| Option | Type | Description |
| --- | --- | --- |
| `context` | `Record<string, unknown>` | Second argument passed to the entrypoint. |
| `sandboxId` | `string` | Cloudflare only. Reuse a named Box instead of a new Box for each run. |

Payloads, context, and results use JSON serialization. Nested `Blob` and `Uint8Array` values cross the Box boundary through invocation-local Box files, so you do not convert them to base64. Node.js `Buffer` values keep their `Buffer` type.

Failures, including timeouts and cleanup failures, return a non-2xx JSON `Response`. A timed-out attempt returns the `SANDBOX_TIMEOUT` code.

## Providers

Provider selection belongs to application or host configuration, not to a Definition.

| Provider | Configure with | Host support |
| --- | --- | --- |
| Vercel Sandbox | `hubSandbox({ provider: 'vercel' })` or the `vercel` preset | Vercel. Other hosts, such as Netlify, when Vercel credentials are set. |
| Cloudflare Sandbox | `hubSandbox({ provider: 'cloudflare' })` or the `cloudflare` preset | Cloudflare Workers with the generated Container and Durable Object binding. |

The `deno`, `netlify`, and `node` presets have no built-in Sandbox provider, so `vitehub({ preset, sandbox: true })` fails during configuration for them. Without an explicit `provider`, the runtime detects Cloudflare or Vercel from the environment. Both providers run remote, potentially billed infrastructure. Sandbox has no local in-process provider.

### Vercel options

| Option | Default | Description |
| --- | --- | --- |
| `runtime` | `'node24'` | Vercel Sandbox runtime image. |
| `timeout` | - | Provider session timeout in milliseconds. A Definition timeout takes priority. |
| `cpu` | - | vCPU count. |
| `ports` | - | Ports to expose. |
| `source` | - | Source to load into the Box. |
| `networkPolicy` | - | Network policy for the Box. |
| `token`, `teamId`, `projectId` | - | Credentials. Otherwise, set `VERCEL_TOKEN`, `VERCEL_TEAM_ID`, and `VERCEL_PROJECT_ID`, or use the project environment. |

### Cloudflare options

| Option | Default | Description |
| --- | --- | --- |
| `binding` | `'SANDBOX'` | Durable Object binding name. |
| `className` | `'Sandbox'` | Exported Durable Object class name. |
| `migrationTag` | `'v1'` | Wrangler migration tag for the class. Must be unique. |
| `name` | - | Container name. The `cloudflare` preset derives one from the app name. |
| `sandboxId` | - | Shared Box identity for every run. |
| `sleepAfter`, `keepAlive`, `normalizeId` | - | Cloudflare Sandbox session options. |

The Cloudflare integration writes the Container, Durable Object binding, migration, and Worker exports to Provider Output. It generates `.vitehub/sandbox/Dockerfile` when the container has no image. For a custom image, configure the application-owned container with a complete Dockerfile. For Vercel, set `runtime` or `source`. Sandbox has no Dockerfile-fragment helper because partial image syntax is not portable across providers.

## Limits

- One timeout bounds one execution attempt after provider startup, including package preparation, staging, and execution. Queueing, Box startup, and retry delays can make the full `runSandbox()` call take longer.
- Callers cannot pass an `AbortSignal` to `runSandbox()`. A disconnected request does not cancel the run. Set a Definition timeout.
- Vercel closes each Box session after success or failure. Cloudflare creates and closes a unique Box for each run unless you set `sandboxId`.
- A Cloudflare `sandboxId` shares one Box. ViteHub deletes invocation-local files after each attempt, caches prepared projects by digest, and serializes runs with the same ID in one isolate. Separate Worker isolates can still enter the Box at the same time.

## Production checks

A Definition name and its payload select work. They are not a permission boundary. Code inside the Box can use the filesystem, environment, network, credentials, and child processes that the provider exposes.

Inspect that authority before execution when your policy depends on it:

```ts [server/sandbox-authority.ts]
import { resolveSandboxRunner } from '@vite-hub/sandbox'

const runner = await resolveSandboxRunner('release-notes')
console.log(runner.executionAuthority)
```

Apply provider controls such as Vercel `networkPolicy`. Keep secrets in server environment or provider configuration. Do not treat container execution alone as authorization for untrusted code.

Run `vitehub inspect definitions` to list discovered Sandbox Definitions without starting a server.

## Connect Sandbox to Agents

Agents receive Sandbox through the [`sandbox()` Capability](/docs/capabilities/sandbox). With `commands`, it gives a model-backed Agent an allowlisted `sandbox_exec` tool that delegates to this primitive.

## Next steps

- Store durable files with [Workspace](/docs/server-primitives/workspace).
- Run controlled commands with [Shell](/docs/server-primitives/shell).
- Read the [Box](/docs/agents/boxes) execution model.
- Check host support in the [support matrix](/docs/frameworks-hosts/support-matrix).
