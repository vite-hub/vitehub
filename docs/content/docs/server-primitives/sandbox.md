---
title: Sandbox
description: Run named package projects through Workspace and Box.
navigation.order: 12
icon: i-lucide-terminal-square
---

A Sandbox Definition is portable orchestration. Its package project supplies dependencies, its Workspace supplies durable files, and its Box adapter supplies execution.

## Quick start

Install and register the Vite integration:

```bash [Terminal]
pnpm add @vite-hub/sandbox
```

```ts [vite.config.ts]
import { hubSandbox } from '@vite-hub/sandbox/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [hubSandbox()],
})
```

Every discovered Definition belongs to a real package project. ViteHub never writes a manifest into your repository, so create the smallest valid one when the package has no dependencies:

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
import { readFile } from 'node:fs/promises'

export interface SandboxPayload {
  notes?: string
}

const { payload } = JSON.parse(await readFile(process.argv[2], 'utf8')) as {
  payload?: SandboxPayload
}

export default { text: payload?.notes?.toUpperCase() || 'No notes' }
```

```ts [server/api/release-notes.post.ts]
import { runSandbox } from '@vite-hub/sandbox'

export default defineEventHandler(async () => {
  const [error, result] = await runSandbox('release-notes', { notes: 'ship it' })
  if (error) throw error
  return result
})
```

## The three Modules

- Sandbox owns Definition discovery, typed invocation, package-project resolution, preparation policy, serialization, timeout, and lifecycle orchestration.
- Workspace owns authoritative files, Sources, snapshots, diffs, commit, and rollback.
- Box owns isolation, processes, runtime files, disposable caches, ports, and provider-specific preparation or deployment output.

Sandbox and Agent use the same Box Interface. Workspace never selects Cloudflare, Vercel, Crabbox, or trusted-host execution.

## Package projects

Under `server/sandboxes`, use one folder per package project with an adjacent `package.json` and `index.ts`. The folder path supplies the Definition name. Other files in the package are ordinary helpers rather than independently discovered Sandboxes.

```text
server/sandboxes/
├── image/
│   ├── package.json
│   └── index.ts
└── metadata/
    ├── package.json
    └── index.ts
```

For free-form Definitions outside `server/sandboxes`, use the `<path>.sandbox.ts` suffix convention with `defineSandbox()`. Those Definitions use their nearest `package.json`, so several files can share one package project.

Package-manager selection uses the manifest's `packageManager` field, then a lockfile at that package root, then npm. A nested independent package never inherits an unrelated ancestor lockfile. Lockfiles enable frozen installation. ViteHub installs the project inside the Box before the entrypoint launches, and dependency trees never enter Workspace commits.

ViteHub also understands a standard pnpm Workspace without adding ViteHub-specific workspace configuration:

```text
server/sandboxes/
├── package.json
├── pnpm-lock.yaml
├── pnpm-workspace.yaml
└── image/
    ├── package.json
    └── index.ts
```

Installation runs at the pnpm Workspace root and the Definition runs from `server/sandboxes/image`. ViteHub carries every local package in the transitive `workspace:*` dependency closure, then pnpm remains responsible for installation and linking semantics. Other Workspace packages stay outside the runtime project.

## Package entrypoint

The package `index.ts` runs as ordinary top-level ESM. ViteHub writes `{ payload, context }` to the input sidecar at `process.argv[2]`, awaits the module, and serializes its default export as the invocation result.

```ts
import { readFile } from 'node:fs/promises'

export type SandboxPayload = { key: string }

const { payload } = JSON.parse(await readFile(process.argv[2], 'utf8')) as {
  payload: SandboxPayload
}

export default await optimize(payload)
```

The optional exported `SandboxPayload` type controls the payload accepted by `runSandbox()`. Without it, the payload is `unknown`. The entrypoint gets normal JavaScript, package imports, top-level await, `process.cwd()`, environment variables, and a filesystem, without a runtime framework import.

The first package metadata schema contains only `vitehub.sandbox.timeout`. It must be a positive integer no greater than `2_147_483_647`, and ViteHub enforces it while preparing and executing the package.

## Box adapters and images

Cloudflare, Vercel, Crabbox, and trusted host implement the Box Interface. The common contract covers binary files, directory operations, cwd/env/timeout command execution, abort, and lifecycle. Processes and ports are explicit optional capabilities.

Provider selection and full image overrides are application or host configuration. For Cloudflare, configure the application-owned container with a complete Dockerfile; for Vercel, configure the Box runtime image. Sandbox has no Dockerfile-fragment helper because partial image syntax cannot be portable across providers.

## Breaking migration

Move canonical Definitions into a package folder and execute them at module top level:

```ts
// Before
import { defineSandbox } from '@vite-hub/sandbox'

export default defineSandbox({
  timeout: 30_000,
  run,
})

// Now
import { readFile } from 'node:fs/promises'

const { payload } = JSON.parse(await readFile(process.argv[2], 'utf8'))

export default await run(payload)
```

- Move `timeout` to `package.json#vitehub.sandbox.timeout`.
- Remove the package entrypoint's `defineSandbox()` wrapper and `@vite-hub/sandbox` runtime dependency.
- Read the existing input sidecar from `process.argv[2]` and default-export the result.
- Export `SandboxPayload` when callers should receive a specific payload type.

## Public imports

| Import | Use |
| --- | --- |
| `defineSandbox` from `@vite-hub/sandbox` | Declare a free-form `<path>.sandbox.ts` Definition. |
| `runSandbox` from `@vite-hub/sandbox` | Invoke a discovered Definition. |
| `hubSandbox` from `@vite-hub/sandbox/vite` | Register discovery, types, preparation, and provider output. |

Use [Workspace](/docs/server-primitives/workspace) for durable file state and Box configuration for execution environments.
