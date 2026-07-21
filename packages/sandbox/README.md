# @vite-hub/sandbox

`@vite-hub/sandbox` discovers and runs named work by composing a package project and a Box. Sandbox owns discovery, orchestration, and project staging; Box owns provider-specific execution.

```ts
// server/sandboxes/release-notes/index.ts
import { readFile } from "node:fs/promises"

export interface SandboxPayload {
  notes?: string
}

const { payload } = JSON.parse(await readFile(process.argv[2], "utf8")) as {
  payload?: SandboxPayload
}

export default { summary: payload?.notes?.split("\n")[0] ?? "" }
```

The folder supplies the Definition name, and the adjacent manifest owns portable lifecycle metadata:

```json
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

ViteHub passes `{ payload, context }` through `process.argv[2]`, awaits the module's top-level execution, and returns its default export. Exporting `SandboxPayload` gives `runSandbox()` a typed payload; otherwise the payload is `unknown`. The entrypoint needs no `@vite-hub/sandbox` runtime dependency.

ViteHub uses the manifest's `packageManager`, then a lockfile at that package root, then npm. A matching `pnpm-workspace.yaml` selects pnpm, moves preparation to the pnpm workspace root, and carries the transitive `workspace:*` dependency closure into the Box while the entrypoint still runs from its package directory.

Use `<path>.sandbox.ts` with `defineSandbox()` for free-form Definitions outside `server/sandboxes`.

```ts
import { runSandbox } from "@vite-hub/sandbox"

const result = await runSandbox("release-notes", { notes: "ship it" })
```

Add `hubSandbox()` to Vite for discovery, typed registry generation, package preparation plans, and host output. Provider images and full Dockerfile overrides belong to the selected Box adapter or host configuration; Sandbox Definitions stay portable.
