# Chat as Agent Capability

ViteHub chat behavior belongs to `@vitehub/agent` as a Chat Capability rather than as standalone `@vitehub/chat` and `@vitehub/messages` packages. The standalone packages will be removed instead of kept as compatibility wrappers so chat shares Agent capability validation, instructions, policy, devtools metadata, and package ownership language.

## Considered Options

- Keeping compatibility wrapper packages was rejected because it would preserve an obsolete package boundary and make chat look separate from Agent behavior.
- A standalone Chat History Capability was rejected for this stack because Chat History remains part of the Chat Capability until a later Agent Memory pass proves a separate boundary is needed.
- Making Agent Memory depend on chat was rejected because durable memory and chat history are separate Capability concerns.

## Consequences

Chat History stays conversation-scoped and inside the Chat Capability for the current stack. Agent Memory stacks directly on the Agent capability runtime, not on the Chat Capability.
