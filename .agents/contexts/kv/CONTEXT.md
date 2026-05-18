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

**KV Store Selection**:
The act of choosing a KV Store by name from the KV primitive.
_Avoid_: Adapter selection, namespace binding

**KV Coordination**:
Internal concurrency guarantees provided by a KV Store for ViteHub runtime behavior.
_Avoid_: Public lock API, Chat lock, adapter lock

## Relationships

- **KV** can expose one or more **KV Stores**.
- One **KV Store** can be the **Default KV Store**.
- Existing singleton KV usage targets the **Default KV Store**.
- Single-store KV configuration is normalized to the **Default KV Store**.
- Named KV configuration declares a map of **KV Stores**.
- Runtime code selects non-default stores through **KV Store Selection**.
- A **KV Store** may provide **KV Coordination**.
- Agent-owned runtime behavior can target a **KV Store** without exposing backend adapters publicly.

## Example Dialogue

> **Dev:** "Should Chat accept a Chat SDK KV adapter?"
> **Domain expert:** "No. Chat can target a **KV Store**; ViteHub owns the adapter."

## Flagged Ambiguities

- "namespace" was considered for multiple KV backends - resolved: use **KV Store** publicly because provider namespaces and bindings are backend details.
- Chat state adapter configuration was considered user-facing - resolved: users may select a **KV Store**, not provide a backend adapter.
- Named KV APIs were considered as separate exports - resolved: keep the default `kv` API and add store selection such as `kv.store("chat")`.
- Locking was considered a Chat-specific concept - resolved: Chat needs coordination, but the backend guarantee belongs to **KV Coordination** or another storage primitive with equivalent semantics.
