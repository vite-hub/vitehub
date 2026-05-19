# Blob

Blob names object/file storage primitives and configured stores.

## Language

**Blob**:
The ViteHub object storage primitive for files, streams, binary bodies, and objects with metadata.
_Avoid_: Workspace, artifact capability

**Blob Store**:
A named configured Blob backend that code and ViteHub storage layers can target.
_Avoid_: Bucket, adapter, binding

**Default Blob Store**:
The Blob Store used when code does not select a named Blob Store.
_Avoid_: Singleton, unnamed Blob, global Blob

**Blob Store Selection**:
The act of choosing a Blob Store by name from the Blob primitive.
_Avoid_: Adapter selection, bucket binding

## Relationships

- **Blob** can expose one or more **Blob Stores**.
- One **Blob Store** can be the **Default Blob Store**.
- Single-store Blob configuration is normalized to the **Default Blob Store**.
- Named Blob configuration declares a map of **Blob Stores**.
- Runtime code selects non-default stores through **Blob Store Selection**.
- A Workspace Store can be backed by a **Blob Store**.
- Blob is not an Agent Capability when accessed through Workspace.

## Example Dialogue

> **Dev:** "Should agents get a Blob capability just because Workspace uses Blob underneath?"
> **Domain expert:** "No. File access for agents goes through Workspace when Workspace is the boundary."

## Flagged Ambiguities

- Blob was considered as an Agent Capability - resolved: Blob-backed agent file access should go through Workspace unless a separate public use case is proven.
- "bucket" was considered for multiple Blob backends - resolved: use **Blob Store** publicly because buckets and bindings are backend details.
