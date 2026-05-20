# Context Map

## Guide

- [Domain Docs](./domain.md) - explains how agents should consume this repo's domain documentation.

## Contexts

- [Framework Integrations](./contexts/framework-integrations/CONTEXT.md) - names Vite, Nitro, discovery, runtime registry, and option lifecycle boundaries.
- [Capabilities](./contexts/capabilities/CONTEXT.md) - names user-shareable abilities that agents can attach.
- [Agents](./contexts/agents/CONTEXT.md) - names agent definitions, invocations, and agent-owned runtime behavior.
- [KV](./contexts/kv/CONTEXT.md) - names key-value storage primitives and configured stores.
- [Blob](./contexts/blob/CONTEXT.md) - names object/file storage primitives and configured stores.
- [Workspace](./contexts/workspace/CONTEXT.md) - names persistent file-tree state and source ingestion.
- [Agent Package](./contexts/packages/agent/CONTEXT.md) - names ownership boundaries for `@vitehub/agent`.
- [Blob Package](./contexts/packages/blob/CONTEXT.md) - names ownership boundaries for `@vitehub/blob`.
- [DB Package](./contexts/packages/db/CONTEXT.md) - names ownership boundaries for `@vitehub/db`.
- [Env Package](./contexts/packages/env/CONTEXT.md) - names ownership boundaries for `@vitehub/env`.
- [KV Package](./contexts/packages/kv/CONTEXT.md) - names ownership boundaries for `@vitehub/kv`.
- [Queue Package](./contexts/packages/queue/CONTEXT.md) - names ownership boundaries for `@vitehub/queue`.
- [Runtime Package](./contexts/packages/runtime/CONTEXT.md) - names ownership boundaries for `@vitehub/runtime`.
- [Sandbox Package](./contexts/packages/sandbox/CONTEXT.md) - names ownership boundaries for `@vitehub/sandbox`.
- [Shell Package](./contexts/packages/shell/CONTEXT.md) - names ownership boundaries for `@vitehub/shell`.
- [Unsource Package](./contexts/packages/unsource/CONTEXT.md) - names ownership boundaries for `@vitehub/unsource`.
- [Workflow Package](./contexts/packages/workflow/CONTEXT.md) - names ownership boundaries for `@vitehub/workflow`.
- [Workspace Package](./contexts/packages/workspace/CONTEXT.md) - names ownership boundaries for `@vitehub/workspace`.

## Relationships

- **Framework Integrations -> Packages**: Packages use framework integrations to discover definitions, generate runtime registries, and bind provider output.
- **Capabilities -> Agents**: Agents attach Capabilities to expose user-shareable abilities.
- **Agents -> Workspace**: Agents can reference Workspaces for persistent file-tree state.
- **Workspace -> Blob**: Workspace Stores can use Blob Stores for persistence while Workspace owns file-tree behavior.
- **Agents -> KV**: Agent-owned runtime behavior can use KV Stores internally when configured by ViteHub primitives.
- **Packages -> Domain Contexts**: Package contexts define ownership boundaries; domain contexts define shared vocabulary.

## Maintenance

When adding a new context glossary under `contexts/`, add it to this map.
