# Workspace Source Boundaries

Workspace remains a separate primitive for the filesystem boundary, while Capabilities only declare and consume the Workspace access they need. A colocated Agent `workspace: { ... }` is a Colocated Workspace Definition, not Agent-owned capability configuration, and sibling files are not ingested automatically; users must declare explicit Sources.

## Considered Options

- Treating Workspace as a Capability was rejected because Workspace is useful outside agent execution and is the boundary that Capabilities consume.
- Allowing Capabilities to mutate Workspace configuration was rejected because Sources, rules, and write policy must remain visible at the Workspace boundary.
- Automatically ingesting files next to a Colocated Workspace Definition was rejected because it hides the file-tree boundary and makes config/source-code exclusions surprising.
- Root-mounting Sources was deferred because it needs explicit conflict and write-policy semantics before Source-backed paths can safely share the Workspace root with normal store paths.

## Consequences

Sources ingest content into a Workspace; Capabilities expose model-facing abilities. Source keys stay relative to the Source scan base, while Mount owns Workspace placement. Local glob Sources should use familiar glob vocabulary and safe defaults, including explicit hidden-file inclusion and source-root-bound `cwd` handling.
