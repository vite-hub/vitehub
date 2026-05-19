# Blob

Blob names object/file storage primitives and configured stores.

## Language

**Blob**:
The ViteHub object storage primitive for files, streams, binary bodies, and objects with metadata.
_Avoid_: Workspace, Capability

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
- Workspace Stores can use **Blob Stores** for persistence.
- Workspace adds file-tree behavior and worktree-oriented DX on top of stored files.

## Example Dialogue

> **Dev:** "Is a Workspace just a Blob Store?"
> **Domain expert:** "No. Blob stores files and objects. Workspace decides how those files appear in a file tree."

## Flagged Ambiguities

- Blob was described through Agent access - resolved: Blob is the storage primitive; Workspace is one consumer that adds file-tree behavior.
- "bucket" was considered for multiple Blob backends - resolved: use **Blob Store** publicly because buckets and bindings are backend details.
