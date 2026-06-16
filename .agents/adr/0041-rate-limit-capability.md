# Rate Limit Capability

ViteHub will expose `rateLimit()` as an official Agent Capability imported from `@vite-hub/agent/capabilities`. The capability runs before the main Agent Invocation, resolves a trusted invocation identity, consumes a fixed-window budget, records the result as an Agent Invocation Context Value, and rejects with a structured 429 error when the budget is exhausted. It is scoped to Agent Invocations rather than Nuxt API routes, so it can compose through DevTools, webhook routes, app-owned routes, schedules, and future Agent Trigger Consumers.

The first version uses a fixed-window algorithm and ships an in-process `memoryRateLimitStore()` for local development, tests, and single-process hosts. Hosted runtimes require an explicit store choice; production-grade adapters should implement the explicit `RateLimitStore.check()` and `RateLimitStore.consume()` contract. `check()` reads the current budget without consuming it. `consume()` should perform the store's atomic budget operation and return the post-operation result. Store inputs include the capability id, scope, resolved identity, Agent Invoker, runtime context, limit, window, and generated key so persistent adapters can use structured state instead of reparsing ViteHub's key format.

Identity resolution must use trusted invocation context. `identity: "auto"` and `identity: "invoker"` consume `context.invoker` as `kind:id`, which is always present through either trusted request context, a configured Agent Invoker Profile, Chat Capability identity, or an origin-specific anonymous fallback. `identity: "ip"` reads request headers only when the developer names trusted IP headers for their deployment boundary. `identity: "run"` uses stable Agent Run metadata such as thread or channel ids, not the invocation-unique run id.

Rate limiting is not part of `access()`, because access controls authority over runtime surfaces while rate limiting controls invocation budget. It is also not a model-facing KV/DB/Blob tool, because the model should not participate in enforcement. Current KV `get`/`set` storage is not enough to claim strict distributed rate-limit behavior, so durable adapters should target a backend with atomic increment, compare-and-set, a Durable Object, or an equivalent coordination primitive.

## Considered Options

- Keeping downstream app middleware was rejected because Agent Invocations can start through multiple Agent Trigger Consumers, and the budget should compose through the Agent Definition.
- Folding rate limits into `access()` was rejected because access roles and budget consumption are separate Pre-Invocation Decisions.
- Building the first version on plain KV `get`/`set` was rejected because concurrent invocations can pass stale reads unless the store has an atomic consume operation.
- Exposing `hubKv` directly was rejected because it is framework/provider-specific language and would hide the actual rate-limit guarantee behind a KV handle. A future helper such as `rateLimitKvStore({ store })` can adapt ViteHub KV Store Selection when the coordination and accuracy semantics are explicit.
- Trusting generated app-route `user` or `run` request fields was rejected because those fields are client-controlled on public app routes.
- Reading forwarded IP headers by default was rejected because proxy trust is host-specific and clients can spoof those headers in common deployments.
- Shipping sliding windows or token buckets in the first version was deferred because fixed windows prove the capability shape while leaving room for later algorithms.
- Weighted `cost`, `amount`, token, or spend budgets were deferred. V1 consumes one budget unit per Agent Invocation; cost-based quotas should be designed against Agent Usage behavior or a separate usage-budget primitive once real requirements prove the shape.

## Consequences

Applications can attach `rateLimit()` beside other Capabilities and customize identity, dynamic limits, scope, message, callbacks, and store behavior. The recorded decision includes `used`, `remaining`, `limit`, and reset metadata so app UIs can show budget state without owning enforcement. The memory store remains available through explicit configuration but should not be treated as hosted production coordination. Future runtime/provider packages can add durable stores without changing `rateLimit()` from an Agent Capability into a Nuxt-specific or KV-specific API.
