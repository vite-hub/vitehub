# Input Commands as Agent Capability

ViteHub will model **Input Commands** as Agent Capabilities that transform or enrich explicit user input before an Agent runs, not as chat features, shell commands, model tools, or host/session controls. Host-owned commands such as clearing chat, switching models, changing UI state, or managing permissions are a separate future concern because they mutate the surrounding chat/session/product state rather than the Agent run input.

## Consequences

`inputCommands()` is a capability factory with minimal capability-level options: `id`, `trigger`, and `commands`. Capability `id` owns identity and uniqueness; multiple `inputCommands()` instances require distinct ids. Individual commands carry the user-facing descriptions because hosts render commands, while capability-level name/description are not part of the Input Commands design.

Input Command handlers may return replacement text or a partial Agent run input. Exact parsing, chaining, and merge semantics are implementation details, but the architectural boundary is fixed: Input Commands are explicit pre-model input handling inside the Capability Lifecycle, and Host Commands belong to a later chat/host integration surface.
