# @vite-hub/shell

<p>
  <a href="https://vitehub.dev"><img alt="ViteHub" src="https://img.shields.io/badge/ViteHub-vitehub.dev-646cff?style=flat-square"></a>
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-ready-3178c6?style=flat-square">
  <img alt="Shell" src="https://img.shields.io/badge/Shell-controlled%20runtime-18181b?style=flat-square">
</p>

`@vite-hub/shell` gives server code structured command analysis and execution with explicit filesystem, network, process, and timeout boundaries.

Applications that only need an Agent to inspect or edit its Workspace usually use the `workspaceShell()` Capability from `@vite-hub/agent/capabilities`. Install this owner package directly when you are building a Capability, Workspace adapter, or host integration.

## Install

```sh
pnpm add @vite-hub/shell
```

## Inspect a command

```ts
import { analyzeShellCommand } from "@vite-hub/shell";

const analysis = await analyzeShellCommand("rg TODO src");

console.log(analysis.commands); // ["rg"]
console.log(analysis.hasPipelines); // false
console.log(analysis.ok); // true
```

Analysis reports command names, pipelines, redirects, heredocs, and command substitution. It does not make a command safe to run. The caller's policy and the execution provider remain the enforcement boundaries.

## Run against a Workspace

The built-in Just Bash provider executes Bash-compatible commands against the filesystem adapter you give it. This example mounts a ViteHub Workspace read-only, permits four inspection commands, and returns a structured observation.

```sh
pnpm add @vite-hub/shell @vite-hub/workspace
```

```ts
// server/tasks/search-docs.ts
import { createShellRuntime } from "@vite-hub/shell";
import { createJustBashProvider } from "@vite-hub/shell/providers/just-bash";
import { createReadonlyWorkspaceFs, workspaceMountPoint } from "@vite-hub/shell/workspace";
import { useWorkspace } from "@vite-hub/workspace";

export async function searchDocs() {
  const workspace = useWorkspace("docs");
  const shell = createShellRuntime({
    policy: {
      maxOutputLength: 10_000,
      maxShellCalls: 1,
      timeout: 30_000,
    },
    provider: createJustBashProvider({
      commands: ["cat", "ls", "pwd", "rg"],
      cwd: workspaceMountPoint,
      fs: createReadonlyWorkspaceFs(workspace.fs),
    }),
  });

  return shell.exec("rg auth .", { cwd: workspaceMountPoint });
}
```

`shell.exec()` creates a short-lived Shell Session and returns a Shell Observation with `event`, `exitCode`, `stdout`, and `stderr`. The provider above has no network access, background processes, or interactive processes, and its Workspace filesystem cannot write.

## Providers and boundaries

- `@vite-hub/shell/providers/just-bash` runs selected commands in `just-bash` against a supplied filesystem adapter.
- `@vite-hub/shell/providers/cloudflare` adapts a Cloudflare execution client and reports the boundary that client can prove.
- A custom `ShellExecutionProvider` declares its boundary and implements execution for another host.

Shell policy can bound calls, processes, output size, and timeouts. A declared boundary describes the provider contract; it is not proof of operating-system isolation. Use [Sandbox](https://vitehub.dev/docs/server-primitives/sandbox) when work needs provider-managed isolation.

## Use with Agents

`workspaceShell()` in [`@vite-hub/agent`](../agent/README.md) exposes scoped shell work through an Agent Capability. It attaches Workspace Scope, Shell policy, metadata, and tools to the Agent Definition; do not expose an unrestricted raw runtime to a model.

Built on [just-bash](https://www.npmjs.com/package/just-bash) for the built-in shell provider and [sh-syntax](https://www.npmjs.com/package/sh-syntax) for command analysis.

Read the complete [Shell guide](https://vitehub.dev/docs/server-primitives/shell), the [Bash contract](https://vitehub.dev/docs/concepts/bash), and the [official Capabilities guide](https://vitehub.dev/docs/capabilities/official-capabilities).
