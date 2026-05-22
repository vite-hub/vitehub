# Agent Primitive Capabilities

ViteHub agents expose model-facing abilities through `defineAgent({ capabilities })`, while KV, Blob, DB, Sandbox, and Workspace remain package-level primitives configured outside the agent. Primitive capabilities such as `kv()`, `blob()`, `db()`, `workspaceShell()`, and `sandbox()` can expose those primitives to the model through tools, instructions, policy, and early requirement validation.

## Considered Options

- Root-level `tools` on agents were rejected because they bypass capability validation, introspection, devtools, and permission policy.
- A grouped `resources` or `access` object on agents was rejected for v1 because it would make Agent look like a general application runtime and duplicate primitive package configuration.
- Treating Workspace as a Capability was rejected because Workspace is the agent-visible filesystem boundary that capabilities consume.
- Implicit workspace creation for `workspaceShell()` and `sandbox()` was rejected because the developer must explicitly choose the filesystem boundary the agent can see.
- Multi-workspace public API was deferred; v1 exposes one primary workspace while internals may normalize toward named workspaces later.

## Consequences

Capabilities are an ordered list and may be factory-created or inline objects normalized internally. Capability IDs are unique within one agent. Missing primitive requirements fail as early as possible instead of auto-enabling storage or execution.

`workspaceShell()` exposes shell-shaped Workspace read/write operations and defaults to read mode. Workspace Shell, KV, Blob, and DB share `mode: 'read' | 'write'`; write mode enables mutation tools only when the backing primitive and agent workspace allow it. `kv()` and `blob()` expose conservative read/list tools in read mode and mutation tools in write mode. `db()` defaults to schema/read/query tools, with write operations available only in write mode.

`sandbox({ commands })` exposes isolated program execution, requires explicit executable names, and can run against a read-mode workspace, but write operations require write mode. `sandbox()` without commands is invalid; v1 has no default commands, command profiles, path constraints, full shell command strings, or ephemeral sandbox write semantics. Without `sandbox()`, an agent cannot execute programs.

`skills()` follows the Agent Skills spec shape only. A skill requires `SKILL.md`, represented as a generic workspace path requirement rather than Skills-specific runtime validation. Optional spec-aligned directories are `references/`, `scripts/`, and `assets/`. ViteHub does not special-case non-spec files such as `skill.meta.json` or `agents/*.yaml`, does not auto-load references, and does not execute scripts without explicit execution authority from `sandbox({ commands })`; `workspaceShell()` can inspect and mutate Workspace files but does not grant program execution.
