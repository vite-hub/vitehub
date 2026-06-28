# Source-Scoped Access Derives Source Grants

Superseded note: ADR 0075 retracts free-form Workspace Scope Instructions from `access()` configuration. Source-scoped grants remain current; model-facing scope guidance now belongs in Agent Driver Instructions with Capability Instruction Coverage for Access.

ViteHub will let Workspace Source Bindings declare static Workspace Source Scope Membership with `scopes`, and the Access Capability will derive additive Workspace Scope Grants from that metadata. Workspace Scope selection, Access Roles, All-Scopes Workspace Scope, explicit path grants, and Workspace Scope Instructions stay in `access({ workspace })`; allowing `defineCapability()` to mutate `defineChannel()` was rejected for this slice because Channels declare reachability, while source visibility is Workspace and Access behavior.

## Considered Options

- Keeping every Source key only in `access.workspace.scopes[scope].sources` was rejected because it duplicates Source Map keys across normal static audience configurations.
- A new Access builder or policy DSL was rejected because static Source membership needs only one Workspace Source Binding field.
- Capability-to-Channel mutation was deferred because this change does not need Channel reachability changes, and cross-owner mutation would cut across the accepted Channels boundary.
