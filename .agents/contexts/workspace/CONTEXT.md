# Workspace

Workspace names persistent file-tree state and source ingestion for agent-oriented Vite and Nitro apps.

## Language

**Workspace**:
A named persistent file tree that agents and server code can inspect, mutate when allowed, snapshot, and sync into execution runtimes.

**Source**:
A named origin that contributes read-only files or items into a **Workspace**.
_Avoid_: Input, files, context, resource, mount

**Source Map**:
The keyed object that declares a **Workspace's** Sources.
_Avoid_: Source list, source array

**Mount**:
The placement of a **Source** inside a **Workspace** file tree.
_Avoid_: Source

**Source-Backed Path**:
A workspace path whose contents come from a **Source**.
_Avoid_: Editable source file, synced file

**Source Sync**:
An explicit future mechanism that reconciles **Source-Backed Paths** with their **Sources**.
_Avoid_: Implicit write-back, normal workspace write

## Relationships

- A **Workspace** has zero or more **Sources**.
- A **Workspace** declares **Sources** through one **Source Map**.
- A **Source Map** key is the canonical identity of its **Source**.
- A **Source** has zero or one **Mount**.
- A **Mount** belongs to exactly one **Source**.
- A **Source-Backed Path** belongs to exactly one **Source**.
- Current workspace writes target normal **Workspace** paths, not **Source-Backed Paths**.
- **Source Sync** is distinct from normal workspace writes.

## Example Dialogue

> **Dev:** "Should we rename `workspace.sources` to `workspace.mounts`?"
> **Domain expert:** "No - a **Source** is the origin. The **Mount** only says where that source appears inside the **Workspace**."

## Flagged Ambiguities

- "source" can mean source code, provenance, or data connector - resolved: in Workspace, **Source** means a named origin that contributes files or items.
- "mount" was considered as the name for `workspace.sources` - resolved: **Mount** is only the placement of a **Source** inside the **Workspace**.
- "source-backed paths are read-only" was considered permanent domain language - resolved: they are read-only for current workspace writes, but future **Source Sync** may explicitly reconcile them with local or remote sources.
- `workspace.sources` was considered as an array for simple one-off Sources - resolved: use a **Source Map** so every Source has stable identity.
- `WorkspaceSource.name` was considered as canonical Source identity - resolved: the **Source Map** key is the canonical Source identity.
