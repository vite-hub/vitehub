# Authenticated Agent Helper Uses Standard Auth Surfaces

ViteHub should expose a friendly Auth Package helper such as `authenticated()` for Agents that want their Agent Invoker derived from Auth, but it should not add Agent-specific consumer configuration to `defineAuth()`. Cross-service Agent calls should rely on standard Better Auth surfaces such as same-app sessions, cross-subdomain sessions, JWTs, bearer tokens, or OAuth/OIDC provider output, then let the Auth Package's Agent helper verify that credential and map it into an Agent Invoker.

## Considered Options

- Naming the public helper `authAgentInvoker()` was rejected because most users should not need to learn the Agent Invoker glossary term for the default authenticated Agent path.
- Adding an `agentConsumers` field to the Auth Definition was rejected because it would make Auth configuration speak Agent-specific deployment language and duplicate Better Auth's existing client, session, JWT, bearer, and OAuth/OIDC surfaces.
- Requiring every Agent to write a custom Auth-to-Agent mapper was rejected because the normal case should derive a useful Agent Invoker from the Auth User by default.

## Consequences

`authenticated()` should be opt-in at the Agent or Entry Surface boundary; merely defining Auth does not make every Agent Invocation require Auth. The default same-app path can be as small as `invoker: authenticated()`. More advanced deployments, such as a Portal app calling a separate Chat app directly, should configure Better Auth using its standard portable credential mechanisms and configure `authenticated()` with the corresponding source, rather than proxying every Agent request or adding ViteHub-specific Auth Definition fields.
