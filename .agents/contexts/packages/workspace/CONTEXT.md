# Workspace Package

Workspace Package names ownership boundaries for `@vitehub/workspace`.

## Language

**Workspace Package**:
The package that owns Workspace definitions, Workspace stores, Sources, and agent-facing file-tree access.
_Avoid_: Blob package, source package

**Workspace Store**:
The configured backing store used to persist a Workspace file tree.
_Avoid_: Blob Store, Source, Chat Storage

## Relationships

- The **Workspace Package** owns Workspace Stores.
- A **Workspace Store** can be backed by a Blob Store.
- Agents access Blob-backed files through Workspace when Workspace is the boundary.
- Chat can use an Agent Workspace for Chat Storage only when that is valid for the runtime.

## Example Dialogue

> **Dev:** "If an agent writes a file that lands in Blob, is that a Blob Capability?"
> **Domain expert:** "No. The agent uses Workspace; the **Workspace Store** may be Blob-backed."

## Flagged Ambiguities

- Blob-backed Workspace persistence was considered equivalent to direct Blob access - resolved: a **Workspace Store** is the Workspace-owned boundary.
