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
_Avoid_: Public lock API, Chat lock, adapter lock

## Relationships

- **KV** can expose one or more **KV Stores**.
- One **KV Store** can be the **Default KV Store**.
- A **Dedicated KV Store** is a **KV Store**.
- Existing singleton KV usage targets the **Default KV Store**.
- Single-store KV configuration is normalized to the **Default KV Store**.
- Named KV configuration declares a map of **KV Stores**.
- Runtime code selects non-default stores through **KV Store Selection** using a **KV Store Name**.
- Invalid **KV Store Names** fail during build-time validation and runtime selection.
- A **KV Store** may provide **KV Coordination**.
- Agent-owned runtime behavior can target a **KV Store** without exposing backend adapters publicly.
- Application code can read and write configured **KV Stores** through the normal KV primitive API.

## Example Dialogue

> **Dev:** "Should Chat accept a Chat SDK KV adapter?"
> **Domain expert:** "No. Chat can target a **KV Store**; ViteHub owns the adapter."

## Flagged Ambiguities

- "namespace" was considered for multiple KV backends - resolved: use **KV Store** publicly because provider namespaces and bindings are backend details.
- Chat state adapter configuration was considered user-facing - resolved: Chat may use a **KV Store** through ViteHub-managed Chat State, but users do not provide backend adapters.
- Named KV APIs were considered as separate exports - resolved: keep the default `kv` API and add store selection such as `kv.store("chat")`.
- KV Store Selection was considered runtime-only validation - resolved: generate **KV Store Name** types at build time and use them in `kv.store(...)`.
- Build-time KV Store Name validation was considered sufficient - resolved: also validate **KV Store Names** at runtime for JavaScript, dynamic values, and config drift.
- Locking was considered a Chat-specific concept - resolved: Chat needs coordination, but the backend guarantee belongs to **KV Coordination** or another storage primitive with equivalent semantics.
- Coordination support was considered configurable per storage entry - resolved: a backing store either supports **KV Coordination** or falls back to best-effort behavior with diagnostics.
- Chat State configuration was considered as owning KV configuration - resolved: the **KV Package** owns KV Store configuration and normal KV access; Chat only references configured stores.
- Default KV Store usage for Chat State was considered a future hard error - resolved: allow it permanently, but warn and recommend a **Dedicated KV Store**.
