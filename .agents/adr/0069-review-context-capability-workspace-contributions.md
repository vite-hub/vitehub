# Review Context Capability Workspace Contributions

Superseded note: ADR 0075 retracts Source Instructions as a driver-facing build surface. Capability Workspace Contributions remain current for adding invocation-scoped Sources and rules before Workspace runtime surfaces are prepared.

ViteHub will model pull-request and review automation as a **Pull Request Context Capability**, not as `prSummary()` and not as a larger `repositoryHost()` surface. The capability owns reusable intake: Agent Trigger behavior for trusted pull-request product events, typed Agent Invocation Context Values for trusted pull-request metadata, and invocation-scoped Workspace inputs for review material. A broader review-context helper name remains open.

The Workspace input primitive is a **Capability Workspace Contribution**. It is add-only, invocation-scoped, inspectable, and resolved after Agent Triggers and pre-invocation context exist but before driver-facing Workspace Tools, Source Instructions, and Workspace Sessions are built. It may contribute Sources such as `pullRequest`, `pullRequestFiles`, `pullRequestReviews`, and `pullRequestChecks`, and it may contribute explicit Workspace Rules for artifact paths such as `artifacts/review/**`. It does not mutate the Colocated Workspace Definition, grant new Capabilities, broaden an Access-selected Workspace Scope, or bypass Workspace Rules. Source key, rule, Mount, and path conflicts fail loudly.

Pull-request and review data should default to lazy Live Sources or Request-Only Sources. Small trusted facts such as repository id, pull-request number, head/base refs, actor, delivery id, and provider-native ids belong in typed Agent Invocation Context Values. Heavy or changing material such as body, comments, files, reviews, review comments, checks, and diffs belongs in Sources.

The output boundary remains structured JSON from the Agent. Markdown rendering, GitHub comments, pull-request reviews, check runs, and Workspace publication are consumer-owned sinks through Agent Finish Hooks, Channel Delivery Effects, or app code. The context capability may make those sinks easier to wire later, but it must not make publication its core responsibility.

## Considered Options

- `prSummary()` was rejected because it names one consumer workflow and invites markdown, publication, and Quiver Review policy into the reusable primitive.
- Expanding `repositoryHost()` was rejected because Repository Host Capability is model-facing collaboration-object access, while review context intake needs triggers, trusted invocation context, and Workspace Sources before the Agent Driver runs.
- Arbitrary hidden Workspace mutation from Capabilities was rejected because ADR 0009 and ADR 0033 keep Sources, rules, write policy, and Workspace Scope visible at their boundaries.
- Eagerly stuffing full pull-request context into invocation context was rejected because review material is large, mutable, and better represented as lazy Live Sources or Request-Only Sources.

## Consequences

The public helper name remains unresolved. Prefer obvious nouns such as Pull Request Context Capability or Review Context Capability; avoid `prSummary`.

The Agent Package exposes a small runtime extension point for Capability Workspace Contributions. Runtime inspection can show contributed Source keys and rules, while Source key, rule, Mount, and path conflicts fail before the Agent Driver receives Workspace surfaces.

Consumers keep structured result schemas and publication hooks local. A review agent can write `artifacts/review/result.json`, render markdown, or publish to GitHub, but those are sinks layered after the context capability.
