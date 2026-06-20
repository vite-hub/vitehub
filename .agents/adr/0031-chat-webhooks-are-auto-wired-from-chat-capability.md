# Chat Webhooks Are Auto-Wired From Chat Capability

ViteHub automatically exposes platform chat webhook routes for discovered Agent Definitions that attach the Chat Capability. The application source of truth is the inline Chat Platform Public Configuration on the Agent Definition. Application authors should not add a local `teams.post.ts` route or call a public webhook registration helper.

This ADR predates Chat Platform Public Configuration. The long-term public shape should use `chat({ platforms, state, ... })`, while Chat Platform Adapters remain implementation objects behind each configured platform.

The Agent Package generates a Chat Webhook Route such as `/api/_vitehub/agents/:agent/webhooks/:webhook`. At request time, the Chat Webhook Handler resolves the discovered Agent, reads its Chat Capability options, resolves the Chat Platform Callback, invokes the matching ChatSDK platform adapter webhook, and dispatches the event through the resolved `chat.message` Agent Trigger.

## Considered Options

- A public webhook registration helper was rejected because it would create a second source of truth next to the Chat Capability and would make platform webhook wiring something users have to remember.
- App-owned platform route files such as `teams.post.ts` were rejected because they push framework glue into every host app and hide an upstream ViteHub responsibility.
- Build-time Chat Platform extraction was rejected because Chat Platform Callbacks can depend on Server Env, credentials, and request-local server state.
- Having ViteHub create every platform adapter without an explicit adapter factory was deferred because package imports, credential names, and platform-specific adapter options need a clearer convention first.

## Consequences

`createTeamsAdapter(...)` and equivalent platform adapter factories remain explicit behind Chat Platform configuration, but webhook registration is automatic. Adding a Chat Platform to the Chat Capability configuration is enough for the generated route to accept that platform when the underlying ChatSDK adapter exposes a webhook.

Chat webhooks are Agent Trigger Consumers, not new Capability declarations. The Chat Capability owns the `chat.message` trigger contribution, while the Agent Package owns generated route installation, runtime adapter resolution, Agent Invocation execution, streaming, and response delivery.
