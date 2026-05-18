# Agent Capabilities

ViteHub agents will use agent-scoped Capabilities created with `defineCapability` and attached through `defineAgent({ capabilities })`. Capabilities use a Better Auth-style factory object, phase-based lifecycle methods, typed mutable contexts, and optional hooks instead of raw config mutators, global `hubAgent` configuration, or tool-first extension surfaces.

## Considered Options

- Raw config mutators were rejected because they make validation, introspection, devtools, and conflict handling harder.
- Tool-first surfaces such as `agent.tools` and `workspace.tools` were rejected as the public abstraction because they expose implementation wiring instead of user-facing agent abilities.
- A public `defineTool` helper was rejected because it makes raw tools look like a first-class Agent API; custom tool definitions stay available through `CapabilityDefinition.tools`.
- Implicit adapter selection from `defineAgent({ model })` was rejected because package or model-shape detection makes provider choice surprising; model agents must select an explicit provider.
- Global module-level capabilities were rejected because capabilities affect one agent's inputs, instructions, workspace behavior, and tool access.
- Hooks-only design was rejected because phases provide a clearer primary lifecycle while hooks remain useful extension points around those phases.

## Consequences

The first official capabilities are `skills()`, `mcp()`, `bash()`, `sandbox()`, `kv()`, `blob()`, and `db()`. Capabilities are single-instance by default, run in user-provided order, and may contribute named instruction blocks that users place with instruction slots such as `{{ skills }}`, `{{ mcp }}`, and `{{ capabilities }}`.
