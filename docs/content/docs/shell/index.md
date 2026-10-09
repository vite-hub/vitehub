---
title: Shell
navigation.title: Overview
description: Run Unix-like commands with configured filesystem, process, network, timeout, and policy access.
navigation.order: 1
icon: i-lucide-terminal
---

::product-hero{tagline="Run Unix-like commands from server code through Just Bash, Cloudflare, or a custom Execution Provider." hosts="Node, Docker, Cloudflare"}
  :::code-group
  ```ts [Runtime]
  import { createShellRuntime } from '@vite-hub/shell'
  import { createJustBashProvider } from '@vite-hub/shell/providers/just-bash'
  import { createReadonlyWorkspaceFs, workspaceMountPoint } from '@vite-hub/shell/workspace'
  import { useWorkspace } from '@vite-hub/workspace'

  const workspace = useWorkspace('docs')
  const shell = createShellRuntime({
    policy: { maxOutputLength: 10_000, timeout: 30_000 },
    provider: createJustBashProvider({
      commands: ['pwd', 'ls', 'cat', 'rg'],
      cwd: workspaceMountPoint,
      fs: createReadonlyWorkspaceFs(workspace.fs),
    }),
  })

  const observation = await shell.exec('rg auth .', { cwd: workspaceMountPoint })
  ```

  ```ts [Session]
  import { createShellRuntime } from '@vite-hub/shell'

  export async function inspect(runtime: ReturnType<typeof createShellRuntime>) {
    const session = runtime.createSession({
      policy: {
        maxOutputLength: 10_000,
        maxShellCalls: 4,
        timeout: 30_000,
      },
    })

    try {
      return await session.exec('pwd')
    }
    finally {
      await session.dispose()
    }
  }
  ```

  ```ts [Analysis]
  import { analyzeShellCommand } from '@vite-hub/shell'

  const analysis = await analyzeShellCommand('rg TODO src')
  // analysis.commands: ['rg'], analysis.hasPipelines: false, analysis.ok: true
  ```

  ```ts [Agent]
  import { defineAgent } from 'vite-hub/agent'
  import { workspaceShell } from 'vite-hub/agent/capabilities'

  export default defineAgent({
    driver: { model: 'openai/gpt-5.1-mini' },
    workspace: { mode: 'write' },
    capabilities: [workspaceShell({ mode: 'write' })],
  })
  ```
  :::
::


::product-features
  :::product-feature-item{title="Each command returns a Shell Observation" icon="i-lucide-terminal" to="/docs/shell/server-api"}
  Exit code, stdout, and stderr; a policy denial returns `126`.
  :::

  :::product-feature-item{title="A Session keeps one policy across commands" icon="i-lucide-gauge" to="/docs/shell/server-api#use-shell-sessions"}
  One call budget, output limit, and timeout for repeated commands.
  :::

  :::product-feature-item{title="Read the facts of a command first" icon="i-lucide-search" to="/docs/shell/server-api#analyze-commands"}
  `analyzeShellCommand()` reports executables, pipelines, and redirects; you decide.
  :::

  :::product-feature-item{title="The provider sets the boundary" icon="i-lucide-shield-check" to="/docs/shell/configure"}
  The Execution Provider, not analysis, limits commands, files, and network.
  :::

  :::product-feature-item{title="Agents get Shell through the Workspace shell" icon="i-lucide-bot" to="/docs/workspace/agent-capability"}
  `workspaceShell()` gives an Agent a `shell` tool.
  :::

  :::product-feature-item{title="Model-backed Agents run executables in Sandbox" icon="i-lucide-terminal-square" to="/docs/sandbox/agent-capability"}
  Give model-backed Agents allowlisted executables through `sandbox()`.
  :::
::
