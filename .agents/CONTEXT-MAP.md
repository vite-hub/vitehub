# Context Map

## Guide

- [Domain Docs](./domain.md) - explains how agents should consume this repo's domain documentation.

## Contexts

- [Framework Integrations](./contexts/framework-integrations/CONTEXT.md) - names Vite-first discovery, runtime registry, provider output, and option lifecycle boundaries.
- [Capabilities](./contexts/capabilities/CONTEXT.md) - names user-shareable abilities that agents can attach.
- [Agents](./contexts/agents/CONTEXT.md) - names agent definitions, invocations, and agent-owned runtime behavior.
- [CLI](./contexts/cli/CONTEXT.md) - names the command-line surface for ViteHub-owned developer workflows.
- [DevTools](./contexts/devtools/CONTEXT.md) - names the shared hosted development inspection surface and package-owned DevTools features.
- [KV](./contexts/kv/CONTEXT.md) - names key-value storage primitives and configured stores.
- [Blob](./contexts/blob/CONTEXT.md) - names object/file storage primitives and configured stores.
- [Workspace](./contexts/workspace/CONTEXT.md) - names persistent file-tree state and source ingestion.
- [Schedule](./contexts/schedule/CONTEXT.md) - names future and recurring runtime work.
- [Verification](./contexts/verification/CONTEXT.md) - names how the workspace proves primitives work, from offline output contracts to scheduled live smoke.
- [Agent Package](./contexts/packages/agent/CONTEXT.md) - names ownership boundaries for `@vite-hub/agent`.
- [Auth](./contexts/auth/CONTEXT.md) - names authentication primitives, users, sessions, and their boundary with Agent Actors.
- [Auth Package](./contexts/packages/auth/CONTEXT.md) - names ownership boundaries for `@vite-hub/auth`.
- [Blob Package](./contexts/packages/blob/CONTEXT.md) - names ownership boundaries for `@vite-hub/blob`.
- [Database Package](./contexts/packages/database/CONTEXT.md) - names ownership boundaries for `@vite-hub/database`.
- [DevTools Package](./contexts/packages/devtools/CONTEXT.md) - names ownership boundaries for `@vite-hub/devtools`.
- [Env Package](./contexts/packages/env/CONTEXT.md) - names ownership boundaries for `@vite-hub/env`.
- [KV Package](./contexts/packages/kv/CONTEXT.md) - names ownership boundaries for `@vite-hub/kv`.
- [Queue Package](./contexts/packages/queue/CONTEXT.md) - names ownership boundaries for `@vite-hub/queue`.
- [Runtime Package](./contexts/packages/runtime/CONTEXT.md) - names ownership boundaries for `@vite-hub/runtime`.
- [Sandbox Package](./contexts/packages/sandbox/CONTEXT.md) - names ownership boundaries for `@vite-hub/sandbox`.
- [Shell Package](./contexts/packages/shell/CONTEXT.md) - names ownership boundaries for `@vite-hub/shell`.
- [Source Package](./contexts/packages/source/CONTEXT.md) - names ownership boundaries for `@vite-hub/source`.
- [Workflow Package](./contexts/packages/workflow/CONTEXT.md) - names ownership boundaries for `@vite-hub/workflow`.
- [Workspace Package](./contexts/packages/workspace/CONTEXT.md) - names ownership boundaries for `@vite-hub/workspace`.

## Relationships

- **Framework Integrations -> Packages**: Packages use framework integrations to discover definitions, generate runtime registries, and bind provider output.
- **Framework Integrations -> DevTools**: Vite integrations register DevTools features and bridges for the hosted DevTools client.
- **Verification -> Framework Integrations**: Provider Output Contracts and Local Provider Runs assert and execute the Provider Output that Vite Integrations generate.
- **Capabilities -> Agents**: Agents attach Capabilities to expose user-shareable abilities.
- **CLI -> Packages**: The ViteHub CLI can expose package-owned workflows without making each workflow a separate product.
- **Agents -> Workspace**: Agents can reference Workspaces for persistent file-tree state.
- **Auth -> Agents**: Auth can identify an application user and session, while Agents consume Agent Actors; future bridges may map Auth state into Agent Actors without merging the concepts.
- **Auth Package -> Database Package**: Auth Database Placement uses the Database Package; the default co-locates Auth tables through a Package Database Contribution, while a dedicated Auth database remains explicit.
- **Auth Package -> KV Package**: Auth Secondary Storage uses KV Store Selection and remains opt-in even when the KV Package is installed.
- **Schedule -> Agents**: Schedule Targets can start Agent Invocations, but Schedule is not an Agent Capability.
- **Workspace -> Blob**: Workspace Stores can use Blob Stores for persistence while Workspace owns file-tree behavior.
- **Agents -> KV**: Agent-owned runtime behavior can use KV Stores internally when configured by ViteHub primitives.
- **Packages -> Domain Contexts**: Package contexts define ownership boundaries; domain contexts define shared vocabulary.

## Maintenance

When adding a new context glossary under `contexts/`, add it to this map.
