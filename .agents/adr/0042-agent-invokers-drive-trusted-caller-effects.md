# Agent Invokers Drive Trusted Caller Effects

## Status

Superseded by ADR 0064. This ADR remains as historical context for the legacy Invoker API and current compatibility surface.

ViteHub will use Agent Invokers as the single trusted caller identity for Agent Invocations. Agent Definitions can declare static selectable profiles through `defineAgent({ invoker: { profiles } })`, the runtime exposes the resolved value as `context.invoker`, and every invocation receives an origin-specific fallback when no trusted identity is supplied.

Capabilities consume `context.invoker` for concrete effects. `access()` can map invoker metadata to Workspace Scope, `rateLimit()` consumes invoker identity by default, and prompt behavior can read the same invoker metadata through normal Agent or Capability callbacks. App-specific axes such as customer, audience, tenant, and support role belong in `invoker.meta`; they do not become required top-level Agent Invoker fields.

Chat Trigger Consumers can pass an explicit app-owned Agent Invoker through the chat trigger `invoker` field after authenticating the request or deriving identity from a trusted platform. Chat-only request payload belongs in the chat trigger `meta` field. The Chat Capability preserves that metadata under `context.chat.meta` and lifts it into the default chat invoker's `meta` only when the trigger derives the caller identity from trusted Chat Platform Actor Facts. Configured Agent Invoker Profiles remain explicit selected identities, but selected profiles inherit default invoker metadata with profile metadata taking precedence.

Agent Invoker resolution receives Agent Run metadata directly. Invoker mapping may read Agent Run Origin when it needs to normalize a default identity, but Access Capability resolvers should consume the resolved Agent Invoker and its metadata instead of branching on chat context or Agent Run Origin.

V1 trusts request-provided invoker context and profile ids; applications that need authentication or authorization must validate requests themselves until ViteHub has an auth package. Agent Invoker remains trusted invocation context, not model-facing identity by default.

**Considered Options**

- Keep reusable Invocation Profiles beside Agent Invokers: rejected because ViteHub should not maintain two near-identical trusted caller concepts.
- Put invoker selection under `invoker.devtools`: rejected because DevTools should consume the same configured profiles as any other host surface.
- Require schemas for invoker metadata in V1: deferred because V1 is not an auth system; `invoker.meta` is app-owned and may be validated by applications that need stronger trust boundaries.
- Add top-level customer or audience fields: rejected because those are application-owned caller axes that fit `invoker.meta`; reusable behavior can consume metadata without making Quiver-specific fields part of ViteHub identity.
- Let DevTools switch invokers mid-conversation: rejected because one conversation should keep one trusted caller identity; users can clear the conversation to choose another invoker.
- Treat Agent Run Origin as an Access boundary: rejected because origin is host/runtime metadata, while concrete authorization effects should flow through the resolved Agent Invoker.

## Consequences

DevTools can show an Agent Invoker selector only when configured profiles make that feature meaningful, select the first profile by default for new Chat Sessions, keep the fallback option available for default-caller testing, and require clearing the session before changing invoker. DevTools may expose a local editable `meta` payload to simulate host-derived metadata during development. That payload is not a trust boundary; production app routes must authenticate or derive metadata before ViteHub receives it, and configured Agent Invoker Profiles remain the stable named identities.
