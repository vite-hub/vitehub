# Repository Host Context Is Invocation Data

ADR 0069 assigned changing review material to Capability Workspace Contributions. Repository Host Context instead records lazy issue and Change Request data in Agent Invocation Context, while Pull Request Context retains trusted event intake and normalized pull-request facts. Neither Capability implicitly generates Workspace Sources or presentation artifacts; callers explicitly choose model-facing rendering or Workspace materialization. This keeps provider data reusable without coupling it to one Workspace or presentation strategy.

## Considered Options

- Capability-owned Workspace Sources were rejected because they couple provider data access to Workspace materialization and a review-specific file shape.
- Eager plain invocation data was rejected because issue and Change Request material can be large and mutable.
- Expanding Repository Host Capability was rejected because its model-facing collaboration tools have a different authority boundary from trusted runtime context.

## Consequences

Pull Request Context no longer owns Workspace Sources. Repository Host Context remains data-only and lazy. Applications and Agent Drivers explicitly select which values become instructions, input, or Workspace files.
