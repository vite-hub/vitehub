# Chat Platforms Seed Agent Invokers

ViteHub will use Chat Platform language for the public Chat Capability configuration and keep Chat Platform Adapters as implementation objects behind each configured platform. Public chat caller identity surfaces such as `chat({ identity })`, `AgentChatIdentityResolver`, and `chat.identity` should be removed; Chat Platforms may verify and parse platform events into Chat Platform Actor Facts, but `defineAgent({ invoker })` remains the public trusted caller identity policy boundary.

## Considered Options

- Keeping `chat({ adapters })` was rejected for the long-term public API because it makes the implementation object look like the caller policy boundary.
- Renaming to `webhooks` was rejected because chat ingress may use webhooks, gateway connections, polling, or appservice-style delivery.
- Keeping public `chat({ identity })` was rejected because it creates a second trusted caller identity path beside Agent Invokers.

## Consequences

The Chat Capability owns Chat Platform ingress, Chat History, and Chat Webhook Autowiring. The Agent Package may derive a default Agent Invoker from trusted Chat Platform Actor Facts, but Access, Rate Limit, prompt behavior, lifecycle hooks, and app code consume `context.invoker`. Chat admission should consume the resolved Agent Invoker plus chat/request facts rather than a separate chat identity shape.
