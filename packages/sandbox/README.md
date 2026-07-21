# @vite-hub/sandbox

`@vite-hub/sandbox` discovers and runs named work by composing a package project, a Workspace, and a Box. Sandbox owns orchestration; Workspace owns durable files; Box owns provider-specific execution.

```ts
// server/sandboxes/release-notes/index.ts
export default async function run(payload: { notes?: string } = {}) {
  return { summary: payload.notes?.split("\n")[0] ?? "" }
}
```

The folder supplies the Definition name, so canonical package projects do not import `defineSandbox`. The nearest `package.json` supplies dependencies and optional static project policy:

```json
{
  "private": true,
  "vitehub": {
    "timeout": 30000
  }
}
```

`vitehub.timeout` is a positive wall-clock limit in milliseconds. ViteHub validates package metadata without importing the project entry. Provider selection, credentials, resources, and secrets remain in application or host configuration.

ViteHub resolves the nearest `package.json` without walking above the Vite root. It uses the manifest's `packageManager`, then a lockfile at that package root, then npm. A matching `pnpm-workspace.yaml` selects pnpm, moves preparation to the pnpm Workspace root, and carries the transitive `workspace:*` dependency closure into the Box while the Definition still runs from its package directory.

Use `defineSandbox` only for free-form `<path>.sandbox.ts` Definitions outside `server/sandboxes`:

```ts
import { defineSandbox } from "@vite-hub/sandbox"

export default defineSandbox({
  timeout: 30_000,
  async run() {
    return { ready: true }
  },
})
```

```ts
import { runSandbox } from "@vite-hub/sandbox"

const result = await runSandbox("release-notes", { notes: "ship it" })
```

Add `hubSandbox()` to Vite for discovery, typed registry generation, package preparation plans, and host output. Provider images and full Dockerfile overrides belong to the selected Box adapter or host configuration; Sandbox Definitions stay portable.
