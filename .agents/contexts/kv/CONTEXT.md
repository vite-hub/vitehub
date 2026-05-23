# KV

KV names key-value storage primitives and configured stores.

## Language

**KV**:
The ViteHub key-value storage primitive for small addressable values.
_Avoid_: Cache, database, namespace

**KV Store**:
A named configured KV backend that code and ViteHub runtime behavior can target.
_Avoid_: KV namespace, adapter, binding

**Default KV Store**:
The KV Store used when code does not select a named KV Store.
_Avoid_: Singleton, unnamed KV, global KV

**Dedicated KV Store**:
A KV Store reserved for one infrastructure concern or application data boundary.
_Avoid_: Required store, hidden store

**KV Store Selection**:
The act of choosing a KV Store by name from the KV primitive.
_Avoid_: Adapter selection, namespace binding

**KV Store Name**:
The generated typed name of a configured KV Store.
_Avoid_: Untyped string, binding name, namespace id

**KV Coordination**:
Internal concurrency guarantees provided by a KV Store for ViteHub runtime behavior.
_Avoid_: Public lock API, adapter lock

**KV Prefix Discovery**:
Scoped key listing under a developer-provided prefix.
_Avoid_: Global browsing, key tree

## Relationships

- **KV** can expose one or more **KV Stores**.
- One **KV Store** can be the **Default KV Store**.
- A **Dedicated KV Store** is a **KV Store**.
- Single-store KV configuration is normalized to the **Default KV Store**.
- Named KV configuration declares a map of **KV Stores**.
- Runtime code selects non-default stores through **KV Store Selection** using a **KV Store Name**.
- Invalid **KV Store Names** fail during build-time validation and runtime selection.
- A **KV Store** may provide **KV Coordination**.
- A KV Capability can use **KV Store Selection** chosen by the developer when the Capability is attached.
- Agent-facing KV reads can use **KV Prefix Discovery** when the developer provides stable key conventions.

## Example Dialogue

> **Dev:** "Should runtime behavior accept a raw KV adapter?"
> **Domain expert:** "No. Runtime behavior should target a **KV Store**; ViteHub owns adapter selection and validation."

## Flagged Ambiguities

- "namespace" was considered for multiple KV backends - resolved: use **KV Store** publicly because provider namespaces and bindings are backend details.
- Named KV APIs were considered as separate top-level exports - resolved: keep the default KV API and add **KV Store Selection**.
- KV listing was considered a separate agent tool - resolved: keep scoped prefix listing inside the KV read tool rather than adding a standalone discovery tool.
