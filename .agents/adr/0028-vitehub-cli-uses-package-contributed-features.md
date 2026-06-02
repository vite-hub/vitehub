# ViteHub CLI Uses Package-Contributed Features

Updated by [ADR 0039: Vite-First Framework Integrations](./0039-vite-first-framework-integrations.md): package-contributed CLI behavior should prefer Vite Integration surfaces and internal host-adapter behavior, not public package-specific Nitro modules.

ViteHub CLI is a central command shell backed by internal CLI Primitives, while package integrations act as CLI Contributors for their own domain-owned command namespaces and features. The first command is `vitehub agent eval`: `agent` is the Agent Package namespace and `eval` is the Agent Eval Runner feature. This keeps the public API focused on command behavior, avoids exposing a command-builder API to application developers, and preserves ADR 0010 by keeping Evalite as an execution engine rather than the public abstraction.

The CLI contributes command routing and command behavior; it does not own durable Agent Eval configuration. Durable Agent Eval Runner defaults belong to `agent.eval` on the Agent Package integration surface. CLI-specific configuration remains limited to command exposure and command plumbing, such as disabling contributed CLI features or future command aliases.

## Considered Options

- A standalone Evalite wrapper CLI was rejected because ViteHub Agent Evals are the public domain model and Evalite is only the first runner.
- A flat `vitehub eval` command was rejected as the canonical command because command ownership should follow package/domain boundaries before convenience aliases exist.
- A repository-level `vitehub.config.ts` was rejected because durable defaults should come from built-in ViteHub behavior or existing Vite Integration options.
- Host-adapter-driven CLI registration was rejected as the primary model because server host adapters own server/runtime wiring, while the ViteHub CLI owns command assembly and public command behavior.
- Putting Agent Eval execution defaults under `agent.cli.eval` was rejected because it makes command registration own package behavior that should be reusable by non-CLI Agent Eval consumers.

## Consequences

Package integrations can contribute CLI Command Namespaces and CLI Features through internal CLI Primitives. The CLI shell is responsible for assembling the command tree, help, output modes, errors, and exit behavior according to Peter Steinberger's create-cli skill and reference guidance. Future shortcuts such as `vitehub eval` may be aliases, but `vitehub agent eval` remains the canonical API unless a later ADR changes the command ownership model.

The `vitehub agent eval` command delegates Agent Eval execution to the Agent Package. The Agent Package may generate internal artifacts under `.vitehub/agent`, including Evalite-compatible config, before the command runs. Those generated artifacts are package-owned Provider Output rather than app-authored CLI config.
