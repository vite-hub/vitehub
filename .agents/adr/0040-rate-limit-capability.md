# Rate Limit Capability Uses Invoker Budgets And Store Contract

ViteHub will expose `rateLimit()` as an official Agent Capability that consumes a trusted invocation budget before model execution. It is scoped to Agent Invocations rather than Nuxt API routes, defaults its identity to `context.invoker`, records an Agent Invocation Context Value, and can run through any Agent Trigger consumer: DevTools, Chat App Routes, webhook routes, app routes, schedules, or future triggers.

The first version uses an explicit Rate Limit Store contract instead of exposing `hubKv`, raw KV, or model-facing storage Capabilities. The store owns persistence and coordination semantics for `check()` and `consume()`, with `consume()` as the atomic budget boundary. Memory storage is acceptable for local development and tests, while hosted runtimes need an explicit durable store choice.

## Considered Options

- App-level or Nuxt-route middleware was rejected because it only protects one HTTP surface and cannot compose with Agent Definition behavior, non-chat triggers, DevTools, schedules, or future invocation paths.
- Folding rate limits into `access()` was rejected because access decides whether an invocation may use a surface or scope, while rate limiting consumes a budget and records budget state.
- Plain KV `get`/`set` counters were rejected because distributed rate limiting needs a consume contract with clear atomicity and coordination semantics.
- Exposing `hubKv` directly was rejected because it is framework/provider-specific language and would hide the actual rate-limit guarantee behind a KV handle. A future helper such as `rateLimitKvStore({ store })` can adapt ViteHub KV Store Selection when the coordination and accuracy semantics are explicit.
- Trusting chat-specific user fields or forwarded IP headers by default was rejected. The default budget identity is the resolved Agent Invoker; IP-based limits require explicitly trusted request headers.
- Weighted `cost`, `amount`, token, or spend budgets were deferred. V1 consumes one budget unit per Agent Invocation; cost-based quotas should be designed against Agent Usage behavior or a separate usage-budget primitive once real requirements prove the shape.

## Consequences

Developers can build persistent, stateful rate limits by implementing the Rate Limit Store contract rather than by receiving ViteHub internals. The Capability API can still offer dynamic identity, scope, limit, window, message, and inspection callbacks without coupling to one provider. First-party provider-backed stores can be added later without changing `rateLimit()` from an Agent Capability into a Nuxt-specific or KV-specific API.
