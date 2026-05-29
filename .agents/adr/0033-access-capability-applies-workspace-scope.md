# Access Capability Applies Workspace Scope at Invocation Time

ViteHub will add a read-only `access()` Capability. In the first version, `access()` resolves a **Selected Workspace Scope** from an explicit resolver or developer-declared default and applies it to already-declared Workspace reads, Source-Backed Paths, and Workspace Tools before the model sees the Workspace. The Capability owns access selection and application for this surface, but it does not mutate Workspace Definitions, add Sources, change Workspace Rules, expose the scope decision to the model by default, or dynamically grant Capabilities.

## Considered Options

- Mutating Workspace Definitions from a Capability was rejected because Sources, rules, and write policy must remain visible at the Workspace boundary.
- Prompt-only filtering was rejected because the model must see only the scoped Workspace File Tree; out-of-scope paths are model-facing not-found results.
- Model-selected scope was rejected because authorization scope must come from trusted host, auth, or invocation context.
- Dynamic Capability activation was rejected because Capabilities remain a static maximum envelope; Workspace Scope can only narrow surfaces from already-attached Capabilities.
- `workspaceScope()` was rejected as the public Capability helper because future access policy can cover more than Workspace visibility, while **Workspace Scope** remains the correct domain term for the Workspace-specific boundary.
- `organization()` was rejected because it couples the Capability to one auth and business model; Workspace Scope may be selected from organization membership, customer domain, local configuration, or other trusted invocation context.
- Ambient invocation keys such as `workspaceScope` were rejected as authority; applications must use an explicit `access({ workspace: { resolve } })` resolver when scope comes from request, auth, or chat identity.
- Write grants and explicit deny rules were deferred so the first version can prove read isolation with allow-only grants and deny-by-default behavior.
- Source materialization under scoped access was deferred because it is a separate read surface that can expose source-level metadata; scoped V1 exposes normal reads, lists, searches, and shell-shaped inspection only.

## Consequences

`access({ workspace: ... })` grants can target Source keys, path prefixes, or both through **Workspace Scope Grants**. Source grants fail closed for unknown or root-mounted sources, where explicit path grants are required. A missing selected scope fails the Agent Invocation unless the developer declared a default scope, and `all` is an explicit privileged scope rather than an implicit fallback. Chat can contribute **Chat Identity** as an Agent Invocation Context Value so `access()` and other Capabilities can resolve trusted identity without making that identity model-facing by default.

Future access surfaces must be explicit sections inside `access()` rather than stretching **Workspace Scope** beyond Workspace visibility.
