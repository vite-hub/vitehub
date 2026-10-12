---
title: Sandbox configuration
description: Lay out Sandbox package projects, free-form Definitions, entrypoints, and Definition options.
navigation.title: Configure
navigation.order: 4
icon: i-lucide-sliders-horizontal
---

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
