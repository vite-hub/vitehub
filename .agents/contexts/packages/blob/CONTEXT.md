# Blob Package

Blob Package names ownership boundaries for `@vitehub/blob`.

## Language

**Blob Package**:
The package that owns Blob Stores, Default Blob Store behavior, and Blob Store Selection.
_Avoid_: Workspace package, Capability package

**Blob Driver Boundary**:
The package boundary where provider-specific object storage drivers meet ViteHub Blob behavior.
_Avoid_: Store API, workspace store

**Blob Driver Module**:
A public module that exposes one provider-specific Blob Driver.
_Avoid_: Driver registry, bundled driver, adapter module

**Blob Provider SDK Adapter**:
An implementation dependency that a Blob Driver Module can wrap to talk to a provider.
_Avoid_: Blob Driver Module, Blob Store, ViteHub provider

## Relationships

- The **Blob Package** owns named Blob Store configuration and runtime selection.
- The **Blob Package** preserves Default Blob Store ergonomics.
- The **Blob Driver Boundary** hides provider-specific bucket, token, and binding details.
- Each **Blob Driver Module** owns the provider dependency needed by that driver.
- Generated Provider Outputs import selected provider modules instead of package-level provider switches.
- A **Blob Driver Module** can be a thin wrapper around a **Blob Provider SDK Adapter**.
- One **Blob Provider SDK Adapter** can support multiple **Blob Driver Modules**.
- Known providers should have provider-specific **Blob Driver Modules**, even when those modules are thin wrappers.
- Workspace can use Blob Stores as hosted Workspace backing stores.
- Worktree-oriented file behavior belongs to Workspace, not the Blob Package.

## Example Dialogue

> **Dev:** "Should the Blob Package decide how files appear in a worktree?"
> **Domain expert:** "No. The **Blob Package** owns storage. Workspace owns file-tree behavior."

## Flagged Ambiguities

- Blob Store access was described through Agent file access - resolved: the **Blob Package** owns storage; Workspace owns file-tree behavior.
- Driver dependency behavior was described as package-level bundling - resolved: **Blob Driver Modules** own provider dependency reachability.
- Reusing Files SDK was treated as conflicting with provider-specific modules - resolved: **Blob Driver Modules** may wrap a shared **Blob Provider SDK Adapter** while preserving provider-level reachability.
