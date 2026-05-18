# Workspace Rules and Write Validation

Workspace write policy will live on Workspace definitions as path-scoped `rules`, reusable `plugins`, and lifecycle `hooks`. Capabilities may declare required workspace access, but they do not own path policy or write validation.

## Considered Options

- Capability-owned write policy was rejected because Skills, docs workflows, generated artifacts, and future file-producing capabilities would each need to reinvent path checks.
- Tool-owned write policy was rejected because writes can arrive through facades, AI tools, sandbox sessions, or future runtimes.
- A global module-level rule map was rejected for v1 because Workspaces are named resources with different boundaries and domains.
- Reusing `WorkspaceSource.validate` was rejected because source freshness validation and write validation are different lifecycles.

## Consequences

Workspace rules use a Nitro-style pattern map, normalize before runtime enforcement, and are checked before mutations reach the Workspace store. Workspace plugins follow the Better Auth-style factory shape by contributing the same rule and hook objects a user can write inline.

Write validation is enforced at the Workspace boundary for `writeFile`, `mkdir`, and `rm` first. Broader operations such as move/copy inherit enforcement through their underlying writes and removals until they get first-class operation contexts.
