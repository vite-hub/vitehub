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
A named origin that exposes read-only addressable files or items through a Workspace.
_Avoid_: Input, files, context, resource, mount, connector

**Materialized Source**:
A Source whose items are written into the Workspace Store.
_Avoid_: Stored connector, synced files

**Live Source**:
A Source whose items are fetched on demand without being written into the Workspace Store by default.
_Avoid_: Virtual Source, Ephemeral Source, query tool

**Source Map**:
The keyed object that declares a Workspace's Sources.
_Avoid_: Source list, source array

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

## Relationships

- A **Workspace** has one **Workspace Store**.
- A **Colocated Workspace Definition** still defines a **Workspace**.
- A **Workspace Store** can be backed by a Blob Store.
- A **Workspace** has zero or more **Sources**.
- A **Workspace** declares Sources through one **Source Map**.
- A **Colocated Workspace Definition** has a **Workspace Source Root**.
- A **Workspace Source Root** is a `workspace/` directory beside the Colocated Workspace Definition when present, otherwise the definition directory.
- A **Source Map** key is the canonical identity of its Source.
- A **Source** has zero or one **Mount**.
- A **Source** can expose local or external read-only information when that information has addressable files or items.
- A **Source** must expose addressable files or items; query-only read tools belong outside the Source concept.
- A **Materialized Source** persists its items in the **Workspace Store**.
- A **Live Source** resolves Source-Backed Paths directly from its origin unless an explicit cache or materialization policy says otherwise.
- A **Live Source** cache is separate from the **Workspace Store** and is opt-in.
- A **Live Source** must support direct reads for known Source-Backed Paths, but it does not have to enumerate every item.
- A **Live Source** can provide search, but search results must resolve to readable Source-Backed Paths.
- A **Live Source** exposes which Workspace operations it supports for inspection surfaces such as DevTools.
- A **Source-Backed Path** belongs to exactly one Source.
- A **Single-File Source** path is relative to the Workspace Source Root.
- A **Single-File Source** can default its Mount to the Workspace root and its Source-Backed Path to the source file basename.
- Current workspace writes target normal Workspace paths, not Source-Backed Paths.
- **Source Sync** is distinct from normal workspace writes.
- A **Workspace Rule** is path-scoped.
- A **Workspace Plugin** can contribute Workspace Rules.
- An Agent with a **Colocated Workspace Definition** receives read-only **Workspace Tools** by default.
- **Workspace Tools** can be disabled or upgraded to write mode through the Workspace Definition.

## Example Dialogue

> **Dev:** "Should we rename `workspace.sources` to `workspace.mounts`?"
> **Domain expert:** "No. A **Source** is the origin. The **Mount** only says where that source appears inside the **Workspace**."

## Flagged Ambiguities

- "source" can mean source code, provenance, or data connector - resolved: in Workspace, **Source** means a named origin that exposes read-only addressable files or items.
- Query-only access to external information was considered a Source shape - resolved: a **Source** must expose addressable files or items, even when search or query helps discover them.
- Non-store-backed external Sources were called "virtual" or "ephemeral" - resolved: use **Live Source** for on-demand read-through Sources and reserve "virtual" for Vite module surfaces.
- Addressable Sources were assumed to be fully enumerable - resolved: a **Live Source** can support direct reads for known paths without global enumeration.
- Live Source search was considered mandatory - resolved: search is optional, and any search hit must resolve to a readable Source-Backed Path.
- "mount" was considered as the name for `workspace.sources` - resolved: **Mount** is only the placement of a Source inside the Workspace.
- `workspace.sources` was considered as an array for simple one-off Sources - resolved: use a **Source Map** so every Source has stable identity.
- Agent `workspace: { ... }` shorthand was considered as Agent-owned configuration - resolved: treat it as a **Colocated Workspace Definition**.
- Sibling files next to a **Colocated Workspace Definition** were considered for automatic ingestion - resolved: require explicit **Sources** instead.
- Single-file Source root mounting was considered equivalent to tree Source root mounting - resolved: **Single-File Source** can use basename-at-root defaults because it contributes one build-time materialized file.
- Single-file Source paths were considered project-root paths - resolved: **Single-File Source** paths are relative to the **Workspace Source Root** and do not allow absolute paths; this applies to both shorthand and object forms.
- Single-file Source `path` was considered an inline content output path - resolved: `path` is only a local input path; inline content uses `workspacePath`.
- Single-file Sources were considered source-key mounted by default - resolved: **Single-File Sources** root-mount by default; source-key mounting is explicit.
- Workspace inspection was considered a separate Workspace Capability - resolved: **Workspace Tools** are derived from the Workspace Definition by default.
