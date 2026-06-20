# Runtime Package

Runtime Package names ownership boundaries for `@vite-hub/runtime`.

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
A structured runtime event used as ViteHub's local observability source across package boundaries.
_Avoid_: Log line, console message

**Trace Event Log**:
A local append-only record of Trace Events used as the persisted source for debugging and derived inspection views.
_Avoid_: Run store, step database, OpenTelemetry store, DevTools cache

**Trace Event Content Policy**:
The Runtime Package rule for whether Trace Events carry metadata only or selected inputs, outputs, and payloads.
_Avoid_: Debug dump, prompt logging, secret redaction mode

**OpenTelemetry Export Surface**:
An optional Runtime Package observability boundary that maps runtime trace information to OpenTelemetry-compatible exporters.
_Avoid_: Dashboard, Trace Event, log sink, source of truth

**Lease**:
A temporary claim on a runtime key used for coordination.
_Avoid_: Lock, cache entry

## Relationships

- The **Runtime Package** owns **Runtime Host Context**.
- A **Runtime Capability** is not an Agent Capability.
- A **Policy Decision** can require an **Approval Request**.
- A **Trace Event** can describe policy, approval, capability, error, lifecycle, or run activity.
- **Trace Events** are the canonical Runtime Package observability vocabulary; package-specific integrations may feed them, but should not replace them with provider-specific telemetry concepts.
- A **Trace Event Log** persists raw **Trace Events** as the source for derived run and step inspection views.
- A **Trace Event Log** records observability milestones, not every client-facing stream event.
- A **Trace Event Log** defaults to metadata-only **Trace Events**; selected content-bearing fields require an explicit local debugging opt-in.
- Content-bearing **Trace Events** are sensitive observability data even when they are only persisted locally.
- An **OpenTelemetry Export Surface** consumes **Trace Events** without replacing them or introducing a second event vocabulary.
- V1 **OpenTelemetry Export Surface** maps milestone **Trace Events** to spans before logs or metrics.
- A **Lease** coordinates runtime work without becoming a public storage primitive.

## Example Dialogue

> **Dev:** "Should Agent own tracing for Workflow and Sandbox too?"
> **Domain expert:** "No. Cross-package tracing belongs to the **Runtime Package** through **Trace Events**."

## Flagged Ambiguities

- Runtime capabilities were considered Agent Capabilities - resolved: **Runtime Capability** is a package-to-package handle, not a model-facing ability.
- OpenTelemetry was considered as the primary ViteHub tracing model - resolved: **Trace Events** are the local source of truth, and the **OpenTelemetry Export Surface** is a mapper for external observability tools.
- Run and step documents were considered as the persisted telemetry source - resolved: the **Trace Event Log** is the persisted source, and run or step views are derived inspection surfaces.
- Persisting prompts, outputs, and tool payloads by default was considered - resolved: **Trace Event Content Policy** defaults the **Trace Event Log** to metadata-only events unless local debugging explicitly opts into content.
- Mirroring every Agent Invocation Stream event into tracing was considered - resolved: the **Trace Event Log** records observability milestones, not every stream delta.
- Exporting OpenTelemetry logs and metrics in V1 was considered - resolved: the **OpenTelemetry Export Surface** starts with spans derived from milestone **Trace Events**.
- Leases were considered public locks - resolved: **Lease** is runtime coordination language, not a user-facing KV API.
