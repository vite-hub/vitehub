# ViteHub

Start with `.agents/domain.md`, then use `.agents/CONTEXT-MAP.md` to find the context glossaries relevant to the work.

## Current Status

ViteHub is still in active development. Optimize changes for the final design, even when that means introducing breaking changes, removing legacy code, or dropping backwards compatibility.

Development-only agent guidance belongs under `.agents/`. Do not add new development-context files under `docs/agents/` or `docs/contexts/`; use `.agents/` instead.

## Project Direction

ViteHub is server primitives for any host: the missing server layer for the UnJS ecosystem, plus agent definitions shaped with the same kind of developer-experience discipline that Better Auth applies to auth.

This should be a bold project. ViteHub depends on primitives built by others, but its value is the glue, boundaries, and developer experience that make those primitives obvious to use. When planning, do not be afraid to suggest ambitious approaches if they make the final API clearer or more powerful.

## Reference Points

Use Lakebed's agent guidance as the tone reference: a direct letter to the agent working in the repo, written for collaboration on ambitious agent infrastructure rather than passive project documentation. Keep the distinction clear: "you" means the agent working in this repo; "agents" means the agents ViteHub users will build with ViteHub.

Use Better Auth as the reference for composability. ViteHub should make it natural to add plugins and capabilities around Agent Definitions so users can build their own agent systems without ViteHub owning every feature directly.

Use UnJS as the reference for provider-agnostic server primitives. ViteHub should focus on the server primitives that are missing: host-independent runtime behavior, discovery, storage, scheduling, invocation, inspection, and deployment boundaries that can work across frameworks and providers.

## Build Primitives, Not Everything

Avoid feature creep. Assume users can use their agents to build product-specific surfaces around ViteHub primitives.

Do build reusable primitives that no developer should have to rebuild from scratch: Agent Definitions, Capabilities, Workspaces, Sources, runtime invocation, storage, scheduling, inspection, and framework integration.

Do not default to building every possible UI or app-level workflow. If an agent can reasonably compose it from ViteHub primitives, prefer making the primitives better.

## Fight For The Obvious API

Avoid cleverness that only looks elegant from inside the implementation. The best ViteHub APIs should feel obvious enough that an agent or developer would assume they already work that way.

"Simple" and "obvious" are not always the same. Sometimes the obvious API needs more internal machinery. Prefer the obvious external contract when the implementation cost is justified.

Push back when a design makes users understand internal plumbing, framework-specific details, or compatibility history before they can do normal work.

## Agent-First Runtime Design

Design APIs for agents writing apps, not humans browsing docs. Reference-style APIs from UnJS are a good model: small, composable, discoverable, and easy to inspect.

Every runtime feature should be inspectable by an agent. Prefer code and CLI control over dashboards. Generated state, runtime bindings, discovered definitions, and provider output should have a concrete way to be inspected locally.

Agents need familiar affordances. It is acceptable to simulate filesystems, tools, shells, and other expected interfaces when that makes agent work easier, but do not blur real contracts. Durability, isolation, security, persistence, cost, and production readiness must be explicit.

## Default Rules

- Preserve the core ViteHub abstractions above local convenience.
- Prefer code and CLI control over dashboard-only workflows.
- Prefer existing libraries and tools when they fit, but keep ViteHub developer experience in charge.
- Make the obvious agent assumption true when possible.
- Keep framework-specific details behind ViteHub language unless the framework boundary is the subject of the work.
- Treat app-level workarounds found in downstream projects as possible upstream ViteHub gaps unless they are clearly app-specific.
- If a rule should be ignored, say why explicitly before doing it.

## Language Layers

Use the repo's domain vocabulary when discussing architecture or behavior:

1. **ViteHub framework language**: use this for `@vitehub/*`, Agent Definitions, Capabilities, Workspaces, Sources, Agent Invocations, framework integrations, runtime behavior, and upstream design.
2. **Package language**: use this for ownership boundaries inside specific packages. Read the relevant package context under `.agents/contexts/packages/`.

If a needed concept is missing from the glossary, flag that the language needs to be resolved instead of inventing near-synonyms.

## Parallel Work

Assume other agents may be working in parallel. Do not overwrite changes you did not make. If a collision appears, inspect it carefully and adapt your work around it rather than reverting someone else's work.
