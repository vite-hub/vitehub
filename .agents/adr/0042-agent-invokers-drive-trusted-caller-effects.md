# Agent Invokers Drive Trusted Caller Effects

ViteHub will use Agent Invokers as the single trusted caller identity for Agent Invocations. Agent Definitions can declare static selectable profiles through `defineAgent({ invoker: { profiles } })`, the runtime exposes the resolved value as `context.invoker`, and every invocation receives an origin-specific fallback when no trusted identity is supplied.

Capabilities consume `context.invoker` for concrete effects. `access()` can map invoker metadata to Workspace Scope, `rateLimit()` consumes `context.invoker.id` by default, and prompt behavior can read the same invoker metadata through normal Agent or Capability callbacks. V1 trusts request-provided invoker context and profile ids; applications that need authentication must validate requests themselves until ViteHub has an auth package.

**Considered Options**

- Keep reusable Invocation Profiles beside Agent Invokers: rejected because ViteHub should not maintain two near-identical trusted caller concepts.
- Put invoker selection under `invoker.devtools`: rejected because DevTools should consume the same configured profiles as any other host surface.
- Require schemas for invoker metadata in V1: deferred because V1 is not an auth system; `invoker.meta` is app-owned and may be validated by applications that need stronger trust boundaries.
- Let DevTools switch invokers mid-conversation: rejected because one conversation should keep one trusted caller identity; users can clear the conversation to choose another invoker.
