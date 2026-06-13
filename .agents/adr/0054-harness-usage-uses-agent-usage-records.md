# Harness Usage Uses Agent Usage Records

Harness-backed Agent Drivers use **Agent Usage Records** as the shared accounting surface instead of introducing a parallel harness-specific telemetry concept. Token fields are populated only when the harness or underlying provider reports token usage, or when ViteHub can safely derive it. Non-token harness usage such as sessions, actions, wall time, quota events, and provider-specific accounting must be preserved as raw provider- or harness-reported usage details.

Cost is recorded only when the provider reports it or explicit pricing logic estimates it. ViteHub must not invent exact per-run cost for subscription-backed harness usage when the provider does not expose that accounting. When available, the resolved **Harness Credential Source** label or billing identity metadata should be attached to the usage record without exposing the underlying secret.

## Considered Options

- Creating a separate Harness Usage Record was rejected because applications need one accounting surface across model-backed, harness-backed, and custom-run-backed Agent Drivers.
- Requiring token counts for every Agent Usage Record was rejected because harnesses may report work in sessions, actions, wall time, quota events, or other provider-specific units.
- Dropping non-token harness usage was rejected because it would make the most important cost and quota signals invisible.
- Translating subscription-backed harness runs into invented token counts or exact per-run cost was rejected because that would imply precision ViteHub does not have.
- Keeping Usage Telemetry model-only was rejected because Agent Driver selection is now broader than model-backed execution, and cost visibility was a primary reason to introduce the harness boundary carefully.

## Consequences

The Agent Usage shape needs to support records without token counts when a harness reports meaningful non-token usage. Existing model-backed usage telemetry can keep token normalization as the common path, but harness-backed drivers need a widened normalization path that preserves raw provider details. Pricing callbacks and cost-based future quotas must treat missing cost as unknown rather than zero. Rate Limit Capability V1 still consumes one budget unit per Agent Invocation; usage-weighted budgets remain a future design built on Agent Usage Records.
