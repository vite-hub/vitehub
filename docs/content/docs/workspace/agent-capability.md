---
title: Workspace capability
description: Give an Agent tools to read and change Workspace files, plus an optional list of executables for Provider Drivers.
navigation.title: Agent capability
navigation.order: 5
icon: i-lucide-folder-search
---

`workspaceShell()` gives an Agent tools for the active [Workspace](/docs/workspace):

- Read mode adds a limited `shell` tool to inspect files.
- Write mode also adds tools that change files.
- The `commands` option adds `workspace_exec`, which runs allowed executables for Provider Drivers.

For application code, read the [Workspace server API](/docs/workspace/server-api).

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

Without `mode`, `workspaceShell()` uses read mode and needs only read access.

In write mode, Provider Drivers can also run the executables you list:

```ts [server/agents/coder.ts]
import { codexDriver, defineAgent } from 'vite-hub/agent'
import { workspaceShell } from 'vite-hub/agent/capabilities'

export default defineAgent({
  driver: codexDriver(),
  workspace: { mode: 'write' },
  capabilities: [workspaceShell({ commands: ['git'], mode: 'write', timeout: 30_000 })],
})
```

## Agent-visible tool contract

| Tool | Mode | Description |
| --- | --- | --- |
| `shell` | read, write | Runs a Bash-compatible inspection command in `/workspace`: `pwd`, `ls`, `find`, `cat`, `head`, `tail`, `wc`, `grep`, or `rg`. Pipes, redirects, and chaining work. For API-backed Sources, a limited `curl` reaches them through their Source Request descriptors in `.vitehub/sources/`. |
| `materialize_sources` | read, write | Copies full Source snapshots into the Workspace before shell inspection. Takes an optional `path` prefix and `sources` list. |
| `writeFile`, `appendFile`, `makeDir`, `copyPath`, `movePath`, `deletePath` | write | Change files in the writable Workspace. |
| `workspace_exec` | write with `commands` | Runs one allowed executable. Takes `command`, optional `args`, `cwd`, `env`, and `timeout`. |

Model-backed and custom-run-backed Agents get `shell`, `materialize_sources`, and the write tools. Provider-backed Agents get only `workspace_exec`, and only when `commands` is set. They already work in the copied Workspace with their own tools.

## How the Workspace shell works

ViteHub checks Workspace access before it resolves tools. Read mode needs read access. Write mode, or any `commands` value, needs write access.

`workspace_exec` accepts only commands from the list. With `commands: 'all'`, it accepts any executable name or absolute path. It resolves `cwd` from `/workspace` and rejects paths outside it. Without a `timeout` in the call, it uses the configured `timeout`, then 60,000 ms.

During a Provider Driver run, `workspace_exec` runs in the active Workspace Session, so its changes join the provider result. Outside a provider session, each call opens a new Workspace Session. If the command exits with code `0`, ViteHub commits the changes through Workspace rules with the message `workspace shell command`.

## Requirements

- A Workspace set on the Agent Definition (the `defineAgent()` file).
- `workspace: { mode: 'write' }` for `mode: 'write'` or `commands`.
- A Provider Driver for `commands`. Other Drivers fail with a diagnostic that points to [`sandbox()`](/docs/sandbox/agent-capability).
- For `workspace_exec`, a Workspace Session host that allows processes. A host with process execution set to `none` fails the call.

## Security and approval

`workspaceShell()` has no `policy` option. The Agent calls every tool that the mode and `commands` expose, without approval.

- Read mode cannot change files. The `shell` tool accepts only the listed inspection commands.
- Write mode lets the Agent create, change, copy, move, and delete files that Workspace rules allow.
- `commands` entries are executable names or absolute paths, never shell strings. Names with whitespace, control characters, or relative path segments fail at definition time.
- `commands: 'all'` allows any executable the Workspace Session can reach. Use it only on a trusted host.
- `workspace_exec` rejects `env` keys `PATH`, `NODE_OPTIONS`, `NODE_PATH`, and any key that starts with `LD_` or `DYLD_`.
- The Agent can set `timeout` per call, up to 2,147,483,647 ms.

::warning
Sources, rules, and Actor Scope limit which paths the Agent sees and commits. They do not isolate side effects outside the Workspace, such as network calls or processes that an executable starts.
::

## Driver support

| Agent Driver | Support |
| --- | --- |
| Model-backed | Gets `shell`, `materialize_sources`, and write tools in write mode. No `commands`; use [`sandbox()`](/docs/sandbox/agent-capability). |
| Provider-backed | Gets no duplicate file tools. Gets `workspace_exec` through the provider MCP bridge when `commands` is set. |
| Custom-run-backed | Gets the model-backed tools in `driver.run({ tools })`. No `commands`. |

## Verify the Workspace shell

1. Run `vitehub agent info --agent <name> --json` while the Vite dev server runs.
2. Check that `tools` has a `workspaceShell` entry. Its `commands` list shows `pwd`, `ls`, `find`, `rg`, `grep`, `cat`, `head`, `tail`, `wc` in read mode, plus `mkdir`, `touch`, `cp`, `mv`, and `rm` in write mode.
3. For a Provider Agent with `commands`, check for one `workspace_exec (<command>)` item per allowed executable. Without `commands`, expect no `workspaceShell` entry.
4. Set `commands` on a model-backed Agent. Tool resolution must fail with a diagnostic that points to `sandbox()`.

## Options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `mode` | `"read" \| "write"` | `"read"` | Inspection tools only, or inspection plus write tools. Must be `"write"` when `commands` is set. |
| `commands` | `string[] \| "all"` | none | Executables that `workspace_exec` may run. Provider Drivers only. |
| `timeout` | `number` | `60000` | Default `workspace_exec` timeout in milliseconds. A positive number up to 2,147,483,647. |

## Related pages

- [Workspace primitive](/docs/workspace)
- [Shell primitive](/docs/shell)
- [Workspace context](/docs/agents/workspace-context)
- [sandbox()](/docs/sandbox/agent-capability)
- [git()](/docs/agents/capabilities/git)
- [Official Capabilities](/docs/agents/capabilities/official)
