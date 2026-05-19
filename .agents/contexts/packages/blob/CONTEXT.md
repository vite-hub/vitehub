# Blob Package

Blob Package names ownership boundaries for `@vitehub/blob`.

## Language

**Blob Package**:
The package that owns Blob Stores, Default Blob Store behavior, and Blob Store Selection.
_Avoid_: Workspace package, Agent capability package

**Blob Driver Boundary**:
The package boundary where provider-specific object storage drivers meet ViteHub Blob behavior.
_Avoid_: Store API, workspace store

## Relationships

- The **Blob Package** owns named Blob Store configuration and runtime selection.
- The **Blob Package** preserves Default Blob Store ergonomics.
- The **Blob Driver Boundary** hides provider-specific bucket, token, and binding details.
- Workspace can use Blob Stores as hosted Workspace backing stores.
- Blob-backed agent file access belongs behind Workspace, not a direct Blob Agent Capability.

## Example Dialogue

> **Dev:** "Should `@vitehub/agent` add a direct Blob tool when Workspace is Blob-backed?"
> **Domain expert:** "No. The **Blob Package** backs storage, and Workspace is the agent-facing boundary."

## Flagged Ambiguities

- Blob Store access was considered direct Agent access - resolved: Blob-backed agent file access goes through Workspace.
