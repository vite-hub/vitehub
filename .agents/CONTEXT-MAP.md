# Context Map

## Contexts

- [Capabilities](./contexts/capabilities/CONTEXT.md) - names the user-shareable abilities that ViteHub applications can add.
- [Agents](./contexts/agents/CONTEXT.md) - names agent definitions, invocations, and agent-owned runtime behavior.
- [KV](./contexts/kv/CONTEXT.md) - names key-value storage primitives and configured stores.
- [Blob](./contexts/blob/CONTEXT.md) - names object/file storage primitives and configured stores.
- [Workspace](./contexts/workspace/CONTEXT.md) - names persistent file-tree state and source ingestion.
- [Agent Package](./contexts/packages/agent/CONTEXT.md) - names ownership boundaries for `@vitehub/agent`.
- [KV Package](./contexts/packages/kv/CONTEXT.md) - names ownership boundaries for `@vitehub/kv`.
- [Blob Package](./contexts/packages/blob/CONTEXT.md) - names ownership boundaries for `@vitehub/blob`.
- [Workspace Package](./contexts/packages/workspace/CONTEXT.md) - names ownership boundaries for `@vitehub/workspace`.

## Relationships

- **Capabilities -> Packages**: Capabilities can be realized by one or more packages.
- **Capabilities -> Workspace**: Capabilities can read from or write to workspace paths when the Agent exposes a workspace.
- **Agents -> Capabilities**: Agents attach Capabilities to receive inputs, alter runs, and expose abilities.
- **Agents -> Workspace**: Agents can own or reference a Workspace for persistent file-tree state.
- **Workspace -> Blob**: Hosted Workspace stores can use Blob-backed providers without exposing Blob as an Agent Capability.
- **Agents -> KV**: Agent-owned runtime behavior can use KV stores internally when configured by ViteHub primitives.
- **Agent Package -> KV Package**: `@vitehub/agent` may depend on internal KV coordination through ViteHub-owned storage selection.
- **Agent Package -> Workspace Package**: `@vitehub/agent` may persist agent-owned runtime behavior in an Agent Workspace when that is valid for the runtime.
- **Workspace Package -> Blob Package**: `@vitehub/workspace` may use Blob Stores as hosted Workspace backing stores.
