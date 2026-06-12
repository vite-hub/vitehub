# Invocation-Scoped Source Resolution

ViteHub will allow Workspace Sources to resolve their concrete origin, Mount, and Source Instructions for one Agent Invocation from trusted invocation context, especially the Selected Workspace Scope. The Access Capability remains the authorization boundary; Invocation-Scoped Source Resolution is the source-shaping layer that keeps the Workspace File Tree, Source-Backed Paths, and Source Instructions aligned with the already-selected scope.

## Considered Options

- Keep Source Instructions and source options fully static: rejected because scoped support agents need the Source itself to describe and expose only the customer-specific material available in that invocation.
- Let Sources read arbitrary invoker metadata directly: rejected because it duplicates authorization logic and makes cache, fingerprint, and visibility semantics depend on opaque caller metadata.
- Let `access()` mutate Workspace Definitions: rejected because Workspace Sources, rules, and write policy must remain visible at the Workspace boundary.
- Rely on prompt-only scoping: rejected because prompt instructions cannot be the authority for Source-Backed Path visibility.

## Consequences

Resolved Source Instructions may vary per invocation when they describe the resolved Source itself. Audience, persona, and answer-style guidance still belong in Agent or Capability instructions.

Invocation-Scoped Source Resolution must fail closed and must not broaden visibility beyond the active Workspace Scope. Implementations need explicit cache and fingerprint semantics for scope-affecting source options.
