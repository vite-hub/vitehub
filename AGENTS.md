# ViteHub

## Current Status

ViteHub is in active development. Optimize for the final design, including breaking changes, removal of legacy code, and dropped backwards compatibility.

## Project Direction

ViteHub is server primitives for any host: the missing server layer for UnJS, plus Agent Definitions shaped with Better Auth-level developer experience.

Be ambitious when it makes the final API clearer or more powerful. ViteHub builds on others’ primitives, but its value is the glue, boundaries, and developer experience that make them obvious to use.

## Reference Points

- **Lakebed for guidance:** write directly to the agent collaborating in this repository. “You” means that contributor; “agents” means what ViteHub users build.
- **Better Auth for composition:** make plugins and Capabilities natural around Agent Definitions so users can build their own systems without ViteHub owning every feature.
- **UnJS for server primitives:** keep runtime behavior, discovery, storage, scheduling, invocation, inspection, and deployment host-independent across frameworks and providers.

## Build Primitives, Not Everything

Avoid feature creep. Build reusable primitives developers should not recreate: Agent Definitions, Capabilities, Workspaces, Sources, runtime invocation, storage, scheduling, inspection, and framework integration. If an agent can compose a product-specific UI or workflow from those primitives, improve the primitives instead of owning the surface.

## Fight For The Obvious API

Build complex things as simply as possible, and reduce complexity while solving problems. “Simple” and “obvious” differ: accept more internal machinery when it creates the external contract an agent or developer would assume already works. Push back when normal work exposes plumbing, framework details, or compatibility history.

## Agent-First Runtime Design

Design for agents writing apps, using small, composable, discoverable, inspectable APIs. Every runtime feature—including generated state, bindings, discovered definitions, and provider output—must be inspectable locally through code or CLI rather than only a dashboard.

Offer familiar affordances such as filesystems, tools, and shells when useful, but keep real contracts honest. State durability, isolation, security, persistence, cost, and production readiness explicitly.

## Patch Loop

Use `pnpm patch` in consuming projects to move fast and prove upstream fixes:

1. Patch the smallest downstream seam.
2. Verify the exact runtime failure is fixed.
3. Upstream the source fix with regression coverage.
4. Repin the consumer and delete the patch.

The fix is complete only when the consumer works without the patch. Retire combined patches hunk by hunk as their fixes land upstream.

## Default Rules

- Design source changes around the intended final contract, not the smallest diff. The smallest downstream patch is only a way to prove the fix.
- Before preserving a legacy path, search this repository and known consumers for current callers. Migrate real callers to the final contract; delete speculative compatibility unless the task names a requirement to keep it.
- Put shared behavior at the ViteHub boundary that owns it instead of duplicating policy across framework integrations or consumers.
- Verify the intended flow and any assumptions removed with the old path, including affected runtime behavior, public types, generated output, and documentation.
- Preserve ViteHub abstractions over local convenience.
- Prefer code and CLI control over dashboard-only workflows.
- Use existing libraries when they fit, while keeping ViteHub developer experience in charge.
- Make the obvious agent assumption true when possible.
- Hide framework details behind ViteHub language unless the framework boundary is the subject.
- Treat downstream workarounds as possible upstream ViteHub gaps unless they are product-specific.
- If a rule should be ignored, explain why before doing it.

## Language

Use ViteHub framework language for `@vitehub/*`, Agent Definitions, Capabilities, Workspaces, Sources, Agent Invocations, framework integrations, runtime behavior, and upstream design. Use package names for implementation ownership inside a package.

## Related Repositories

Project source folders are separate Git repositories. Apply this philosophy to ViteHub work, then follow each repository’s local instructions.

Publish this repository through a pull request by default. Push verified changes in every other related repository directly to current `main` unless the user names a branch, pull request, or review gate. Fetch first, require a clean fast-forward, preserve unrelated work, and never force-push.

## Parallel Work

Assume other agents may be working in parallel. Never overwrite their changes; inspect collisions and adapt around them instead of reverting them.
