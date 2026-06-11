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
- A **Source Registry** contains named Source Definitions.
- A **Source Path** is validated before source retrieval.
- A **Source Loader** retrieves items for a Source Definition.
- An **MCP Resource Source Loader** belongs in Source Package language when MCP resources are used as read-only retrievable content.
- An **MCP Resource Source Loader** does not expose executable MCP tools; those belong to the MCP Capability.
- Workspace can consume source retrieval concepts, but Workspace owns file-tree placement and persistence.
- Source Package does not own v1 Source Instructions; Workspace Package owns Source helper metadata for Workspace-backed Agent prompt composition.

## Example Dialogue

> **Dev:** "Is a Source Package source the same as a Workspace Source?"
> **Domain expert:** "No. **Source Package** owns retrieval. Workspace owns where retrieved content appears in a file tree."

## Flagged Ambiguities

- Source retrieval and Workspace file placement were considered one concept - resolved: Source Package owns retrieval, Workspace owns file-tree placement.
- MCP resources and MCP tools were considered one ViteHub integration surface - resolved: read-only MCP resources belong to Source retrieval, while executable MCP tools belong to the MCP Capability.
- Adding Source Instructions to Source Definitions was considered - resolved: keep v1 Source Instructions on Workspace Source helpers because prompt composition is Workspace-backed Agent behavior.
