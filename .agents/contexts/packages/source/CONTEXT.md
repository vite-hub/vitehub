# Source Package

Source Package names ownership boundaries for `@vite-hub/source`.

## Language

**Source Package**:
The package that owns typed source retrieval primitives.
_Avoid_: Workspace package, loader package

**Source Definition**:
A portable declaration of a retrievable source.
_Avoid_: Workspace Source, file mount

**Source Registry**:
The runtime registry of named Source Definitions.
_Avoid_: Workspace source map, loader list

**Source Path**:
A validated path used to retrieve an item from a Source Definition.
_Avoid_: Filesystem path, mount path

**Source Loader**:
The source-specific retrieval behavior for files, globs, markdown, GitHub, or custom data.
_Avoid_: Workspace loader, build plugin

**MCP Resource Source Loader**:
A Source Loader that retrieves read-only MCP resources from an external MCP Server as Source items.
_Avoid_: MCP tool bridge, Agent Capability, MCP server implementation

## Relationships

- The **Source Package** owns **Source Definitions**.
- Source Loader helpers can create **Source Definitions**.
- A **Source Registry** contains named Source Definitions.
- A **Source Path** is validated before source retrieval.
- A **Source Loader** retrieves items for a Source Definition.
- Named Source Loader imports are the preferred Source Package authoring shape.
- An **MCP Resource Source Loader** belongs in Source Package language when MCP resources are used as read-only retrievable content.
- An **MCP Resource Source Loader** does not expose executable MCP tools; those belong to the MCP Capability.
- Workspace can consume source retrieval concepts, but Workspace owns file-tree placement and persistence.
- Workspace Source Bindings can reference **Source Definitions** without moving Workspace placement or sync policy into the Source Package.
- Workspace Source Bindings can give Source Definition retrieval methods Source Sync Inventory meaning without moving Source Sync ownership into the Source Package.
- Source Package does not own model-facing Source Instructions; Agent Package records Source Instruction Coverage from Agent Driver Instructions.

## Example Dialogue

> **Dev:** "Is a Source Package source the same as a Workspace Source?"
> **Domain expert:** "No. **Source Package** owns retrieval. Workspace owns where retrieved content appears in a file tree."

## Flagged Ambiguities

- Source retrieval and Workspace file placement were considered one concept - resolved: Source Package owns retrieval, Workspace owns file-tree placement.
- Source Definition metadata was considered the place for Workspace Source Sync Policy - resolved: Workspace Source Bindings own Workspace-specific placement and Source Sync Policy.
- `source.<helper>` namespace authoring was considered the preferred Source Package style - resolved: named Source Loader imports are the only public Source Package authoring shape.
- Requiring custom Workspace Sources to use Workspace-specific source helpers was considered - resolved: custom retrieval behavior can be declared as Source Package **Source Definitions** or inline Workspace Source Binding Inputs.
- Treating `getKeys` completeness as a Source Package invariant was considered - resolved: completeness is a Workspace Source Sync concern only when a Workspace Source Binding enables stale removal.
- MCP resources and MCP tools were considered one ViteHub integration surface - resolved: read-only MCP resources belong to Source retrieval, while executable MCP tools belong to the MCP Capability.
- Adding Source Instructions to Source Definitions was considered - resolved: do not put model-facing prose on Source Definitions; use Source Instruction Coverage in Agent Driver Instructions instead.
