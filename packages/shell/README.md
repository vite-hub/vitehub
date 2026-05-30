# @vite-hub/shell

<p>
  <a href="https://vitehub.dev"><img alt="ViteHub" src="https://img.shields.io/badge/ViteHub-vitehub.dev-646cff?style=flat-square"></a>
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-ready-3178c6?style=flat-square">
  <img alt="Shell" src="https://img.shields.io/badge/Shell-controlled%20runtime-18181b?style=flat-square">
</p>

`@vite-hub/shell` gives agents and workspace tools structured command execution with explicit boundaries.

## Install

```sh
pnpm add @vite-hub/shell
```

## Minimal API

```ts
// server/utils/shell.ts
import { analyzeShellCommand, createShellRuntime } from "@vite-hub/shell"
import type { ShellExecutionProvider } from "@vite-hub/shell"

const provider: ShellExecutionProvider = {
  boundary: {
    cwd: true,
    env: true,
    filesystem: { writable: false },
    network: false,
    processes: { background: false, interactive: false },
    streaming: false,
    timeout: { enforcedBy: "runtime", supported: true },
  },
  async exec(command) {
    return {
      command,
      event: "command_finished",
      exitCode: 0,
      stderr: "",
      stdout: "ok\n",
    }
  },
}

const runtime = createShellRuntime({ provider, policy: { maxShellCalls: 5 } })
const analysis = await analyzeShellCommand("echo ok")
const result = analysis.ok ? await runtime.exec("echo ok") : undefined
```

## Used by

`workspaceShell()` in [`@vite-hub/agent`](../agent/README.md) uses this package to expose scoped shell work to an agent. Workspace adapters live in `@vite-hub/shell/workspace`.

Built on [just-bash](https://www.npmjs.com/package/just-bash) for the built-in shell provider and [sh-syntax](https://www.npmjs.com/package/sh-syntax) for command analysis.

Learn more at [vitehub.dev](https://vitehub.dev).
