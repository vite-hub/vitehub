# Source Package

Source Package names ownership boundaries for `@vitehub/source`.

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

## Relationships

- The **Source Package** owns **Source Definitions**.
- A **Source Registry** contains named Source Definitions.
- A **Source Path** is validated before source retrieval.
- A **Source Loader** retrieves items for a Source Definition.
- Workspace can consume source retrieval concepts, but Workspace owns file-tree placement and persistence.

## Example Dialogue

> **Dev:** "Is a Source Package source the same as a Workspace Source?"
> **Domain expert:** "No. **Source Package** owns retrieval. Workspace owns where retrieved content appears in a file tree."

## Flagged Ambiguities

- Source retrieval and Workspace file placement were considered one concept - resolved: Source Package owns retrieval, Workspace owns file-tree placement.
