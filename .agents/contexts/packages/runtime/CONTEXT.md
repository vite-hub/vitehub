# Runtime Package

Runtime Package names ownership boundaries for `@vitehub/runtime`.

## Language

**Runtime Package**:
The package that owns shared runtime context, runtime capability handles, policy decisions, approvals, tracing, and leases.
_Avoid_: Agent package, provider adapter package

**Runtime Host Context**:
The host-provided runtime information shared across ViteHub packages.
_Avoid_: Agent context, request object

**Runtime Capability**:
A host resource exposed through the Runtime Package for package-to-package use.
_Avoid_: Agent Capability, model tool

**Policy Decision**:
The allow, deny, approval, or retry outcome for a runtime operation.
_Avoid_: Permission boolean, validation error

**Approval Request**:
A runtime request for human or external approval before an operation continues.
_Avoid_: Policy error, confirmation prompt

**Trace Event**:
A structured runtime event used for observability across package boundaries.
_Avoid_: Log line, console message

**Lease**:
A temporary claim on a runtime key used for coordination.
_Avoid_: Lock, cache entry

## Relationships

- The **Runtime Package** owns **Runtime Host Context**.
- A **Runtime Capability** is not an Agent Capability.
- A **Policy Decision** can require an **Approval Request**.
- A **Trace Event** can describe policy, approval, capability, error, lifecycle, or run activity.
- A **Lease** coordinates runtime work without becoming a public storage primitive.

## Example Dialogue

> **Dev:** "Should Agent own tracing for Workflow and Sandbox too?"
> **Domain expert:** "No. Cross-package tracing belongs to the **Runtime Package** through **Trace Events**."

## Flagged Ambiguities

- Runtime capabilities were considered Agent Capabilities - resolved: **Runtime Capability** is a package-to-package handle, not a model-facing ability.
- Leases were considered public locks - resolved: **Lease** is runtime coordination language, not a user-facing KV API.
