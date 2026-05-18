# Context Map

## Contexts

- [Capabilities](./contexts/capabilities/CONTEXT.md) - names the user-shareable abilities that ViteHub applications can add.
- [Agents](./contexts/agents/CONTEXT.md) - names agent definitions, invocations, and agent-owned runtime behavior.
- [KV](./contexts/kv/CONTEXT.md) - names key-value storage primitives and configured stores.
- [Blob](./contexts/blob/CONTEXT.md) - names object/file storage primitives and configured stores.
- [Workspace](./contexts/workspace/CONTEXT.md) - names persistent file-tree state and source ingestion.

## Relationships

- **Capabilities -> Packages**: Capabilities can be realized by one or more packages.
- **Capabilities -> Workspace**: Capabilities can read from or write to workspace paths when the Agent exposes a workspace.
- **Agents -> Capabilities**: Agents attach Capabilities to receive inputs, alter runs, and expose abilities.
- **Agents -> Workspace**: Agents can own or reference a Workspace for persistent file-tree state.
- **Workspace -> Blob**: Hosted Workspace stores can use Blob-backed providers without exposing Blob as an Agent Capability.
- **Agents -> KV**: Agent-owned runtime behavior can use KV stores internally when configured by ViteHub primitives.
