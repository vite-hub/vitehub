# PR 113 Split Plan

This plan splits `vite-hub/vitehub#113` into reviewable PRs while preserving the product behavior story. Keep PRs independent by default; stack only when a code dependency is real.

## Completed Stack Foundation

1. [`#114 docs(agents): add agent context map`](https://github.com/vite-hub/vitehub/pull/114)
   Establishes `.agents/` as the agent-facing documentation home and introduces the shared language for Framework Integrations, Capabilities, Agents, storage, Workspace, and package ownership.

2. [`#115 feat: align integration option helpers`](https://github.com/vite-hub/vitehub/pull/115)
   Aligns Vite Integration helpers around **Integration Options**. Direct plugin options and config-level options follow one DX rule, with config-level options acting as the project override.

3. [`#116 feat(storage): add named stores`](https://github.com/vite-hub/vitehub/pull/116)
   Adds named KV and Blob stores. Default Runtime Helpers continue to target the default store, while `kv.store(name)` and `blob.store(name)` select configured stores.

4. [`#117 refactor(workspace)!: derive source identity from keys`](https://github.com/vite-hub/vitehub/pull/117)
   Removes duplicate source naming from Workspace sources. Configured source keys name source origins and loader contexts use `source.key`.

5. [`#118 fix(workflow): prefer inline definitions during discovery`](https://github.com/vite-hub/vitehub/pull/118)
   Makes inline Definition metadata authoritative for a handler file so suffix and flat Nitro discovery do not create a second Discovered Definition for the same file.

## Remaining Implementation Stack

6. **Agent Capability Runtime Core**
   Introduce the Capability runtime needed by `defineAgent({ capabilities })`: Capability Definitions, Capability Lifecycle, requirement validation, instruction contribution, tool contribution, and runtime resolution.

   Exclude Chat History, Agent Memory, chat devtools assets, and provider/e2e fallout unless a small shared primitive is required by the Capability Lifecycle itself.

   Likely files:

   - `packages/agent/src/capability-runtime.ts`
   - `packages/agent/src/index.ts`
   - `packages/agent/src/types.ts`
   - `packages/agent/src/ai-sdk.ts`
   - `packages/agent/src/tanstack-ai.ts`
   - `packages/agent/package.json`
   - `packages/agent/tsdown.config.ts`
   - trimmed core-runtime coverage from `packages/agent/test/capabilities.test.ts`
   - narrow updates to `packages/agent/test/runtime.test.ts` and provider tests only where runtime-core behavior changes

   Keep cleanup semantics in this PR: reverse-order close, aggregate close errors, streaming cleanup, and Response cleanup belong to the Capability Lifecycle.

   Open decision before implementation: `#113` reintroduces top-level `tools` on Agent settings, while the ADR says tools are contributed by Capabilities. Resolve this before extracting the runtime core.

7. **Chat as Agent Capability**
   Move chat behavior into `@vitehub/agent` as a Chat Capability and remove standalone `@vitehub/chat` and `@vitehub/messages` packages instead of keeping compatibility wrappers.

   Chat History stays conversation-scoped and inside the Chat Capability for this stack. It is not a standalone Capability.

   Likely files:

   - `packages/agent/src/chat/capability.ts`
   - `packages/agent/src/chat/types.ts`
   - `packages/agent/src/chat/runtime/agent-chat.ts`
   - `packages/agent/src/chat/runtime/workspace-state.ts`
   - `packages/agent/src/messages.ts`
   - `packages/agent/src/nitro/handler.ts`
   - `packages/agent/src/nitro/module.ts`
   - `packages/agent/src/vite.ts`
   - `packages/agent/package.json`
   - `packages/agent/tsdown.config.ts`
   - `packages/agent/test/messages.test.ts`
   - `packages/agent/test/workspace-state.test.ts`
   - chat-relevant parts of `packages/agent/test/providers.test.ts`, `packages/agent/test/runtime.test.ts`, and `packages/agent/test/capabilities.test.ts`
   - docs, examples, playground imports, `pnpm-workspace.yaml`, and `pnpm-lock.yaml`

   Delete standalone packages:

   - `packages/chat/**`
   - `packages/messages/**`
   - old playground chat entrypoints such as `playground/nitro/server/chat.ts`, `playground/vite/server/chat.ts`, and `playground/vite/src/server-chat.ts`

   Final grep before merge: no stale `@vitehub/chat` or `@vitehub/messages` imports except intentional migration notes.

8. **Agent Memory**
   Add the existing first-iteration Agent Memory behavior from `#113` directly on top of Agent Capability Runtime Core, not on Chat as Agent Capability.

   Keep the same scope and functions from `#113`: `memory()`, `workspaceJsonlMemoryStore()`, memory record/scope/store types, preload support, memory read/search/write/delete tools, write policy, and append-only Workspace JSONL storage.

   Likely files:

   - memory-specific code currently inside `packages/agent/src/capabilities.ts`
   - `packages/agent/test/capabilities.test.ts` memory tests
   - `packages/agent/package.json` export/dependency updates
   - public docs for Agent Memory as separate from Chat History

   Cleanup opportunity: split memory into a dedicated module such as `packages/agent/src/capabilities/memory.ts` or `packages/agent/src/memory/capability.ts`, then re-export from the public capabilities entry. This keeps `memory()` from sharing a module with unrelated official capabilities.

   Risk notes to decide during implementation:

   - `workspaceJsonlMemoryStore()` is append-only and not coordinated across concurrent invocations.
   - JSONL parse errors are ignored for resilience but may hide corruption.
   - `retention.export` and `retention.hardDelete` are typed in `#113` but not enforced.
   - default store selection uses `"agent"` when tool input omits `store`; document and test this.

9. **Agent Chat Devtools**
   Move chat-specific devtools handling and assets under Agent Package ownership after Chat as Agent Capability settles the runtime and package boundary.

   Keep this independent from Agent Memory.

   Likely files:

   - `packages/agent/src/chat/devtools.ts`
   - `packages/agent/src/chat/devtools-shared.ts`
   - `packages/agent/src/chat/nitro/devtools.ts`
   - `packages/agent/src/chat/runtime/chat-devtools-handler.ts`
   - `packages/agent/devtools-client/**`
   - `packages/devtools/devtools/chat/**`
   - `docs/app/components/playground/ChatDevtools.vue`
   - `packages/agent/src/vite.ts`

10. **Provider/E2E Hardening**
    Treat this as a bucket to split by root cause during implementation.

    Independent provider/runtime fixes should stay independent from the agent stack. Fixes caused by Chat Package Migration stack on Chat as Agent Capability or Agent Chat Devtools. Fixes caused by Agent Memory stack on Agent Memory. Keep one final e2e PR only for cross-cutting playground or deployment updates that genuinely require the full stack.

    Candidate independent splits:

    - Vercel Blob runtime/bundling hardening: `packages/blob/src/drivers/vercel.ts`, `packages/workspace/src/stores/vercel-blob.ts`, `playground/vite/build/vite-e2e.ts`, live e2e workflow updates.
    - Sandbox provider/e2e hardening: sandbox provider loader resolution, hosting detection, Nitro request context, runtime files, noExternal, sandbox tests, playground shims.
    - Chat state hardening: `packages/agent/src/chat/runtime/workspace-state.ts`, workspace state tests, KV-backed chat state, webhook state reuse. Stack this on Chat as Agent Capability and depend on named KV stores if explicit `state: { provider: "kv", store: "chat" }` remains.
    - Chat package reference removal: env/internal/workspace tests and playground config cleanup that depends on Chat Package Migration but not devtools.

## Dependency Graph

```text
Completed foundation PRs (#114-#118)
        |
        v
Agent Capability Runtime Core
        |
        +--> Chat as Agent Capability --> Agent Chat Devtools
        |
        +--> Agent Memory
        |
        +--> independent provider/e2e fixes only when needed
```

## Subagent Strategy

Use parallel subagents for the remaining implementation branches:

- **Runtime Core agent**: owns the Agent Capability Runtime Core extraction and guards against pulling chat, memory, or devtools into the base.
- **Chat Migration agent**: owns Chat as Agent Capability, package removals, Chat History ownership, docs/examples touched by the migration.
- **Memory agent**: owns Agent Memory and verifies it depends only on Agent Capability Runtime Core.
- **Devtools/E2E agent**: separates Agent Chat Devtools from provider/e2e hardening and identifies independent fixes that can target `main`.

Agents should work on disjoint branches or file ownership scopes. They must not revert edits made by other agents.

## Review Checklist

- Does the PR use **Capability**, **Capability Definition**, and **Capability Lifecycle** consistently?
- Are **Integration Options**, **Definition Options**, and **Invocation Options** kept separate?
- Does any provider choice belong in **Provider Selection** instead of runtime calls?
- Does the PR avoid treating **Chat History** as **Agent Memory**?
- Does the PR avoid putting tools directly on **Agent Definition** outside Capabilities?
- If a PR adds or keeps top-level Agent tools, does it explicitly resolve the ADR conflict?
- Does the package ownership match the relevant package context?
- If a breaking change is introduced, is the replacement API present in the same PR or a directly stacked dependency?
- If a PR is stacked, is the dependency real rather than convenient?
