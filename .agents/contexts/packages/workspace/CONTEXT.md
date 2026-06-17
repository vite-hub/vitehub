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

**Workspace Source Binding**:
The Workspace Package declaration that binds a Source Package Source Definition into a Workspace.
_Avoid_: Source Definition, Source Loader, provider adapter

**Workspace Source Binding Input**:
The Workspace Package authoring input that normalizes into a Workspace Source Binding.
_Avoid_: Source Definition, Source Loader options only, provider namespace

**Harness Workspace Session Preparation**:
The Workspace Package helper that materializes selected Workspace files into a harness sandbox and syncs write-mode additions, updates, or deletions back through Workspace rules.
_Avoid_: Agent Package file copier, harness checkout, root sandbox config

## Relationships

- The **Workspace Package** owns **Workspace Definitions**.
- The **Workspace Package** owns Workspace Stores.
- The **Workspace Package** owns Source Sync as a Workspace lifecycle operation.
- The **Workspace Package** owns Source Sync Policy on Workspace Sources.
- The **Workspace Package** owns Source Sync Inventory for Workspace Sources.
- The **Workspace Package** owns Source Sync State as Workspace-owned metadata.
- The **Workspace Package** owns Source Sync Result from the Workspace Runtime Surface.
- The **Workspace Package** owns Workspace Source Bindings.
- The **Workspace Package** owns Workspace Source Binding Inputs.
- The **Workspace Package** owns TypeScript and runtime validation for ambiguous Workspace Source Binding Inputs.
- The **Workspace Package** owns Source Instruction metadata on Workspace Sources.
- The **Workspace Package** owns the v1 public `instructions` option on Workspace Source helpers.
- A Workspace Store can be backed by a Blob Store.
- A Workspace Store can be backed by a **Workspace Provider Adapter**.
- The **Workspace Runtime Surface** enforces Workspace Rules before writes reach the store.
- The **Workspace Runtime Surface** may expose Source Sync without making normal Workspace reads run Source Sync.
- The **Workspace Package** owns **Harness Workspace Session Preparation** for harness-backed Agent Drivers.
- **Harness Workspace Session Preparation** is consumed by the Agent Package; it is not an app-level sandbox workflow surface.
- Source Sync on the **Workspace Runtime Surface** requires explicit Source selection.
- The **Workspace Runtime Surface** exposes Source Sync through the Workspace sync lifecycle rather than a separate public Source Sync method.
- The Workspace sync lifecycle on the **Workspace Runtime Surface** requires explicit selection.
- The target **Workspace Runtime Surface** does not keep no-argument sync semantics.
- Build and dev integrations own build-time Source materialization outside the Workspace sync lifecycle.
- Downstream consumption of durable Workspace files is outside Workspace Package Source Sync semantics.
- Source Sync on the **Workspace Runtime Surface** does not imply package ownership of provider-specific Source helpers such as Airtable.
- Source Sync Policy on the **Workspace Runtime Surface** is orthogonal to Source materialization mode.
- Store snapshot and publish behavior remain Workspace Store behavior even when a Workspace lifecycle composes them after Source Sync.
- Composed Source Sync snapshot options may be boolean or object options; composed publish is a boolean v1 lifecycle option.
- Composed Store snapshot or publish behavior should be skipped after partial Source Sync failure unless the caller explicitly opts into partial publication.
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
- Source Instruction prompt rendering was considered Workspace Package ownership - resolved: Workspace exposes metadata, while Agent Package composes model instructions.
- Adding Source Instructions to the lower-level Source Package was considered - resolved: keep v1 Source Instructions on Workspace Source helpers because the behavior serves Workspace-backed Agent prompt composition.
- Source Sync was considered Source Package ownership - resolved: Source Package may own retrieval primitives, while Workspace Package owns Source-backed file-tree reconciliation into Workspace Stores.
- Source Sync eligibility was considered lower-level Source Package retrieval configuration - resolved: Workspace Package owns Source Sync Policy because it governs Workspace Store reconciliation.
- Source Sync eligibility was considered mutually exclusive with lazy materialization - resolved: keep Source Sync Policy orthogonal, while documenting the common case as a Source with Source Sync Policy and no build-time or read-triggered materialization.
- Source Sync enumeration was considered ordinary Source retrieval - resolved: Workspace Package owns Source Sync Inventory because it governs deletion-safe Workspace Store reconciliation.
- A separate Source Sync inventory method was considered mandatory for custom Sources - resolved: sync-eligible Workspace Source Bindings may use `getKeys` and `getItem` as the default Source Sync Inventory contract, with complete enumeration required for stale removal.
- Source Sync history was considered Schedule or Store ownership - resolved: Workspace Package owns compact Source Sync State, while Schedule and Store retain their own run and publication histories.
- Source Sync target registration was considered for Schedule integration - resolved: app or Schedule handlers may call the Workspace Runtime Surface directly in the first design.
- Source Sync result detail was considered path-level by default - resolved: Workspace Runtime Surface returns per-source counts by default and makes path-level result details opt-in.
- Source Sync snapshot and publish composition was considered separate-only behavior - resolved: Workspace Runtime Surface may expose explicit snapshot options and a boolean publish option for composed Source Sync lifecycles.
- Implicit all-source Source Sync was considered for the Workspace Runtime Surface - resolved: require explicit Source selection, with an explicit all-eligible selection for broad sync.
- A separate public Source Sync method was considered - resolved: use the Workspace sync lifecycle with explicit Source selection so developers do not choose between two sync verbs.
- Keeping no-argument Workspace sync for compatibility was considered - resolved: prefer the optimal breaking API where Workspace sync requires explicit selection.
- Keeping build-time Source synchronization inside Workspace sync was considered - resolved: build and dev integrations own build-time Source materialization, while Workspace sync owns explicit Source Sync.
- Treating Airtable as an official Workspace Source helper was considered - resolved: provider-specific Sources such as Airtable remain downstream/custom unless the Workspace Package explicitly adds an official adapter.
- Treating Workspace Source declarations as Source Package Source Definitions directly was considered - resolved: Workspace Source Bindings wrap or reference Source Definitions while owning Workspace-specific placement, metadata, policy, and sync behavior.
- Requiring Workspace authors to choose between a binding object and a Source helper call was considered - resolved: Workspace Source Binding Inputs may infer common Source Loaders from unambiguous plain objects and may still reference reusable or custom Source Definitions.
- Allowing ambiguous Workspace Source Binding Inputs was considered - resolved: prevent ambiguity with strong TypeScript types and reject remaining ambiguity during runtime normalization.
- Adding project-specific file consumers to the Workspace Package was considered - resolved: Workspace Package owns durable file-tree primitives, not downstream project consumption of those files.
- Copying Flue's collapsed harness shape into the Workspace Package was considered - resolved: Workspace owns materialization and writeback only; Agent Driver and Capability shape stay with the Agent Package.
