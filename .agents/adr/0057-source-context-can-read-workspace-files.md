# Source Context Can Read Workspace Files

## Status

Accepted.

## Context

Workspace Sources sometimes need the current materialized Workspace state to produce the next source output. A mirror source may read a previous generated report to preserve remote metadata, reuse unchanged assets, or compare content before writing the next materialized files.

Re-entering the Workspace runtime from inside a Source with `useWorkspace()` hides that dependency and can recursively trigger Source materialization for the same Workspace. Exposing the raw Workspace Store would avoid recursion, but it would leak provider internals and invite Source code to bypass Workspace boundaries.

## Decision

`SourceContext` may expose `workspaceFiles`, a read-only view of the current Workspace file tree backed by the active store.

This view is intentionally narrower than `Workspace` and `WorkspaceStore`:

- Sources can `readFile`, `stat`, and `exists` existing Workspace files.
- Sources cannot write, snapshot, diff, publish, configure providers, or materialize Sources through this view.
- Reads use Workspace-safe path normalization and the same file decoding contract as normal Workspace reads.
- The view does not expose store instances, provider adapters, generated registries, or runtime setup state.

## Consequences

Sources can depend on previous materialized output without recursive Workspace runtime calls or consumer-specific workarounds.

This keeps Source ingestion at the Workspace Package boundary: apps should not import generated runtime registries or provider stores to help a Source read its own previous output.
