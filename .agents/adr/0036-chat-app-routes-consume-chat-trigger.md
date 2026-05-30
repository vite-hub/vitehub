# Chat App Routes Consume Chat Trigger

ViteHub will expose application chat UIs through Chat App Routes, which are Agent Package-owned HTTP Agent Trigger Consumers enabled by Chat App Exposure on the existing Chat Capability. A Chat App Route consumes the existing `chat.message` Agent Trigger and speaks the AI SDK UI message transport so Nuxt UI and similar clients can use the route with minimal setup; it is not a ChatSDK platform adapter and not a new Agent Trigger.

Chat App Routes require explicit Agent identity and live under the ViteHub-owned API namespace, such as `/api/_vitehub/agents/:agent/chat`. ViteHub does not generate an anonymous `/api/chat` route because the Agent File Name should remain visible at the HTTP boundary.

## Considered Options

- A Nuxt UI ChatSDK adapter was rejected because application UIs do not receive external platform webhook events, threads, subscriptions, or reactions; they need an HTTP UI message transport into ViteHub-owned Agent Trigger execution.
- A new app-specific chat trigger was rejected because the semantic event is still a user chat message, already modeled as `chat.message`.
- Default-on app routes for every chat-capable Agent were rejected for now because public application endpoints can spend model tokens and need deliberate exposure, auth, identity, rate-limit, and persistence boundaries.

## Consequences

The Chat Capability remains the single source of truth for chat behavior: DevTools, Chat Webhook Routes, and Chat App Routes all consume `chat.message`. Chat App Routes should be automatic after Chat App Exposure is enabled, while route path details and host policy hooks can evolve as implementation details unless they become part of the public contract.
