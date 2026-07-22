# @vite-hub/sandbox

`@vite-hub/sandbox` discovers and runs named work by composing a package project and a Box. Sandbox owns discovery, orchestration, and project staging; Box owns provider-specific execution.

```ts
// server/sandboxes/release-notes/index.ts
interface SandboxPayload {
  notes?: string
}

export default async function releaseNotes(payload: SandboxPayload = {}) {
  return { summary: payload.notes?.split("\n")[0] ?? "" }
}
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

ViteHub calls the default function with `(payload, context)` and infers the `runSandbox()` payload and result types from it. Nested `Blob` and `Uint8Array` values cross the Box boundary through binary sidecars rather than application JSON. Existing non-function default exports remain supported; their optional exported `SandboxPayload` type is the payload fallback. The entrypoint needs no `@vite-hub/sandbox` runtime dependency.

ViteHub uses the manifest's `packageManager`, then a lockfile at that package root, then npm. A matching `pnpm-workspace.yaml` selects pnpm, moves preparation to the pnpm workspace root, and carries the transitive `workspace:*` dependency closure into the Box while the entrypoint still runs from its package directory.

Package entrypoints are ESM projects. Keep `"type": "module"`, use explicit relative ESM imports for local `.ts` and `.mts` source, and depend on packages that expose runtime-ready JavaScript. ViteHub compiles the reachable local TypeScript graph without bundling package dependencies or moving relative assets. It rejects CommonJS/CTS, package import aliases and self-references for local source, imports that escape the selected package, and workspace dependencies that expose TypeScript runtime entries.

Use `<path>.sandbox.ts` with `defineSandbox()` for free-form Definitions outside `server/sandboxes`.

```ts
import { runSandbox } from "@vite-hub/sandbox"

const [error, result] = await runSandbox("release-notes", { notes: "ship it" })
if (error) throw error
```

Add `hubSandbox()` to Vite for discovery, typed registry generation, package preparation plans, and host output. Provider images and full Dockerfile overrides belong to the selected Box adapter or host configuration; Sandbox Definitions stay portable.
