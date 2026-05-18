# Chat State and Primitive-Backed Coordination

Chat will always create ViteHub-managed Chat State for coordination, while Chat History remains the public option that controls conversation replay. Chat State is configured on the `chat()` Capability, can use providers such as auto, Cloudflare, memory, workspace, or KV, and does not expose Chat SDK state adapters.

## Considered Options

- Public Chat SDK state adapters were rejected because they expose library internals and bypass ViteHub primitive validation.
- Creating runtime state only when Chat History is enabled was rejected because invocation coordination is needed even when no history is replayed.
- A named application-level Chat Storage registry was rejected for v1 because Chat is Agent-scoped and a single per-Capability Chat State config is enough.
- Treating KV as the Chat-facing abstraction was rejected because Cloudflare Durable Objects or other coordination-capable providers may be better backing state than key-value storage.
- Treating Blob as an Agent Capability was rejected because Blob-backed agent file access belongs behind Workspace.

## Consequences

KV and Blob still support named stores while preserving their default store APIs. KV needs internal coordination semantics for runtime users such as Chat, but Chat State is not KV-only.

Chat State backs both operational coordination and Chat History for v1. Separate history stores were rejected because they split operational state across lifecycles and make coordination, cleanup, and diagnostics harder.

Chat State cannot be disabled. Disabling Chat History only stops conversation replay; Chat still needs runtime state for coordination, queues, subscriptions, and dedupe.

Primitive store configuration remains with the primitive packages. For example, KV Stores are configured by `@vitehub/kv`, can still be read and written through the normal KV API, and may be referenced by Chat State when Chat uses the KV provider.

Chat State Data is reserved internal data even when the backing primitive is user-accessible. Chat must use reserved prefixes and documentation must avoid promising a stable state layout.

Using the Default KV Store for Chat State is allowed permanently but discouraged. Runtime diagnostics and docs should recommend a dedicated KV Store without turning default-store usage into a hard production error.

Chat State uses a ViteHub-owned reserved prefix by default. Prefix overrides are advanced configuration for migration or isolation, not part of the quickstart path.

Chat State does not expose a coordination mode in v1. If the selected provider supports coordination, Chat uses it; otherwise Chat falls back to best-effort behavior with diagnostics.

Chat State supports string shorthand for providers that need no extra options, such as `auto`, `memory`, `workspace`, and `cloudflare`. Providers that require configuration use object form, such as `{ provider: "kv", store: "chat" }`.

Workspace-backed Chat State requires an explicit Agent Workspace. ViteHub will not create hidden workspaces for Chat State because ownership, cleanup, and visibility would be unclear.

Explicit runtime-specific providers fail outside their runtime. For example, `state: "cloudflare"` does not silently fall back outside Cloudflare; only `state: "auto"` adapts by environment.

Chat State auto-selection chooses Cloudflare when running on Cloudflare, then Workspace when the Agent has an explicit Workspace, then memory. It does not choose KV implicitly; KV-backed Chat State requires explicit `{ provider: "kv", store: "..." }` configuration.

Chat History supports `history: true` as shorthand for default thread replay. Object form remains available for options such as `maxMessages`.
