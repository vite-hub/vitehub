# KV Package

KV Package names ownership boundaries for `@vitehub/kv`.

## Language

**KV Package**:
The package that owns KV Stores, Default KV Store behavior, and KV Store Selection.
_Avoid_: Chat state package, namespace package

**Internal KV Coordination API**:
The non-public KV Package surface used by ViteHub runtime behavior that needs coordination guarantees.
_Avoid_: Public lock API, Chat lock API

## Relationships

- The **KV Package** owns named KV Store configuration and runtime selection.
- The **KV Package** owns generated KV Store Name types.
- The **KV Package** preserves Default KV Store ergonomics.
- The **KV Package** can expose an **Internal KV Coordination API** to ViteHub packages.
- Chat State can use the **Internal KV Coordination API** when it targets a KV Store.
- Application code can use the same configured KV Stores through the normal KV Package API.

## Example Dialogue

> **Dev:** "Should Chat implement its own distributed lock on top of `kv.get()` and `kv.set()`?"
> **Domain expert:** "No. The **KV Package** owns the coordination guarantee through an **Internal KV Coordination API**."

## Flagged Ambiguities

- KV locking was considered a public KV feature - resolved: coordination starts as an **Internal KV Coordination API** for ViteHub runtime users.
- Chat State was considered as hiding KV Stores from application code - resolved: Chat references KV Stores, but the **KV Package** remains the public access point for normal reads and writes.
- KV Store names were considered untyped runtime strings - resolved: the **KV Package** generates shared store-name types used by `kv.store(...)`.
