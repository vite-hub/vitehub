# Agent Invokers Drive Trusted Caller Effects

ViteHub will use Agent Invokers as the single trusted caller identity for Agent Invocations. Agent Definitions can declare static selectable profiles through `defineAgent({ invoker: { profiles } })`, the runtime exposes the resolved value as `context.invoker`, and every invocation receives an origin-specific fallback when no trusted identity is supplied.

Capabilities consume `context.invoker` for concrete effects. `access()` can map invoker metadata to Workspace Scope, `rateLimit()` consumes invoker identity by default, and prompt behavior can read the same invoker metadata through normal Agent or Capability callbacks. App-specific axes such as customer, audience, tenant, and support role belong in `invoker.meta`; they do not become required top-level Agent Invoker fields.

V1 trusts request-provided invoker context and profile ids; applications that need authentication or authorization must validate requests themselves until ViteHub has an auth package. Agent Invoker remains trusted invocation context, not model-facing identity by default.

**Considered Options**

- Keep reusable Invocation Profiles beside Agent Invokers: rejected because ViteHub should not maintain two near-identical trusted caller concepts.
- Put invoker selection under `invoker.devtools`: rejected because DevTools should consume the same configured profiles as any other host surface.
- Require schemas for invoker metadata in V1: deferred because V1 is not an auth system; `invoker.meta` is app-owned and may be validated by applications that need stronger trust boundaries.
- Add top-level customer or audience fields: rejected because those are application-owned caller axes that fit `invoker.meta`; reusable behavior can consume metadata without making Quiver-specific fields part of ViteHub identity.
- Let DevTools switch invokers mid-conversation: rejected because one conversation should keep one trusted caller identity; users can clear the conversation to choose another invoker.

## Consequences

DevTools can show an Agent Invoker selector only when configured profiles make that feature meaningful, select the first profile by default for new Chat Sessions, keep the fallback option available for default-caller testing, and require clearing the session before changing invoker. Quiver-style impersonation uses configured Agent Invoker Metadata such as customer or audience rather than arbitrary DevTools metadata editing.
