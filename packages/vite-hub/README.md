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
import { codexDriver } from "vite-hub/agent/harness/codex"
import { env } from "vite-hub/env"
import { renderMarkdownTemplate } from "vite-hub/markdown-template"
import { defineWorkspace } from "vite-hub/workspace"
import { defineWorkflow } from "vite-hub/workflow"
```

The root export intentionally contains only the framework configuration API. Feature code belongs on a feature subpath, which forwards to the package that owns it.

ViteHub-owned adapters use `vite-hub/*` even when they integrate an optional third-party package. Install the external provider or SDK explicitly, such as `@ai-sdk/harness-codex` for `vite-hub/agent/harness/codex`; applications should not need a second `@vite-hub/*` dependency to reach the adapter.

Install an `@vite-hub/*` owner package directly when building a custom composition, another framework integration, or package-level tooling.
