# Discovered Definition Identity and Boundary Exports

Updated by [ADR 0039: Vite-First Framework Integrations](./0039-vite-first-framework-integrations.md): location-derived Discovery Identity remains the rule, but Nitro server discovery is now an existing host convention or compatibility source rather than evidence that Nitro is a first-class public Framework Integration.

ViteHub framework discovery assigns **Discovery Identity** from the discovered file or package-defined folder convention, not from `defineX()` arguments, object options, named exports, or arbitrary source scanning. First-class discovered definitions default-export the package-owned Definition Boundary Helper directly; helper options may be build-extracted only from that direct default export for non-identity Definition Options, never to rename the definition.

## Considered Options

- Parsing `defineX({ name })`, `defineX(..., { id })`, or runtime constructors such as `createWorkflow("name", ...)` was rejected because framework discovery should not depend on arbitrary user-source parser behavior.
- Named export aggregate discovery was rejected because it creates a second identity model where exported binding names compete with file and folder conventions.
- Local binding indirection such as `const definition = defineX(...); export default definition` was rejected for build-extracted options because it turns metadata extraction into source interpretation.
- `defineSchedule("cron", handler)` was rejected because cron timing is part of the Schedule Definition, not identity, and positional syntax would make future schedule fields harder to read.

## Consequences

Discovered definitions use direct default exports such as `export default defineQueue(handler)`, `export default defineSandbox(handler, options)`, `export default defineWorkflow(handler)`, `export default defineSchedule({ cron, handler })`, and `export default defineAgent(options)`. Vite suffix files such as `src/name.agent.ts` derive identity from `name`; Nitro files such as `server/agents/name.ts` derive identity from `name`; Agent folder configs such as `server/agents/name/config.ts` remain valid because the agent folder name is the package-defined folder convention and supports colocated Workspace Definition behavior.

This is a breaking cleanup with no backwards compatibility path for wrong discovery shapes. Agent aggregate named-export discovery is removed, `defineAgent({ name })` and Agent Chat name parsing stop overriding discovered identity, Workflow inline `createWorkflow(...)` source scanning is removed from framework discovery, and Schedule `defineSchedule` options do not override schedule identity. Runtime constructors and future explicit registries may accept explicit names, but they are not framework discovery.
