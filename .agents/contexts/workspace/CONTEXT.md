# Workspace

Workspace names persistent file-tree state and source ingestion for agent-oriented Vite and Nitro apps.

## Language

**Workspace**:
A named persistent file tree that agents and server code can inspect, mutate when allowed, snapshot, and sync into execution runtimes.

**Workspace Store**:
The configured backing store used to persist a Workspace file tree.
_Avoid_: Blob Store, Source, Chat State

**Colocated Workspace Definition**:
A Workspace Definition declared inline with the consumer that primarily uses it.
_Avoid_: Agent Workspace, Capability Workspace

**Workspace Source Root**:
The directory beside a Colocated Workspace Definition that contains local files explicitly declared as Sources.
_Avoid_: Project root, worktree root, automatic sibling ingestion

**Source**:
A named origin that contributes read-only files or items into a Workspace.
_Avoid_: Input, files, context, resource, mount

**Source Map**:
The keyed object that declares a Workspace's Sources.
_Avoid_: Source list, source array

**Source Namespace**:
The public authoring namespace that contains all Workspace Source helpers.
_Avoid_: Common sources, runtime sources, provider source namespace

**Mount**:
The placement of a Source inside a Workspace file tree.
_Avoid_: Source

**Source-Backed Path**:
A workspace path whose contents come from a Source.
_Avoid_: Editable source file, synced file

**Single-File Source**:
A Source that contributes exactly one build-time materialized file from the Workspace Source Root into a Workspace.
_Avoid_: Workspace file, inline file, source path

**Source Sync**:
An explicit future mechanism that reconciles Source-Backed Paths with their Sources.
_Avoid_: Implicit write-back, normal workspace write

**Workspace Rule**:
A path-scoped policy that controls reads, writes, write size, media type, and write validation.
_Avoid_: Capability rule, tool permission

**Workspace Plugin**:
A reusable Workspace extension that contributes Workspace Rules and Workspace hooks.
_Avoid_: Capability, source, loader

**Workspace Tools**:
Agent tools derived from a Workspace Definition for inspecting or mutating Workspace files.
_Avoid_: Workspace Capability, bash, raw tools

**Workspace Access Mode**:
The read or write authority requested for a Workspace runtime surface or Workspace Capability.
_Avoid_: allowWrite, writable flag, permission boolean

**Workspace File Tree**:
The single public file tree exposed by a Workspace regardless of whether a file is backed by store state, a Source, or a build-time asset.
_Avoid_: Asset workspace, runtime workspace, merged workspace

**Workspace Session**:
A runtime materialization of a Workspace that can execute commands and commit file changes back to the Workspace Store.
_Avoid_: Open workspace, sandbox, mount

## Relationships

- A **Workspace** has one **Workspace Store**.
- A **Workspace** exposes one **Workspace File Tree**.
- A **Colocated Workspace Definition** still defines a **Workspace**.
- A **Workspace Store** can be backed by a Blob Store.
- A **Workspace** has zero or more **Sources**.
- A **Workspace** declares Sources through one **Source Map**.
- A **Source Namespace** contains local, inline, tree, and provider Source helpers.
- A **Colocated Workspace Definition** has a **Workspace Source Root**.
- A **Workspace Source Root** is a `workspace/` directory beside the Colocated Workspace Definition when present, otherwise the definition directory.
- A **Source Map** key is the canonical identity of its Source.
- A **Source** has zero or one **Mount**.
- A **Source-Backed Path** belongs to exactly one Source.
- A **Single-File Source** path is relative to the Workspace Source Root.
- A **Single-File Source** can default its Mount to the Workspace root and its Source-Backed Path to the source file basename.
- Current workspace writes target normal Workspace paths, not Source-Backed Paths.
- **Source Sync** is distinct from normal workspace writes.
- A **Workspace Rule** is path-scoped.
- A **Workspace Plugin** can contribute Workspace Rules.
- An Agent with a **Colocated Workspace Definition** receives read-only **Workspace Tools** by default.
- **Workspace Tools** can be disabled or upgraded to write mode through the Workspace Definition.
- A **Workspace Access Mode** is `read` by default and must be explicit when write authority is requested.
- A **Workspace Session** starts from a Workspace runtime surface and may use a Sandbox provider behind the boundary.

## Example Dialogue

> **Dev:** "Should we rename `workspace.sources` to `workspace.mounts`?"
> **Domain expert:** "No. A **Source** is the origin. The **Mount** only says where that source appears inside the **Workspace**."

## Flagged Ambiguities

- "source" can mean source code, provenance, or data connector - resolved: in Workspace, **Source** means a named origin that contributes files or items.
- "mount" was considered as the name for `workspace.sources` - resolved: **Mount** is only the placement of a Source inside the Workspace.
- `workspace.sources` was considered as an array for simple one-off Sources - resolved: use a **Source Map** so every Source has stable identity.
- Agent `workspace: { ... }` shorthand was considered as Agent-owned configuration - resolved: treat it as a **Colocated Workspace Definition**.
- Sibling files next to a **Colocated Workspace Definition** were considered for automatic ingestion - resolved: require explicit **Sources** instead.
- Single-file Source root mounting was considered equivalent to tree Source root mounting - resolved: **Single-File Source** can use basename-at-root defaults because it contributes one build-time materialized file.
- Single-file Source paths were considered project-root paths - resolved: **Single-File Source** paths are relative to the **Workspace Source Root** and do not allow absolute paths; this applies to both shorthand and object forms.
- Single-file Source `path` was considered an inline content output path - resolved: `path` is only a local input path; inline content uses `workspacePath`.
- Single-file Sources were considered source-key mounted by default - resolved: **Single-File Sources** root-mount by default; source-key mounting is explicit.
- Workspace inspection was considered a separate Workspace Capability - resolved: **Workspace Tools** are derived from the Workspace Definition by default.
- Local and provider Source helpers were considered separate public namespaces - resolved: use one **Source Namespace** for all public Source authoring helpers.
- Workspace write authority was considered as `allowWrite: true` - resolved: use **Workspace Access Mode** language such as `mode: "write"` instead of a permission boolean.
- Build-time Workspace assets were considered a second user-facing read surface - resolved: users read one **Workspace File Tree** while asset provenance remains internal by default.
- `open()` was considered as the Workspace execution-session method - resolved: use `startSession()` because it names the **Workspace Session** lifecycle.
