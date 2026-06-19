# Blob

Blob names object/file storage primitives and configured stores.

## Language

**Blob**:
The ViteHub object storage primitive for files, streams, binary bodies, and objects with metadata.
_Avoid_: Workspace, Capability

**Blob Capability**:
An Agent Capability that exposes direct model-facing access to Blob objects and metadata.
_Avoid_: Workspace Capability, file-tree access

**Blob Store**:
A named configured Blob backend that code and ViteHub storage layers can target.
_Avoid_: Bucket, adapter, binding

**Default Blob Store**:
The Blob Store used when code does not select a named Blob Store.
_Avoid_: Singleton, unnamed Blob, global Blob

**Blob Store Selection**:
The act of choosing a Blob Store by name from the Blob primitive.
_Avoid_: Adapter selection, bucket binding

**Runtime-Native Blob Store**:
A Blob Store backed by storage that the hosting runtime exposes directly.
_Avoid_: Bundled store, SDK-free driver

**SDK-Backed Blob Store**:
A Blob Store backed by a provider SDK that must be available to runtime code.
_Avoid_: Bundled store, npm store

**Provider Output**:
The deployment artifact generated for a hosting provider.
_Avoid_: Bundle, build output, adapter output

**Driver Reachability**:
Whether a Provider Output can import and execute a Blob Store's driver at runtime.
_Avoid_: Bundling, externalization, tree-shaking

**Blob Prefix Discovery**:
Scoped object listing under a developer-provided prefix.
_Avoid_: Global browsing, object tree

## Relationships

- **Blob** can expose one or more **Blob Stores**.
- One **Blob Store** can be the **Default Blob Store**.
- Single-store Blob configuration is normalized to the **Default Blob Store**.
- Named Blob configuration declares a map of **Blob Stores**.
- Runtime code selects non-default stores through **Blob Store Selection**.
- A **Blob Capability** can use **Blob Store Selection** chosen by the developer when the Capability is attached.
- A **Provider Output** should make only selected Blob Store drivers reachable at runtime.
- **Driver Reachability** does not claim that a shared SDK has no install-time dependencies for other providers.
- A **Runtime-Native Blob Store** depends on the hosting runtime, not a provider SDK.
- An **SDK-Backed Blob Store** depends on a provider SDK being reachable at runtime.
- Workspace Stores can use **Blob Stores** for persistence.
- Workspace adds file-tree behavior and worktree-oriented DX on top of stored files.
- A **Blob Capability** exposes direct object storage and does not imply Workspace file-tree behavior.
- Agent-facing Blob reads can use **Blob Prefix Discovery** when the developer provides stable pathname conventions.

## Example Dialogue

> **Dev:** "Is a Workspace just a Blob Store?"
> **Domain expert:** "No. Blob stores files and objects. Workspace decides how those files appear in a file tree."

## Flagged Ambiguities

- Blob was described through Agent access - resolved: Blob is the storage primitive; Workspace is one consumer that adds file-tree behavior.
- "bucket" was considered for multiple Blob backends - resolved: use **Blob Store** publicly because buckets and bindings are backend details.
- "bundling" was used for provider dependency behavior - resolved: use **Driver Reachability** for whether a **Provider Output** can import a selected Blob Store driver.
- Direct Blob access was considered equivalent to Workspace file access - resolved: Workspace is the default agent-facing file-tree boundary, while **Blob Capability** is for direct object storage use cases.
- Blob listings were considered as a separate tree tool - resolved: keep scoped prefix listing inside the Blob read tool rather than adding a standalone discovery tool.
- Docker was considered as a possible Blob Store - resolved: Docker is a Provider Output context, not a Blob Store; Docker-hosted apps should use existing stores such as `fs`, `minio`, or `s3`.
