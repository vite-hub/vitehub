# Workspace Package

Workspace Package names ownership boundaries for `@vitehub/workspace`.

## Language

**Workspace Package**:
The package that owns Workspace definitions, Workspace Stores, Sources, and agent-facing file-tree access.
_Avoid_: Blob package, source package

**Workspace Definition**:
A portable declaration of a named Workspace.
_Avoid_: Workspace Store, source map

**Workspace Runtime Surface**:
The runtime access point for reading, writing, snapshotting, diffing, and opening a Workspace.
_Avoid_: Store adapter, file system

**Workspace Asset Surface**:
The generated read-only runtime access point for build-time Workspace assets.
_Avoid_: Workspace Store, Source

## Relationships

- The **Workspace Package** owns **Workspace Definitions**.
- The **Workspace Package** owns Workspace Stores.
- A Workspace Store can be backed by a Blob Store.
- The **Workspace Runtime Surface** enforces Workspace Rules before writes reach the store.
- The **Workspace Asset Surface** exposes build-time readable assets.
- Agents access files through Workspace when Workspace is the boundary.

## Example Dialogue

> **Dev:** "If an agent writes a file that lands in Blob, is that a Blob Capability?"
> **Domain expert:** "No. The agent uses Workspace; the Workspace Store may be Blob-backed."

## Flagged Ambiguities

- Blob-backed Workspace persistence was considered equivalent to direct Blob access - resolved: Workspace owns the agent-facing file-tree boundary.
- Workspace assets were considered the same as mutable Workspace files - resolved: **Workspace Asset Surface** is read-only generated access.
