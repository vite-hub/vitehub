# Pre-Invocation Decisions for LLM Routes and Gates

ViteHub will keep Capabilities as the product abstraction and add a minimal internal pre-invocation decision primitive that Capabilities can use before the main Agent Invocation proceeds. The first public Capabilities over this primitive are `llmRoute()` and `llmGate()`. A generic `decisionPolicy()` helper, callback-routing helper, and request-refinement Capability are deferred until concrete product pressure proves their shape.

## Considered Options

- A second lifecycle or generic middleware system was rejected because the existing Capability Lifecycle is already the right extension model. ViteHub needs a small decision/effect primitive, not a framework inside the Agent Package.
- Dynamic Capability activation was rejected because Capabilities are static, ordered, validated early, visible to DevTools, and may declare requirements, cleanup, state, instructions, tools, and triggers. Per-invocation decisions may conditionally affect contributions, but they must not grant new Capabilities at runtime.
- A single broad `decisionPolicy()` public Capability was rejected for V1 because it is too abstract before LLM routes, LLM gates, and Chat Sessions prove the shared primitive.
- A callback-routing public Capability was rejected for V1 because deterministic context decisions are just user code. Users can define inline Capabilities or hooks that set named context values when they need role-based, tenant-based, or other deterministic routing.
- A public `refineInput()` Capability was rejected for V1 because request rewriting is not required by the current validated use cases.
- Exposing raw AI SDK structured-output calls as the normal user API was rejected because ViteHub should provide LLM route and gate helpers with standard schemas for common decisions.
- Generic names such as `routing()` and `gate()` were rejected for the first public helpers because they hide that these Capabilities use an LLM under the hood and would collide with future deterministic, auth, or security gate concepts.
- Storing decisions only in ad hoc `input.context` keys was rejected because routing, gates, and sessions need typed, inspectable decision records that other callbacks can read consistently.
- Merging or prioritizing multiple decisions that write the same context key was rejected because it creates hidden conflict rules. Decision ids are unique per Agent, and duplicates fail early.

## Consequences

The decision primitive runs before the main Agent Invocation and can produce a small set of effects: continue, reject, record a decision, select a Chat Session, and expose a typed context value. Future effects such as input refinement or route-specific tool narrowing may be added when a public use case proves them.

Decision records are available to later Agent and Capability callbacks through invocation context, using an accessor shape such as `context.get("<capability-id>")`. For example, `llmRoute({ id: "active-instructions", choices: { technical: "...", support: "..." } })` stores a typed route decision, and an Agent `instructions` callback can read that decision from context before selecting which Workspace file to load.

`llmRoute()` chooses one developer-defined option from a small choice map by asking an LLM to classify the current request and available invocation context. Choice keys are developer-owned and should infer the stored decision type. The common route schema is standard and generated internally, such as `{ choice, confidence?, reason? }`. The route Capability decides only the choice; it does not apply route effects directly. Instructions, tools, or other statically attached Capabilities may react to the stored route decision by reading invocation context.

`llmGate()` classifies the request against developer-defined allow and reject maps by asking an LLM to make the gate decision. The common gate schema is standard and generated internally, with a discriminated result such as allowed true with an allow category, or allowed false with a reject category. `llmGate()` may reject before the main Agent Invocation and should still record an inspectable gate decision.

LLM decision Capabilities may use the Agent model by default and may optionally override the model for cheaper or faster classifiers. The public API should not require users to import AI SDK helpers or define schemas for the common route and gate cases.

Deterministic routing remains possible without an official callback-routing Capability. Users can define an inline Capability or hook that reads trusted host context such as authenticated user identity and sets a named invocation context value. These user-defined context values follow the same uniqueness rule as LLM decision ids, so downstream callbacks can compose multiple named decisions explicitly.

Internal decision execution may use hookable-style lifecycle hooks, but hook names and implementation details are not the public abstraction. Public users attach Capabilities; Capability authors use the existing lifecycle plus the decision primitive.

Chat Sessions from ADR 0029 use the same primitive for semantic session selection, but Chat Sessions remain owned by the Chat Capability rather than by `llmRoute()` or `llmGate()`.
