# Harness Workspace Sessions Materialize Selected Workspace Scope

Harness-backed Agent Drivers need a real working directory and session boundary rather than model-facing Workspace Tools, so ViteHub will introduce **Harness Workspace Session** as an explicit Workspace surface. A Harness Workspace Session may materialize only the **Selected Workspace Scope** for one Agent Invocation, is invocation-scoped by default, must go through Workspace Package session and persistence rules, and must not expose out-of-scope Source metadata.

This narrowly supersedes ADR 0033's deferral of scoped Source materialization for harness-backed Agent Drivers only. Generic scoped Source materialization remains deferred.

## Considered Options

- Reusing model-facing Workspace Tools for harness-backed drivers was rejected because Codex and Claude Code-style harnesses expect a filesystem, shell/session behavior, and workspace-local instructions such as `AGENTS.md`.
- Letting harness adapters perform raw checkouts was rejected because Workspace Scope, Workspace Rules, persistence, and auditability must remain ViteHub-owned.
- Reopening generic scoped Source materialization was rejected because harness-backed execution has a narrower, explicit session boundary while generic materialization can still leak source-level metadata.
- Reusing durable harness sessions implicitly from chat sessions, thread ids, or invokers was rejected because session state, filesystem residue, approval history, compaction, and cost should not survive across Agent Invocations without an explicit **Harness Session Key**.

## Consequences

A Harness Workspace Session starts after Workspace Scope resolution and exposes only scoped Workspace state to the harness. It is reused across Agent Invocations only when a driver option or Capability provides an explicit Harness Session Key. Writes and commits flow through Workspace session and store rules rather than through provider-specific checkout behavior. Harness adapters such as AI SDK `HarnessAgent` adapters sit behind the ViteHub Agent Harness Driver Contract and receive this scoped session as their Workspace surface.
