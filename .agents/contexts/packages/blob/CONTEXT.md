# Blob Package

Blob Package names ownership boundaries for `@vitehub/blob`.

## Language

**Blob Package**:
The package that owns Blob Stores, Default Blob Store behavior, and Blob Store Selection.
_Avoid_: Workspace package, Agent capability package

## Relationships

- The **Blob Package** owns named Blob Store configuration and runtime selection.
- The **Blob Package** preserves Default Blob Store ergonomics.
- Workspace can use Blob Stores as hosted Workspace backing stores.
- Blob-backed agent file access belongs behind Workspace, not a Blob Agent Capability.

## Example Dialogue

> **Dev:** "Should `@vitehub/agent` add a `blob()` capability?"
> **Domain expert:** "Not for Workspace files. The **Blob Package** backs storage, and Workspace is the agent-facing boundary."

## Flagged Ambiguities

- Blob Store access was considered as a direct Agent Capability - resolved: Blob-backed agent file access goes through Workspace.
