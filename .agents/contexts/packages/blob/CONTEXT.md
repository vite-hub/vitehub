# Blob Package

Blob Package names ownership boundaries for `@vitehub/blob`.

## Language

**Blob Package**:
The package that owns Blob Stores, Default Blob Store behavior, and Blob Store Selection.
_Avoid_: Workspace package, Capability package

**Blob Driver Boundary**:
The package boundary where provider-specific object storage drivers meet ViteHub Blob behavior.
_Avoid_: Store API, workspace store

## Relationships

- The **Blob Package** owns named Blob Store configuration and runtime selection.
- The **Blob Package** preserves Default Blob Store ergonomics.
- The **Blob Driver Boundary** hides provider-specific bucket, token, and binding details.
- Workspace can use Blob Stores as hosted Workspace backing stores.
- Worktree-oriented file behavior belongs to Workspace, not the Blob Package.

## Example Dialogue

> **Dev:** "Should the Blob Package decide how files appear in a worktree?"
> **Domain expert:** "No. The **Blob Package** owns storage. Workspace owns file-tree behavior."

## Flagged Ambiguities

- Blob Store access was described through Agent file access - resolved: the **Blob Package** owns storage; Workspace owns file-tree behavior.
