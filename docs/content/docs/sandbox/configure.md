---
title: Sandbox Task configuration
description: Lay out Sandbox Task packages, free-form Definitions, entry points, and options.
navigation.title: Configure
navigation.order: 4
icon: i-lucide-sliders-horizontal
---

## Package projects

Each folder under `server/sandbox-tasks` with a `package.json` and an `index.ts`, `index.mts`, `index.js`, or `index.mjs` entry point is one task. The folder path is its name. Other files are helpers.

```text
server/sandbox-tasks/
├── image/
│   ├── package.json
│   └── index.ts
└── metadata/
    ├── package.json
    └── index.ts
```

ViteHub uses the `packageManager` field in `package.json`, then a lockfile in the package folder, then npm. A nested package never uses an unrelated lockfile from a parent folder. A lockfile makes the install frozen. Dependencies install in the Sandbox before the entry point starts and never go back to your repository.

ViteHub also supports a standard pnpm Workspace with no extra configuration:

```text
server/sandbox-tasks/
├── package.json
├── pnpm-lock.yaml
├── pnpm-workspace.yaml
└── image/
    ├── package.json
    └── index.ts
```

pnpm installs at the Workspace root, and the task runs from `server/sandbox-tasks/image`. ViteHub includes every local package reached through `workspace:*` dependencies, and pnpm links them. Other Workspace packages stay out.

Entry points are ESM. Keep `"type": "module"` and import local `.ts` and `.mts` files by explicit relative path. ViteHub compiles reachable local TypeScript but does not bundle dependencies. It rejects:

- CommonJS
- local package aliases and self-references
- imports that leave the package
- Workspace dependencies with TypeScript runtime entries

### Free-form Definitions

Outside `server/sandbox-tasks`, name a file `<path>.sandbox-task.ts` (or `.mts`, `.cts`, `.js`, `.mjs`, `.cjs`) and default-export `defineSandboxTask()`. This free-form Definition uses its nearest `package.json`, so several files can share one package.

```ts [server/tools/resize.sandbox-task.ts]
import { defineSandboxTask } from 'vite-hub/sandbox/task'

export default defineSandboxTask({
  timeout: 60000,
  handler: async (payload: { width: number } = { width: 640 }) => ({ width: payload.width }),
})
```

## Definition options

| Option | Where | Type | Description |
| --- | --- | --- | --- |
| `vitehub.sandboxTask.timeout` | `package.json` | `number` | Timeout in milliseconds for one attempt. |
| `vitehub.sandboxTask.transfer` | `package.json` | `object` | Limits for a package-backed Definition. See [Transfer limits](#transfer-limits). |
| `handler` | `defineSandboxTask()` | `function` | Required handler. Called with `(payload, context)`. |
| `timeout` | `defineSandboxTask()` | `number` | Timeout in milliseconds for one attempt. |
| `env` | `defineSandboxTask()` | `Record<string, string>` | Environment variables for the run. |
| `transfer` | `defineSandboxTask()` | `object` | Limits on the payload, context, and result of a run. See [Transfer limits](#transfer-limits). |
| `project` | `defineSandboxTask()` | `boolean` | Turn package-project packaging on or off. Omit it to let ViteHub detect it. |

Each timeout must be a positive integer up to `2_147_483_647`. Without a timeout, a run stops after 5 minutes (`300_000`) on every provider. Vercel also has a plan maximum, see [Limits and errors](/docs/sandbox/limits-and-errors#timeouts). `defineSandboxTask()` options must be static JSON values, because ViteHub reads them at build time.

## Transfer limits

`transfer` limits what one run sends into the Sandbox and what the handler returns. Set it in `defineSandboxTask()` or as `vitehub.sandboxTask.transfer` in the task package's `package.json`. Each limit is a whole number from 1 to `1_073_741_824`.

| Key | Default | Limit |
| --- | --- | --- |
| `maxInputBytes` | `4_194_304` (4 MiB) | UTF-8 bytes of the payload and context JSON. |
| `maxOutputBytes` | `4_194_304` (4 MiB) | UTF-8 bytes of successful result JSON, including base64-encoded `Response` bodies. |
| `maxDepth` | `32` | Levels of nested arrays and objects in the payload, context, or result. |
| `maxSidecars` | `64` | Number of `Blob`, `Uint8Array`, and `Buffer` values in the input, and in the result. |
| `maxSidecarBytes` | `67_108_864` (64 MiB) | Total bytes of the binary values in the input, and in the result. |

```ts [server/tools/resize.sandbox-task.ts]
import { defineSandboxTask } from 'vite-hub/sandbox/task'

export default defineSandboxTask({
  transfer: { maxInputBytes: 2_097_152, maxSidecars: 8 },
  handler: async (payload: { image: Blob }) => payload.image.size,
})
```

A run that exceeds a limit fails with `SANDBOX_TASK_TRANSFER_LIMIT` in `error.data.code`. For input, the run fails before the handler starts and before ViteHub writes a binary file to the Sandbox. For the result, the run fails before ViteHub parses it or reads its files.

## Package entry point

The package `index.ts` default-exports a normal async function. ViteHub calls it with the payload and context and returns its result. The entry point does not import `@vite-hub/sandbox/task`.

```ts [server/sandbox-tasks/image/index.ts] fragment
export default async function optimize(
  payload: { image: Blob },
  context: { requestId: string },
) {
  return await optimizeImage(payload.image, context.requestId)
}
```

The entry point can use package imports, top-level await, `process.cwd()`, environment variables, and a filesystem, with no framework import.
