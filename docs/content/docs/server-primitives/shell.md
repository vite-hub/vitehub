---
title: Shell
description: Run controlled Unix-like command sessions over explicit filesystem, process, network, and policy boundaries.
navigation.order: 13
icon: i-lucide-terminal
---

Shell owns controlled Unix-like command environments. Use it when server code needs command-shaped inspection or mutation with explicit execution, filesystem, process, network, timeout, and policy boundaries.

Shell is not Sandbox. Sandbox can provide an isolated execution provider, but Shell defines the command runtime, Shell Session lifecycle, Command Analysis, Shell Observations, and Shell Boundary.

## Create a Shell Runtime

Use `createShellRuntime()` with an Execution Provider. The built-in Just Bash Provider runs Bash-compatible commands against an explicit filesystem adapter.

```ts [server/tasks/search-docs.ts]
import { createShellRuntime } from '@vite-hub/shell'
import { createJustBashProvider } from '@vite-hub/shell/providers/just-bash'
import { createReadonlyWorkspaceFs, workspaceMountPoint } from '@vite-hub/shell/workspace'
import { useWorkspace } from '@vite-hub/workspace'

export async function searchDocs() {
  const workspace = useWorkspace('docs')
  const runtime = createShellRuntime({
    provider: createJustBashProvider({
      commands: ['pwd', 'ls', 'cat', 'rg'],
      cwd: workspaceMountPoint,
      fs: createReadonlyWorkspaceFs(workspace.fs),
    }),
  })

  return runtime.exec('rg auth docs', {
    cwd: workspaceMountPoint,
  })
}
```

The provider controls available commands. The Workspace filesystem controls whether file writes can happen.

## Use Shell Sessions

A Shell Session adds stateful policy around repeated commands, output size, timeouts, and process budget.

```ts [server/tasks/inspect-docs.ts]
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

Shell Observations include command output, timing, exit status, truncation, timeout, and policy-denied facts so callers can inspect what happened.

## Analyze commands

Command Analysis produces facts about a command before execution. The caller owns the final Policy Decision.

```ts [server/tasks/analyze-command.ts]
import { analyzeShellCommand } from '@vite-hub/shell'

export async function analyze(command: string) {
  return analyzeShellCommand(command)
}
```

Do not treat analysis as sandbox enforcement. Execution Providers and caller-owned policy enforce the actual boundary.

## Provider output

Shell is a runtime primitive and does not require discovered Definitions by itself. Provider modules such as `@vite-hub/shell/providers/just-bash` and `@vite-hub/shell/providers/cloudflare` adapt execution environments to the Shell Runtime contract.

Workspace and Agent packages can adapt Shell into Workspace tools or model-facing Capabilities, but Shell remains runtime-focused.

## Connect it to Agents

Agents use Shell through Capabilities, usually `workspaceShell()`. That Capability exposes shell-shaped Workspace inspection and optional structured Workspace mutation tools through Workspace Scope, Workspace rules, and Shell policy.

Do not expose a raw Shell Runtime to a model. Use [Official capabilities](/docs/capabilities/official-capabilities) so policy, metadata, driver support, and tool surfaces stay attached to the Agent Definition.

## Production boundaries

Declare command, filesystem, network, process, streaming, and timeout boundaries before running commands. Shell Network Grants are explicit; normal network access is not implied.

Use Sandbox when the app needs provider-managed isolation. Use Shell when the app needs controlled command semantics over a declared Shell Workspace.

## Next steps

- Use [Workspace](/docs/server-primitives/workspace) for file-tree state.
- Use [Sandbox](/docs/server-primitives/sandbox) for isolated execution providers.
- Expose command inspection to agents through [Official capabilities](/docs/capabilities/official-capabilities).
