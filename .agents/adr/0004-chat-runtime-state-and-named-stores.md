# Chat Runtime State and Named Stores

Chat will always create internal runtime state for coordination, while Chat History remains the public option that controls conversation replay. Users select Chat Storage backed by ViteHub primitives such as named KV Stores rather than providing Chat SDK state adapters, so ViteHub can validate whether the selected store provides the coordination guarantees needed for concurrent invocations.

## Considered Options

- Public Chat SDK state adapters were rejected because they expose library internals and bypass ViteHub primitive validation.
- Creating runtime state only when Chat History is enabled was rejected because invocation coordination is needed even when no history is replayed.
- Treating Blob as an Agent Capability was rejected because Blob-backed agent file access belongs behind Workspace.

## Consequences

KV and Blob support named stores while preserving their default store APIs. KV needs internal coordination semantics for runtime users such as Chat; providers that cannot offer safe coordination must be rejected or diagnosed in hosted production runtimes, while local single-process development can use best-effort coordination with explicit diagnostics.
