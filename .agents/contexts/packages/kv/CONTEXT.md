# KV Package

KV Package names ownership boundaries for `@vitehub/kv`.

## Language

**KV Package**:
The package that owns KV Stores, Default KV Store behavior, and KV Store Selection.
_Avoid_: Cache package, namespace package

**KV Driver Boundary**:
The package boundary where provider-specific key-value drivers meet ViteHub KV behavior.
_Avoid_: Public lock API, runtime state package

**Internal KV Coordination API**:
The non-public KV Package surface used by ViteHub runtime behavior that needs coordination guarantees.
_Avoid_: Public lock API, Chat lock API

## Relationships

- The **KV Package** owns named KV Store configuration and runtime selection.
- The **KV Package** owns generated KV Store Name types.
- The **KV Package** preserves Default KV Store ergonomics.
- The **KV Driver Boundary** hides provider-specific namespace and credential details.
- The **KV Package** can expose an **Internal KV Coordination API** to ViteHub packages.

## Example Dialogue

> **Dev:** "Should a runtime feature implement its own distributed lock on top of `kv.get()` and `kv.set()`?"
> **Domain expert:** "No. The **KV Package** owns the coordination guarantee through an **Internal KV Coordination API**."

## Flagged Ambiguities

- KV locking was considered a public KV feature - resolved: coordination starts as an **Internal KV Coordination API** for ViteHub runtime users.
- KV Store names were considered untyped runtime strings - resolved: the **KV Package** owns generated store-name types.
