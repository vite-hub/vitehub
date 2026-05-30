# Workspace Package

Workspace Package names ownership boundaries for `@vite-hub/workspace`.

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
The internal generated backing layer for build-time Workspace file availability.
_Avoid_: Second Workspace, public Workspace API, Source

**Workspace Extension Surface**:
Public subpath APIs for custom Workspace loaders and publishers.
_Avoid_: Root Workspace API, internal helpers, core Workspace API

**Workspace Provider Adapter**:
An internal integration adapter that maps a hosted provider's storage product to a Workspace Store.
_Avoid_: Public store constructor, user-facing provider API

## Relationships

- The **Workspace Package** owns **Workspace Definitions**.
- The **Workspace Package** owns Workspace Stores.
- A Workspace Store can be backed by a Blob Store.
- A Workspace Store can be backed by a **Workspace Provider Adapter**.
- The **Workspace Runtime Surface** enforces Workspace Rules before writes reach the store.
- The **Workspace Asset Surface** supports the public Workspace runtime surface; it is not a second user-facing Workspace.
- The **Workspace Extension Surface** lives behind explicit subpaths, not the package root.
- Agents access files through Workspace when Workspace is the boundary.

## Example Dialogue

> **Dev:** "If an agent writes a file that lands in Blob, is that a Blob Capability?"
> **Domain expert:** "No. The agent uses Workspace; the Workspace Store may be Blob-backed."

## Flagged Ambiguities

- Blob-backed Workspace persistence was considered equivalent to direct Blob access - resolved: Workspace owns the agent-facing file-tree boundary.
- Workspace assets were considered a separate public read API - resolved: keep one public Workspace tree and treat the **Workspace Asset Surface** as an internal backing layer unless a concrete advanced workflow needs direct access.
- Workspace loaders and publishers were considered part of the root package API - resolved: keep them public only through the **Workspace Extension Surface**.
- Provider store constructors were considered public subpath exports - resolved: keep **Workspace Provider Adapters** behind configuration and generated runtime wiring, not user-facing imports.
