# ViteHub CLI Uses Package-Contributed Features

ViteHub CLI is a central command shell backed by internal CLI Primitives, while package integrations act as CLI Contributors for their own domain-owned command namespaces and features. The first command is `vitehub agent eval`: `agent` is the Agent Package namespace and `eval` is the Agent Eval Runner feature. This keeps the public API focused on command behavior, avoids exposing a command-builder API to application developers, and preserves ADR 0010 by keeping Evalite as an execution engine rather than the public abstraction.

## Considered Options

- A standalone Evalite wrapper CLI was rejected because ViteHub Agent Evals are the public domain model and Evalite is only the first runner.
- A flat `vitehub eval` command was rejected as the canonical command because command ownership should follow package/domain boundaries before convenience aliases exist.
- A repository-level `vitehub.config.ts` was rejected because durable defaults should come from built-in ViteHub behavior or existing Vite/Nitro integration options.
- Nitro-module-driven CLI registration was rejected as the primary model because Nitro integrations own server/runtime wiring, while the ViteHub CLI owns command assembly and public command behavior.

## Consequences

Package integrations can contribute CLI Command Namespaces and CLI Features through internal CLI Primitives. The CLI shell is responsible for assembling the command tree, help, output modes, errors, and exit behavior according to Peter Steinberger's create-cli skill and reference guidance. Future shortcuts such as `vitehub eval` may be aliases, but `vitehub agent eval` remains the canonical API unless a later ADR changes the command ownership model.
