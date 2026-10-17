---
title: Sandbox
navigation.title: Overview
description: Run named package projects in an isolated Cloudflare or Vercel Sandbox.
navigation.order: 1
icon: i-lucide-terminal-square
---

::agent-only{skill="sandbox-task" title="Sandbox Tasks"}
Use a Sandbox Task to run a named project inside an isolated Cloudflare or Vercel Sandbox. A Sandbox Task run is an execution boundary, not a general-purpose local shell.

Read [Get started](/docs/sandbox/get-started), [Configure](/docs/sandbox/configure), [Server API](/docs/sandbox/server-api), [Agent Capability](/docs/sandbox/agent-capability), or [Hosts](/docs/sandbox/hosts).

Keep images, mounts, network access, timeouts, and resource bounds explicit. Pass only the files and secrets the run needs.

Prove successful execution, cancellation, timeout, and cleanup on the selected provider. Verify result-size limits only when the provider documents them. Inspect generated bindings and provider output.
::

::product-hero{tagline="Run a named package project as a Sandbox Task in an isolated Sandbox, on Cloudflare or Vercel Sandbox chosen in config." hosts="Vercel, Cloudflare"}
  :::code-group
  ```ts [Definition and route]
  // server/sandbox-tasks/release-notes/index.ts
  interface SandboxTaskPayload {
    notes?: string
  }

  export default async function releaseNotes(payload: SandboxTaskPayload = {}) {
    return { text: payload.notes?.toUpperCase() || 'No notes' }
  }

  // server/api/release-notes-json.post.ts
  import { runSandboxTask } from '@vite-hub/sandbox-task'

  export default defineEventHandler(async () => {
    const response = await runSandboxTask('release-notes', { notes: 'ship it' }, {
      context: { requestId: 'release-notes-42' },
    })
    if (!response.ok)
      throw new Error(await response.text())
    return await response.json()
  })
  ```

  ```ts [vite.config.ts]
  import { hubSandboxTask } from '@vite-hub/sandbox-task/vite'
  import { defineConfig } from 'vite'

  export default defineConfig({
    plugins: [hubSandboxTask({ provider: 'vercel' })],
  })
  ```

  ```ts [Agent]
  import { defineAgent } from 'vite-hub/agent'
  import { sandbox } from 'vite-hub/agent/capabilities'

  export default defineAgent({
    driver: { model },
    workspace,
    capabilities: [
      sandbox({ commands: ['node', 'pnpm'] }),
    ],
  })
  ```
  :::
::


::product-features
  :::product-feature-item{title="A Sandbox Task is a package project" icon="i-lucide-box" to="/docs/sandbox/configure"}
  One folder under `server/sandbox-tasks`, with `package.json` and an entrypoint.
  :::

  :::product-feature-item{title="Every run returns a native Response" icon="i-lucide-code-2" to="/docs/sandbox/server-api"}
  Failures and `SANDBOX_TASK_TIMEOUT` return a non-2xx JSON `Response`.
  :::

  :::product-feature-item{title="Pick the provider in config, not the Definition" icon="i-lucide-cloud-cog" to="/docs/sandbox/hosts"}
  Vercel Sandbox and Cloudflare Sandbox run the same Definitions.
  :::

  :::product-feature-item{title="The Sandbox is the boundary" icon="i-lucide-shield-alert" to="/docs/sandbox/limits-and-errors"}
  Sandbox code reaches what the provider exposes; read `executionAuthority` first.
  :::

  :::product-feature-item{title="Allowlisted executables, as one Agent tool" icon="i-lucide-bot" to="/docs/sandbox/agent-capability"}
  `sandbox_exec` runs only executable names listed in `commands`.
  :::

  :::product-feature-item{title="Sessions expose status" icon="i-lucide-activity" to="/docs/sandbox/server-api"}
  Read logs, exit state, and outputs from the same session handle.
  :::
::
