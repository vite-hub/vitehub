# vite-hub

`vite-hub` is the cohesive ViteHub framework distribution. It gives applications one ViteHub dependency, one `vitehub()` Vite entry, and deliberate feature subpaths while every `@vite-hub/*` package keeps owning its implementation and remains independently installable.

## Install

```sh
pnpm add vite-hub
```

## Configure ViteHub

```ts
// vite.config.ts
import { vitehub } from "vite-hub"
import { defineConfig } from "vite"

export default defineConfig({
  plugins: [vitehub()],
})
```

The default preset composes Agent, Blob, Database, DevTools, Env, Workflow, and Workspace. Email, KV, Queue, Sandbox, Schedule, and Auth stay opt-in:

```ts
vitehub({
  auth: true,
  email: true,
  kv: true,
  queue: true,
  sandbox: true,
  schedule: true,
})
```

## Use feature APIs

```ts
import { defineAgent } from "vite-hub/agent"
import { workspaceShell } from "vite-hub/agent/capabilities"
import { env } from "vite-hub/env"
import { defineWorkspace } from "vite-hub/workspace"
import { defineWorkflow } from "vite-hub/workflow"
```

The root export intentionally contains only the framework configuration API. Feature code belongs on a feature subpath, which forwards to the package that owns it.

Third-party model providers, chat adapters, and harnesses remain explicit. Workflow keeps its existing Vercel Functions runtime as a deliberate framework default; other host SDKs stay package-owned and explicit. For example, install the Codex harness package and use `@vite-hub/agent/harness/codex` when that integration is part of the application.

Install an `@vite-hub/*` owner package directly when building a custom composition, another framework integration, or package-level tooling. `@vite-hub/vite` remains a supported compatibility import for `vitehub()`; new applications should use `vite-hub`.
