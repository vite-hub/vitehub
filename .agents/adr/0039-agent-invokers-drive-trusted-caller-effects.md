# Agent Invokers Drive Trusted Caller Effects

ViteHub will promote **Agent Invoker** to the root Agent Definition concept for trusted caller identity, exposed through `defineAgent({ invoker: { profiles } })` and `context.invoker`. Access, rate limits, audit, memory scope, DevTools selectors, and app-owned prompt behavior should consume this one invocation identity instead of each defining a separate profile, persona, user, or invoker surface.

Agent Invoker Profiles are static server-declared selectable Agent Invokers in the first version. App-specific axes such as customer, audience, tenant, and support role belong in Agent Invoker Metadata; they do not become required top-level Agent Invoker fields. ViteHub always provides a fallback Agent Invoker so callbacks can depend on `context.invoker.id`, but applications may reject fallback invokers when their own policy requires stronger identity.

## Considered Options

- A DevTools-specific profile selector was rejected because DevTools should render Agent Definition behavior, not own a second identity configuration language.
- Separate invocation profile, user identity, and persona concepts were rejected because they would make Access, Rate Limit, prompt posture, and future auth integrate through near-duplicate surfaces.
- Requiring Agent Invoker schemas in the first version was deferred because ViteHub is not providing auth yet; applications that need authentication or authorization validate request identity themselves until a ViteHub auth primitive exists.
- Dynamic Agent Invoker Profile lists were deferred because static profile objects are enough for current development and reference-app needs; organization directories or auth integrations can justify a dynamic boundary later.
- Changing Agent Invoker in the middle of a Chat Session was rejected because Chat History, access scope, and rate-limit decisions would no longer share one stable conversation identity.

## Consequences

DevTools can show an Agent Invoker selector only when declared profiles make that feature meaningful, select the first profile by default for new Chat Sessions, keep the fallback option available for default-caller testing, and require clearing the session before changing invoker. Quiver-style impersonation uses configured Agent Invoker Metadata such as customer or audience rather than arbitrary DevTools metadata editing. Agent Invoker remains trusted invocation context, not model-facing identity by default.
