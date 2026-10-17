# @vite-hub/sandbox-task

A Sandbox Task is one job that runs inside one Sandbox. `@vite-hub/sandbox-task` runs a discovered Sandbox Task Definition inside a provider-backed Sandbox. Sandbox Task owns discovery, package staging, typed invocation, timeouts, and result transport. [`@vite-hub/sandbox`](../sandbox/README.md) owns the Sandbox: the execution environment and its isolation.

Most applications should install [`vite-hub`](https://vitehub.dev/docs/getting-started/installation) and import APIs such as `runSandboxTask` from `vite-hub/sandbox-task`. Install `@vite-hub/sandbox-task` directly when you are building a library, a custom Vite composition, or package-level tooling.

## Install

Install Sandbox Task, Vite, and the Sandbox provider used by your deployment. This first run uses Vercel Sandbox:

```sh
pnpm add @vite-hub/sandbox-task @vercel/sandbox vite
```

Sandbox Task requires Node.js 24 or newer. Vercel execution also requires a Vercel project with Sandbox access. At runtime, use the project's environment or set `VERCEL_TOKEN`, `VERCEL_TEAM_ID`, and `VERCEL_PROJECT_ID`.

For Cloudflare, install `@cloudflare/sandbox` instead and use the ViteHub Cloudflare host integration so it can emit the required Container, Durable Object binding, migration, and Worker exports. Both providers run remote, potentially billed infrastructure; Sandbox does not include a local in-process provider.

## Run one Sandbox Task

Register discovery and select the provider in Vite:

```ts
// vite.config.ts
import { hubSandboxTask } from "@vite-hub/sandbox-task/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [hubSandboxTask({ provider: "vercel" })],
  build: {
    ssr: "src/server.ts",
  },
});
```

Create a package-backed Definition at `server/sandbox-tasks/release-notes/package.json`. The folder path supplies the name `release-notes`, and its manifest owns the timeout for each execution attempt:

```json
{
  "private": true,
  "type": "module",
  "vitehub": {
    "sandboxTask": {
      "timeout": 30000
    }
  }
}
```

```ts
// server/sandbox-tasks/release-notes/index.ts
interface ReleaseNotesPayload {
  notes?: string;
}

export default async function releaseNotes(payload: ReleaseNotesPayload = {}) {
  return { summary: payload.notes?.split("\n")[0] ?? "" };
}
```

Invoke the discovered name from server code. `runSandboxTask()` returns a native Web `Response` and infers its payload from the Definition:

```ts
// src/server.ts
import { runSandboxTask } from "@vite-hub/sandbox-task";

const response = await runSandboxTask("release-notes", {
  notes: "ship it\nadd tests",
});

if (!response.ok) throw new Error(await response.text());

console.log(JSON.stringify(await response.json()));
```

Build through Vite so discovery and the runtime registry are generated, then run the server entry:

```sh
pnpm vite build
node dist/server.js
```

The process prints:

```json
{ "summary": "ship it" }
```

The Definition entrypoint does not import `@vite-hub/sandbox-task`. ViteHub calls its default function with `(payload, context)` and returns its awaited result.

## Provider and lifecycle limits

- Provider selection belongs to application or host configuration, not to a Definition. `hubSandboxTask({ provider: "vercel" })` and `hubSandboxTask({ provider: "cloudflare" })` are the direct-package forms. The `vite-hub` distribution can infer these from its Vercel and Cloudflare presets.
- `vitehub.sandboxTask.timeout` must be a positive integer no greater than `2_147_483_647`. It bounds one execution attempt after provider startup, including package preparation, staging, and execution. Queueing, Sandbox startup, and retry delays can make the complete `runSandboxTask()` call take longer. An elapsed attempt timeout sends an internal abort signal to cancellable provider operations and returns a `SANDBOX_TASK_TIMEOUT` error in a non-2xx JSON response.
- Pass `signal` to `runSandboxTask()` when it belongs to a request or Agent Invocation. ViteHub forwards it to Sandbox startup and execution, cancels queued Cloudflare runs and retry backoff, and preserves the caller's abort reason. A Definition timeout remains the independent bound for each execution attempt.
- Vercel Sandbox sessions are closed in a `finally` block after success or failure. Cloudflare also creates and closes a unique Sandbox for each run unless you configure `sandboxId` or pass one to `runSandboxTask()`. Cleanup failures are surfaced through the `runSandboxTask()` non-2xx JSON response; they are not suppressed after a successful handler.
- An explicit Cloudflare `sandboxId` opts into a shared Sandbox identity. ViteHub deletes invocation-local files after each attempt, caches prepared projects by digest inside that Sandbox, and serializes runs with the same ID within one runtime isolate. Separate Worker isolates can still enter the Sandbox concurrently, so use external coordination when deployment-wide serialization is required. The provider normally leaves an explicitly named Sandbox for idle shutdown; setting `keepAlive: true` makes ViteHub close its session after the run.

## Security and isolation

A Sandbox Task Definition name and its typed arguments select work; they are not a permission boundary. Code inside the Sandbox can use whatever filesystem, environment, network, credentials, executables, and child-process authority the selected provider exposes.

Inspect that authority before execution when application policy depends on it:

```ts
import { resolveSandboxTaskRunner } from "@vite-hub/sandbox-task";

const runner = await resolveSandboxTaskRunner("release-notes");
console.log(runner.executionAuthority);
```

The descriptor reports the provider's complete `ExecutionAuthority`, including dimensions it cannot establish as `unknown`. Apply provider controls such as Vercel `networkPolicy`, keep secrets in server environment or provider configuration, and do not treat container execution alone as authorization for untrusted code.

Payloads, context, and results must be JSON-serializable. Nested `Blob` and `Uint8Array` values cross the Sandbox boundary through invocation-local binary files, and Node.js `Buffer` values retain their type.

## Package projects

ViteHub uses the package manifest's `packageManager`, then a lockfile at that package root, then npm. A matching `pnpm-workspace.yaml` moves preparation to the pnpm Workspace root and carries the transitive `workspace:*` dependency closure into the Sandbox while the entrypoint still runs from its package directory.

Package entrypoints are ESM projects. Keep `"type": "module"`, use explicit relative ESM imports for local `.ts` and `.mts` source, and depend on packages that expose runtime-ready JavaScript. ViteHub compiles reachable local TypeScript without bundling package dependencies or moving relative assets. It rejects CommonJS/CTS, local package aliases and self-references, imports that escape the selected package, and Workspace dependencies that expose TypeScript runtime entries.

Use `<path>.sandbox-task.ts` with `defineSandboxTask()` for a free-form Definition outside `server/sandbox-tasks`. Free-form Definitions use their nearest package project.

## Read more

- [Sandbox Task guide](https://vitehub.dev/docs/sandbox)
- [Sandbox execution and security model](https://vitehub.dev/docs/agents/sandboxes)
- [Runtime and host support](https://vitehub.dev/docs/frameworks-hosts/support-matrix)
- [ViteHub security policy](https://github.com/vite-hub/vitehub/blob/main/SECURITY.md)
