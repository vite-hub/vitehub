# Channels and Triggers

Use this for GitHub, Teams, Telegram, Discord, web chat, custom webhooks, message history, admission, concurrency, or delivery effects.

## Select one current page

Open [Channels](https://vitehub.dev/raw/docs/agents/channels.md) for conversation adapters, [Triggers](https://vitehub.dev/raw/docs/agents/triggers.md) for other inbound events, or [Chat history and sessions](https://vitehub.dev/raw/docs/agents/chat-history-sessions.md) for identity and persistence. Open another page only when the first explicitly crosses that boundary.

## Composition

A Channel adapts an external conversation surface; a Trigger admits an external event into an Agent Invocation. Keep webhook verification, actor/admission rules, history/session identity, concurrency, input commands, and delivery behavior explicit.

Use official Channel helpers when the installed contract provides them. Create a custom Trigger only when the external event is not a conversation adapter or the official boundary cannot represent the source.

Treat webhook secrets and installation tokens as server-only Env. Keep generated routes inspectable and document the exact local or deployed URL used for proof.

## Proof

Exercise the generated or custom webhook with a verified event, observe the Agent Invocation, and confirm the expected external delivery or persisted message. A route existing in Provider Output is not proof that admission and delivery work.
