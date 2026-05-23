# Agent Invocation Lifecycle Hooks

ViteHub agents will expose Agent Invocation Lifecycle hooks on the Agent Definition, with `agent:finish` as the canonical final hook for observing a completed invocation. Capabilities may augment lifecycle events through Agent Invocation Extensions keyed by Capability ID, but V1 capabilities should not expose generic finish/export callbacks such as `usageTelemetry({ sync })`; exporting, logging, and syncing completed invocation data belongs in `agent:finish`.

## Considered Options

- Capability-local export callbacks were rejected for V1 because they create a second lifecycle observation surface, make ordering harder to explain, and risk every Capability growing its own mini hook API.
- Top-level event fields such as `event.usage` were rejected because they make optional Capability-owned data look like part of the core Agent Finish Hook contract.
- Dynamic extension properties such as `event.extensions.usageTelemetry` were rejected because they turn Capability IDs into property names and make user-defined Capabilities awkward.

## Consequences

The Agent Finish Hook event should keep a small stable envelope and expose optional Capability data through `event.extensions.get("<capability-id>")`, such as `event.extensions.get("usage-telemetry")`. Capability order can still determine how Capabilities augment invocation data, while Agent Definition hooks remain the single public place to observe Agent Invocation Lifecycle moments.
