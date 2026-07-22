---
title: Bash
description: Understand how Capability-owned executables become one constrained Agent tool.
navigation.order: 8.5
icon: i-lucide-terminal
---

Bash is ViteHub's single model-facing execution surface for executables owned by Capabilities. Each attached Capability can contribute commands, and ViteHub combines them into one `bash` tool for the Agent Driver.

The name describes the familiar interface presented to the Agent. It does not grant an arbitrary shell: each call selects one registered executable and passes structured arguments through an executable Workspace Session.

## One Agent philosophy, not the only one

Bash supports a **code mode** philosophy: give an Agent a small execution surface and let it write code or compose commands instead of exposing every operation as a separate tool. This approach is explored by [Anthropic](https://www.anthropic.com/engineering/code-execution-with-mcp), [Vercel](https://vercel.com/blog/testing-if-bash-is-all-you-need), and [Cloudflare](https://blog.cloudflare.com/code-mode/).

ViteHub does not require every Agent to follow that philosophy. Agent Definitions can combine Bash contributions with structured tools, Capability CLIs, or other model-facing surfaces. Choose the interface that makes the Agent's work most reliable and inspectable; Bash is one composable option rather than a universal replacement for typed tools.

## One tool, Capability-owned commands

Capabilities own the executables that make their abilities useful. A browser Capability can contribute `agent-browser`, while a deployment Capability can contribute its deployment CLI.

ViteHub merges those contributions instead of exposing one model tool per integration. The Agent sees one stable `bash` tool, while each Capability keeps ownership of its executable contract, requirements, and lifecycle.

Only attached Capabilities contribute commands. Removing a Capability from the resolved Agent Definition also removes its executables from the `bash` tool.

## How a call runs

ViteHub resolves Bash in four steps:

1. The resolved Capabilities contribute their executable metadata.
2. ViteHub creates one `bash` tool whose command field accepts only those registered executables.
3. A tool call supplies the command with structured `args`, `cwd`, `env`, and `timeout` values.
4. ViteHub opens an executable Workspace Session, runs the command, commits successful Workspace changes, and closes the session.

The tool does not parse its input as a shell script. Pipes, redirects, command substitution, and chaining are unavailable unless a registered executable implements that behavior itself.

## The execution boundary

Bash contributions require an explicit writable Workspace because every call executes against a Workspace Session and can commit changes to the Workspace Store. Workspace rules and the selected Workspace Scope still control which file changes ViteHub can commit.

The Agent's Box defines where the process runs. Use a provider Box for isolated execution or `trustedHost()` when the Agent intentionally runs with the host service account's authority. Workspace never selects an execution runtime.

The executable allowlist limits which process the Agent can start. It does not make that process safe or remove its filesystem, network, credential, or child-process authority, so the Workspace runtime and host configuration remain part of the security boundary.

## How the terms fit together

| Term | Responsibility |
| --- | --- |
| `bash` Agent tool | Gives the Agent one structured execution tool containing the commands contributed by its resolved Capabilities. |
| Capability `bash` contribution | Declares an executable owned by that Capability. It is a contribution field, not a `bash()` Capability factory. |
| `workspaceShell()` | Adds a Bash-compatible `shell` inspection tool and structured Workspace mutation tools. Its optional `commands` setting creates `workspace_exec` for app-selected executables rather than contributing to the global `bash` tool. |
| Shell | Provides server-side Unix-like command runtimes, command analysis, policy boundaries, and observations. The Agent Package assembles the global `bash` tool separately and dispatches it through Workspace Sessions. |
| Workspace Session | Supplies the executable file-tree session used by a `bash` call and commits successful Workspace changes. |
| Box | Provides the execution environment used by Workspace Sessions and Agent harnesses. |
| Sandbox | Composes a named package project from Workspace and Box; it does not define or populate the global `bash` tool. |

## Choose the right surface

Contribute to `bash` when a Capability owns a real CLI and the Agent should use it through the shared execution surface. This keeps executable discovery consistent as more Capabilities attach.

Use `workspaceShell()` when the Agent needs general Workspace inspection, structured file mutation, or an app-selected `workspace_exec` allowlist. Use a structured tool or Capability CLI when the operation has a narrow typed contract that should not look like process execution.

Use the Shell primitive from server code when the application owns the command runtime directly. Use Sandbox when provider-managed isolation is the primary requirement.

## Next steps

- Add commands through [Custom capabilities](/docs/capabilities/custom-capabilities#contribute-bash-commands).
- Inspect Workspace behavior with [Workspace shell](/docs/capabilities/workspace-shell).
- Configure execution with [Workspace](/docs/server-primitives/workspace), [Shell](/docs/server-primitives/shell), and [Sandbox](/docs/server-primitives/sandbox).
