# Chat as an Agent Capability

ViteHub will migrate Chat into the Agent capability system instead of keeping `@vitehub/chat`, `defineChat()`, discovered `server/chat.ts` files, `defineAgent({ chat })`, or `@vitehub/messages` as separate public surfaces. Chat will be an Official Capability attached through `defineAgent({ capabilities: [chat(...)] })`, discovered only through Agent definitions, and invoked through agent-scoped webhook routes such as `/api/agents/[agent]/chat/[platform]`.

## Considered Options

- Keeping Chat as a separate package was rejected because it preserves a second composition model after Chat becomes an Agent-Scoped Capability.
- Keeping `@vitehub/messages` was rejected because its useful primitives can live inside `@vitehub/agent` once Chat and Agent share one public package boundary.
- Keeping discovered `server/chat.ts` files was rejected because Chat ownership should be visible on the Agent definition that receives the invocation.
- Global chat webhook routes were rejected because they require a chat registry to choose an Agent; agent-scoped routes make the target Agent explicit.
- Splitting Chat persistence into a separate `chatState()` capability was rejected because users should not need to understand Chat SDK state to add Chat.
- Exposing `chat({ state })` was rejected for the initial migration because persistence should follow the Agent workspace rather than Chat SDK storage configuration.
- Capability devtools APIs were rejected for this migration because Chat Devtools require a Vite plugin, and Nitro modules cannot inject Vite plugins.

## Consequences

The Agent package owns all Chat runtime surfaces. `@vitehub/agent/capabilities` exports `chat`, `skills`, `voiceInput`, and `mcp`; `@vitehub/agent/vite` exports `hubAgent()` and a separate `hubChatDevtools()` plugin for development tooling. Users add Chat by configuring the Agent capability and add Chat Devtools separately when they want the Vite panel.

Chat uses Chat SDK internally for adapters, event handling, and state interfaces where useful, but Chat SDK state is hidden from the user. Chat is stateless unless the user enables Chat History; when history is enabled, ViteHub provides a Chat SDK-compatible state adapter backed by the Agent workspace. There is no public `chatState()` capability and no public `chat({ state })` option in the initial migration.

The Capability lifecycle will include `configure`, `prepare`, `bind`, `input`, `resolve`, `output`, and `close`. `configure` and `prepare` stay separate: `configure` contributes build/runtime wiring such as routes, generated files, aliases, and provider output, while `prepare` declares logical resources such as state, workspace paths, artifacts, permissions, and dependencies. `bind` attaches external invocations to Agent runs, and `output` renders run results back to the invocation target.

Capability phases keep the imperative typed context-mutation authoring model. Internally, ViteHub records those mutations as declarative contribution registries so it can validate conflicts, generate runtime files, expose metadata, and produce deterministic diagnostics. Hooks remain secondary extension points around phases, use colon-style names, and run sequentially in registration order.

This follows the useful parts of the UnJS, Nuxt/unplugin, and Better Auth ecosystems: typed mutable lifecycle contexts, explicit generated runtime artifacts, separated build/runtime/devtools concerns, factory-returned extension objects, and early conflict detection for routes, instruction blocks, tools, artifacts, and capability ids.
