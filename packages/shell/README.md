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

For writable access, pass `useWorkspace(name, { mode: "write" }).fs` directly to `createWritableWorkspaceFs()`. The adapter accepts Workspace writes that return revision receipts. Its `writeFile()` and `appendFile()` methods wait for the write and return `void`.

## Providers and boundaries

- `@vite-hub/shell/providers/just-bash` runs selected commands in `just-bash` against a supplied filesystem adapter.
- `@vite-hub/shell/providers/cloudflare` adapts a Cloudflare execution client and reports the boundary that client can prove.
- A custom `ShellExecutionProvider` declares its boundary and implements execution for another host.

Custom providers can return Shell Processes as class instances. Sessions read the process ID, command, and working directory from the provider handle when inspected. These public metadata fields are readonly. A failed metadata read does not prevent process cleanup.

Shell policy can bound calls, processes, output size, and timeouts. A declared boundary describes the provider contract; it is not proof of operating-system isolation. Use [Sandbox](https://vitehub.dev/docs/sandbox) when work needs provider-managed isolation.

Custom providers can return Shell Observations as class instances. Sessions preserve every declared observation field, including fields exposed through getters.

The Workspace filesystem has a virtual root at `/workspace`. Root existence checks return true. On a writable filesystem, recursive directory creation at the root succeeds without changing the Workspace. Creating the root without `recursive` fails because it already exists.

The Just Bash `commands` list also applies to controlled `curl` requests. A Source network grant permits access to its declared target, but `curl` must still be included when you configure a command list.

The provider copies the command list at creation. Later changes to the supplied list do not change its permissions or network boundary.

The writable Workspace filesystem leaves content unchanged when a move resolves to the same source and destination. Missing sources fail. It rejects moves into descendants before changing content.

Workspace filesystem adapters preserve binary output from redirection and `tee`. Their read, write, and append methods honor Just Bash encoding options.

Just Bash defaults to `/workspace`. A provider `cwd` changes that default, and an `exec` `cwd` takes precedence. The provider reports the selected directory in its observations. Set `cwd` for a custom filesystem with another root.

Appending creates an absent Workspace file. A read failure for an existing file fails the append before changing its content.

## Use with Agents

`workspaceShell()` in [`@vite-hub/agent`](../agent/README.md) exposes scoped shell work through an Agent Capability. It attaches Workspace Scope, Shell policy, metadata, and tools to the Agent Definition; do not expose an unrestricted raw runtime to a model.

Built on [just-bash](https://www.npmjs.com/package/just-bash) for the built-in shell provider and [sh-syntax](https://www.npmjs.com/package/sh-syntax) for command analysis.

Read the complete [Shell guide](https://vitehub.dev/docs/shell), the [Workspace shell Capability](https://vitehub.dev/docs/workspace/agent-capability), and the [official Capabilities guide](https://vitehub.dev/docs/agents/capabilities/official).
