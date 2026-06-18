# Generated Agent Webhook Routes Dispatch Channel Triggers

ViteHub will treat generated webhook routes as Agent Package Agent Trigger Consumers for all webhook-backed Agent Triggers, not as chat-only routes. At request time the Agent Webhook Handler matches a registered webhook id or path, verifies configured secrets or signatures through the trigger runtime, then dispatches either chat adapter webhook behavior for message-shaped Channels or non-chat Channel trigger input with verified delivery facts.

## Considered Options

- Keeping generated webhook routes chat-only was rejected because GitHub and future Channel webhook users would still need app-owned endpoint files just to receive and verify deliveries.
- Forcing GitHub delivery through Chat Platform Adapter abstractions was rejected because GitHub is a Channel Kind, not a message-shaped chat adapter.
- Creating provider-specific generated route families was rejected for V1 because Channel webhook registrations already provide the provider, path, verification, and trigger identity needed by the Agent Package.

## Consequences

Apps can declare Channel-owned webhooks such as GitHub without adding app-level route files for HMAC verification and dispatch. App code still owns product-specific Channel Delivery Admission and behavior, such as command filtering, trusted actor checks, artifacts, reactions, replies, and result publication. Direct generated webhook paths without an agent route parameter are only unambiguous for single-Agent route handlers; multi-Agent apps should keep an agent parameter or otherwise use distinct generated route configuration.
