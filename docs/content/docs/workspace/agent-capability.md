---
title: Workspace capability
description: Give an Agent Workspace inspection and file mutation tools, plus an optional allowlist of executables for Provider Drivers.
navigation.title: Agent capability
navigation.order: 5
icon: i-lucide-folder-search
---

`workspaceShell()` gives an Agent tools for the active [Workspace](/docs/workspace). Read mode adds a controlled `shell` tool for file inspection. Write mode also adds structured file mutation tools. The `commands` option adds a `workspace_exec` tool that runs allowlisted executables for Provider Drivers.

The [Workspace server API](/docs/workspace/server-api) covers application code. This page covers the Agent tools.

## Configure the Workspace shell

```ts [server/agents/support.ts]
import { defineAgent } from 'vite-hub/agent'
import { workspaceShell } from 'vite-hub/agent/capabilities'

export default defineAgent({
  driver: { model: 'openai/gpt-5.1-mini' },
  workspace: { mode: 'write' },
  capabilities: [workspaceShell({ mode: 'write' })],
})
```

Without `mode`, `workspaceShell()` uses read mode and requires only read access to the Workspace.

Provider Drivers can also run configured executables in write mode:

```ts [server/agents/coder.ts]
import { defineAgent } from 'vite-hub/agent'
import { workspaceShell } from 'vite-hub/agent/capabilities'

export default defineAgent({
  driver: { kind: 'codex' },
  workspace: { mode: 'write' },
  capabilities: [workspaceShell({ commands: ['git'], mode: 'write', timeout: 30_000 })],
})
```

## Agent-visible tool contract

| Tool | Mode | Description |
| --- | --- | --- |
| `shell` | read, write | Runs a Bash-compatible inspection command in `/workspace`. Supported commands are `pwd`, `ls`, `find`, `cat`, `head`, `tail`, `wc`, `grep`, and `rg`. Pipes, redirects, and chaining are supported. When the Workspace has API-backed Sources, a controlled `curl` reaches them through their Source Request descriptors in `.vitehub/sources/`. |
| `materialize_sources` | read, write | Materializes complete Workspace Source snapshots before shell inspection. Accepts an optional `path` prefix and `sources` list. |
| `writeFile`, `appendFile`, `makeDir`, `copyPath`, `movePath`, `deletePath` | write | Structured file mutations in the writable Workspace. |
| `workspace_exec` | write with `commands` | Runs one allowlisted executable. Accepts `command`, optional `args`, `cwd`, `env`, and `timeout`. |

Model-backed and custom-run-backed Agents receive `shell`, `materialize_sources`, and the write tools. Provider-backed Agents receive `workspace_exec` only when `commands` is configured. Without `commands`, they receive no duplicate Workspace Shell tools because they already work in the materialized Workspace with their native tools.

## How the Workspace shell works

ViteHub validates the Workspace requirement before it resolves tools. Read mode requires read access. Write mode, or any `commands` value, requires write access.

`workspace_exec` accepts only a command from the allowlist. With `commands: 'all'`, it accepts any executable name or absolute path. The tool resolves `cwd` relative to `/workspace` and rejects paths that leave it. When the call omits `timeout`, the tool uses the configured `timeout`, then 60,000 ms.

During a Provider Driver run, `workspace_exec` runs in the active provider Workspace Session, so its changes are part of the provider result. Outside an active provider session, each call opens a new Workspace Session. If the command exits with code `0`, ViteHub commits the session changes through Workspace rules with the message `workspace shell command`.

## Requirements

- An explicit Workspace on the Agent Definition.
- `workspace: { mode: 'write' }` for `mode: 'write'` or `commands`.
- A Provider Agent Driver for `commands`. Other Drivers fail with a diagnostic that points to [`sandbox()`](/docs/sandbox/agent-capability).
- A Workspace Session host that permits processes for `workspace_exec`. A host with process execution set to `none` fails the call.

## Security and approval

`workspaceShell()` has no `policy` option. The Agent can call every tool that the selected mode and `commands` expose, without approval.

- Read mode cannot change files. The `shell` tool accepts only the listed inspection commands.
- Write mode lets the Agent create, change, copy, move, and delete files that Workspace rules allow.
- `commands` entries must be executable names or absolute paths, never shell command strings. Names with whitespace, control characters, or relative path segments fail at definition time.
- `commands: 'all'` permits any executable that the Workspace Session can reach. Use it only on a trusted host.
- `workspace_exec` rejects `env` keys `PATH`, `NODE_OPTIONS`, `NODE_PATH`, and any key that starts with `LD_` or `DYLD_`.
- The Agent can set `timeout` per call, up to 2,147,483,647 ms.

Workspace Sources, rules, and Actor Scope bound visible and committed paths. They do not isolate host side effects outside the Workspace, such as network calls or processes that an executable starts.

## Driver support

| Agent Driver | Support |
| --- | --- |
| Model-backed | Receives `shell`, `materialize_sources`, and write tools in write mode. `commands` is not supported; use [`sandbox()`](/docs/sandbox/agent-capability). |
| Provider-backed | Receives no duplicate file tools. Receives `workspace_exec` through the provider MCP bridge when `commands` is set. |
| Custom-run-backed | Receives the same tools as model-backed Agents in `driver.run({ tools })`. `commands` is not supported. |

## Verify the Workspace shell

1. Run `vitehub agent info --agent <name> --json` while the Vite development server runs.
2. Confirm that `tools` contains a `workspaceShell` entry. Its `commands` list shows the inspection commands in read mode (`pwd`, `ls`, `find`, `rg`, `grep`, `cat`, `head`, `tail`, `wc`), and adds `mkdir`, `touch`, `cp`, `mv`, and `rm` in write mode.
3. For a Provider Agent with `commands`, confirm that the `workspaceShell` entry lists one `workspace_exec (<command>)` item for each allowlisted executable. Without `commands`, expect no `workspaceShell` inspection entry.
4. Set `commands` on a model-backed Agent and confirm that tool resolution fails with a diagnostic that points to `sandbox()`.

## Options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `mode` | `"read" \| "write"` | `"read"` | Selects inspection tools or inspection plus write tools. Must be `"write"` when `commands` is set. |
| `commands` | `string[] \| "all"` | none | Executable allowlist for `workspace_exec`. Provider Drivers only. |
| `timeout` | `number` | `60000` | Default `workspace_exec` timeout in milliseconds. Must be a positive number no greater than 2,147,483,647. |

## Related pages

- [Workspace primitive](/docs/workspace)
- [Shell primitive](/docs/shell)
- [Workspace context](/docs/agents/workspace-context)
- [sandbox()](/docs/sandbox/agent-capability)
- [git()](/docs/agents/capabilities/git)
- [Official Capabilities](/docs/agents/capabilities/official)
