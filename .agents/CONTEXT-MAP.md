# Context Map

## Contexts

- [Capabilities](./contexts/capabilities/CONTEXT.md) - names the user-shareable abilities that ViteHub applications can add.
- [Workspace](./contexts/workspace/CONTEXT.md) - names persistent file-tree state and source ingestion.

## Relationships

- **Capabilities -> Packages**: Capabilities can be realized by one or more packages.
- **Capabilities -> Workspace**: Capabilities can read from or write to workspace paths when the Agent exposes a workspace.
