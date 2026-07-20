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
  "private": true
}
```

```ts [server/sandboxes/release-notes/index.ts]
import { defineSandbox } from '@vite-hub/sandbox'

export default defineSandbox({
  timeout: 30_000,
  async run(payload: { notes?: string } = {}) {
    return { text: payload.notes?.toUpperCase() || 'No notes' }
  },
})
```

```ts [server/api/release-notes.post.ts]
import { runSandbox } from '@vite-hub/sandbox'

export default defineEventHandler(async () => {
  return runSandbox('release-notes', { notes: 'ship it' })
})
```

## The three Modules

- Sandbox owns Definition discovery, typed invocation, package-project resolution, preparation policy, serialization, timeout, and lifecycle orchestration.
- Workspace owns authoritative files, Sources, snapshots, diffs, commit, and rollback.
- Box owns isolation, processes, runtime files, disposable caches, ports, and provider-specific preparation or deployment output.

Sandbox and Agent use the same Box Interface. Workspace never selects Cloudflare, Vercel, Crabbox, or trusted-host execution.

## Package projects

Under `server/sandboxes`, use one folder per package project with a `package.json` and `index.ts`. The folder path supplies the Definition name. ViteHub walks from the Definition file to the Vite root and selects the nearest `package.json`. Missing manifests fail the build with the searched boundary, while nested folders can own independent manifests.

```text
server/sandboxes/
├── image/
│   ├── package.json
│   └── index.ts
└── metadata/
    ├── package.json
    └── index.ts
```

For free-form Definitions outside `server/sandboxes`, use the `<path>.sandbox.ts` suffix convention. Those Definitions also use their nearest `package.json`, so several files can share one package project.

Package-manager selection uses the manifest's `packageManager` field, then a lockfile at that package root, then npm. A nested independent package never inherits an unrelated ancestor lockfile. Lockfiles enable frozen installation. ViteHub installs the project inside the Box before the Definition launches, and dependency trees never enter Workspace commits.

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

## Definition Interface

`defineSandbox()` accepts one object. `run` is required; `timeout` and `env` are portable options.

```ts
export default defineSandbox({
  env: { MODE: 'thumbnail' },
  timeout: 60_000,
  async run(payload: { key: string }) {
    return optimize(payload)
  },
})
```

The guest handler gets normal JavaScript, package imports, `process.cwd()`, environment variables, and a filesystem. It does not receive Box or Workspace control objects.

## Box adapters and images

Cloudflare, Vercel, Crabbox, and trusted host implement the Box Interface. The common contract covers binary files, directory operations, cwd/env/timeout command execution, abort, and lifecycle. Processes and ports are explicit optional capabilities.

Provider selection and full image overrides are application or host configuration. For Cloudflare, configure the application-owned container with a complete Dockerfile; for Vercel, configure the Box runtime image. Sandbox has no Dockerfile-fragment helper because partial image syntax cannot be portable across providers.

## Breaking migration

```ts
// Before
export default defineSandbox(run, {
  runtime: { command: 'node' },
  timeout: 30_000,
})

// Now
export default defineSandbox({
  run,
  timeout: 30_000,
})
```

- Add a real `package.json` at the nearest intended package root.
- Move provider choice, custom images, and complete Dockerfiles into Box or host configuration.
- Remove `runtime.command`, `runtime.args`, and `defineDockerfileFragment`; the prepared package runtime launches Definitions consistently.
- Supply a Box when opening an executable Workspace session instead of setting `WorkspaceDefinition.runtime`.

## Public imports

| Import | Use |
| --- | --- |
| `defineSandbox` from `@vite-hub/sandbox` | Declare portable named work. |
| `runSandbox` from `@vite-hub/sandbox` | Invoke a discovered Definition. |
| `hubSandbox` from `@vite-hub/sandbox/vite` | Register discovery, types, preparation, and provider output. |

Use [Workspace](/docs/server-primitives/workspace) for durable file state and Box configuration for execution environments.
