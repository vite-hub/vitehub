# Input Commands as Agent Capability

ViteHub will model **Input Commands** as Agent Capabilities that transform or enrich explicit user input before an Agent runs, not as chat features, shell commands, model tools, or host/session controls. Host-owned commands such as clearing chat, switching models, changing UI state, or managing permissions are a separate future concern because they mutate the surrounding chat/session/product state rather than the Agent run input.

## Consequences

`inputCommands()` is a capability factory with minimal capability-level options: `id`, `trigger`, and `commands`. Capability `id` owns identity and uniqueness; multiple `inputCommands()` instances require distinct ids. Individual commands carry the user-facing descriptions because hosts render commands, while capability-level name/description are not part of the Input Commands design.

Input Command handlers may accept by returning nothing, reject with a `Response`, return replacement text, or return a partial Agent run input. Accepting without an explicit text result removes the matched command from model input; commands that need model-facing text must opt in with replacement text or a prompt/message-shaped result. Exact parsing, chaining, and merge semantics are implementation details, but the architectural boundary is fixed: Input Commands are explicit pre-model input handling inside the Capability Lifecycle, not a place to store model-facing task instructions. Command-shaped delivery surfaces should preserve the explicit input, use Agent Trigger admission for unsupported command names, and let configured Input Commands accept, reject, or reshape matched commands before Agent Driver execution. Host Commands belong to a later chat/host integration surface.
