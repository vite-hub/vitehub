# @vite-hub/shell

<p>
  <a href="https://vitehub.dev"><img alt="ViteHub" src="https://img.shields.io/badge/ViteHub-vitehub.dev-646cff?style=flat-square"></a>
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-ready-3178c6?style=flat-square">
  <img alt="Shell" src="https://img.shields.io/badge/Shell-controlled%20runtime-18181b?style=flat-square">
</p>

`@vite-hub/shell` owns Shell Runtime behavior, Shell Sessions, Command Analysis, Shell Boundaries, Shell Observations, and Execution Provider adapters. Use it when an agent-facing system needs structured command execution without making terminal emulation the public contract.

## Install

```sh
pnpm add @vite-hub/shell
```

## Minimal API

```ts
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

## Entry points

- `@vite-hub/shell`: `createShellRuntime()`, `analyzeShellCommand()`, and Shell Runtime types.
- `@vite-hub/shell/providers/just-bash`: built-in Just Bash Provider.
- `@vite-hub/shell/providers/cloudflare`: Cloudflare-compatible shell provider adapter.
- `@vite-hub/shell/workspace`: Workspace File System adapters and inspection helpers.

Learn more at [vitehub.dev](https://vitehub.dev).
