# Channels

Use Channels for outbound message delivery through named connectors such as HTTP, chat, GitHub, Slack, or email. For inbound webhooks, chat admission, or Agent input, use the Agent Channels and Triggers guidance in [channels-triggers.md](../channels-triggers.md).

Read the [Channels guide](https://vitehub.dev/raw/docs/channels.md) and [Get started](https://vitehub.dev/raw/docs/channels/get-started.md). Use [Server API](https://vitehub.dev/raw/docs/channels/server-api.md) for delivery and [Agent Channels](https://vitehub.dev/raw/docs/agents/channels.md) for Agent input.

Keep connector credentials and delivery or reply policy in the Channel Definition. A Channel does not grant an Agent every application capability. Grant tools separately. For inbound webhook verification or chat admission, follow the Agent Channels and Triggers guidance instead.

Prove one outbound delivery and its result on the target channel.
