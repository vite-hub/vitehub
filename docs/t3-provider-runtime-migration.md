# T3 provider runtime migration

ViteHub should use T3 Code's provider runtime for coding-agent execution and keep ViteHub responsible for Agent Definitions, Workspaces, Capabilities, Channels, Invocations, and host integration. The public Agent Definition stays simple while provider-specific session protocols and event normalization move behind T3's shared interface.

This is a breaking migration. The model-backed and custom `run` drivers remain because they serve different workloads. The AI SDK harness driver and ViteHub's Codex and Claude harness implementations leave once the T3 path covers their current behavior.

## Final interface

Users select a built-in provider without configuring a harness:

```ts
defineAgent({
  driver: "codex",
})
```

`"claude-code"`, `"cursor"`, `"grok"`, and `"opencode"` use the same path. ViteHub resolves those names to a T3 provider instance internally; T3 types and Effect values do not become part of the Agent Definition interface.

The integration belongs at ViteHub's existing `AgentAdapter` seam. One adapter owns the translation between a ViteHub invocation and T3's provider runtime:

1. Materialize the selected Workspace, instructions, Skills, attachments, and session-scoped MCP configuration.
2. Start or resume the provider session for the ViteHub thread.
3. Send the turn and translate canonical provider events into ViteHub stream events, usage, progress, approvals, and final output.
4. Map invocation input, cancellation, and cleanup to provider user input, interruption, and session lifecycle operations.
5. Write Workspace changes back through the existing Workspace session.

The T3 dependency stays behind a Node-only package edge. Worker and model-backed Agent imports must not resolve its process, SDK, or native dependency closure.

## Required T3 package

The migration consumes a versioned package, never T3 source paths or a Git submodule. The upstream request is [pingdotgg/t3code#6666](https://github.com/pingdotgg/t3code/issues/6666); [vite-hub/t3code](https://github.com/vite-hub/t3code) is the fallback fork.

The smallest usable package must expose:

- the provider session, turn, approval, user-input, snapshot, and runtime-event contracts;
- construction of the built-in Codex, Claude, Cursor, Grok, and OpenCode provider adapters;
- explicit lifecycle ownership so ViteHub can stop sessions and release processes;
- session-scoped instructions or Workspace instruction-file behavior;
- session-scoped MCP configuration without T3 server globals;
- a documented Node runtime and Effect compatibility range.

The fork should carry one extraction commit on top of upstream and publish a lockstep `@vite-hub/t3-provider-runtime` version. Updating it is an upstream rebase, the provider contract smoke, and a package release. ViteHub consumes the package normally so end users and package builds never depend on a nested repository checkout.

## Migration slices

### 1. Prove the package seam

Publish the provider runtime from the fork if upstream does not provide it first. Add a fixture that starts a fake provider through the published entry point, sends a turn, observes canonical events, interrupts it, and closes every resource. Also pack the package and run the fixture against the tarball.

This slice must not modify ViteHub's public driver behavior.

### 2. Add the T3 Agent Adapter

Add one internal T3-backed `AgentAdapter` and test it with an in-memory provider adapter. Cover:

- new and resumed threads;
- assistant, reasoning, plan, command, file-change, MCP, web-search, and subagent events;
- token usage and runtime warnings;
- approvals and structured user input;
- interruption, provider failure, and cleanup;
- streamed and generated invocation forms;
- ViteHub output rendering and final-output shaping.

Do not copy T3's event union into ViteHub. Import its contracts and keep translation exhaustive at this one seam.

### 3. Move local built-in providers

Switch `"codex"` and `"claude-code"` to the T3 adapter for local Node execution, then add `"cursor"`, `"grok"`, and `"opencode"`. Preserve the existing Agent Definition spelling while inspection reports the selected provider and the new provider-backed driver kind.

Workspace parity is required before switching a provider: instruction files, scoped materialization, local and global Skills, attachments, lazy Sources, generated files, Git baseline refresh, write-back, and auto-commit must behave through the existing Workspace interface.

### 4. Move Box execution

Keep the current harness implementation only for Agent Definitions using a Box until T3 can run through ViteHub's Box execution and filesystem interfaces. The migration is complete when the T3 package accepts that execution environment or ViteHub can materialize an equivalent provider host without weakening Workspace scope or execution authority.

Do not emulate a Box with unrestricted host execution.

### 5. Delete the harness path

After local and Box parity, remove the custom `{ harness }` driver and the built-in harness implementation. The primary deletion targets are:

- `packages/agent/src/harness-agent.ts`;
- `packages/agent/src/harness-runtime.ts`;
- `packages/agent/src/harness/codex.ts`;
- `packages/agent/src/harness/claude-code.ts`;
- Codex bridge/bootstrap patches and package-output special cases;
- `@ai-sdk/harness`, `@ai-sdk/harness-codex`, `@ai-sdk/harness-claude-code`, and the directly owned Codex SDK dependency;
- harness-specific tests superseded by provider contract and Agent Adapter tests.

The current five core harness files contain about 2,300 lines before sandbox adapters and tests. Local and Box sandbox modules move only if their behavior remains necessary at the provider-host edge; they are not deleted merely because their current names contain `harness`.

No compatibility shim is planned for custom `{ harness }` drivers. Consumers migrate to a built-in provider, a model-backed driver, or a custom `{ run }` driver.

## Release gates

Each provider switch requires all of the following:

- focused provider contract and Agent Adapter tests;
- Agent package typecheck and build;
- `vp pack` plus `publint`;
- a fresh packed consumer proving the intended Node dependency closure;
- a Worker/model consumer proving that importing unrelated Agent features does not resolve T3;
- one real local invocation covering streaming, cancellation, instructions, Skills, Workspace changes, and resume;
- one Box invocation before the harness fallback for that provider is removed.

The old implementation is deleted only after the corresponding packed and runtime checks pass. Source tests and package metadata alone are insufficient proof of the shipped dependency closure.
