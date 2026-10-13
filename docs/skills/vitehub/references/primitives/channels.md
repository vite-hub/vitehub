# Channels

Use Channels for outbound message delivery through named connectors such as HTTP, chat, GitHub, Slack, or email. For inbound webhooks, chat admission, or Agent input, use the Agent Channels and Triggers guidance in [channels-triggers.md](../channels-triggers.md).

Read the [Channels guide](https://vitehub.dev/docs/channels) and [Get started](https://vitehub.dev/docs/channels/get-started). Use [Server API](https://vitehub.dev/docs/channels/server-api) for delivery and [Agent Channels](https://vitehub.dev/docs/agents/channels) for Agent input.

Keep connector credentials and delivery or reply policy in the Channel Definition. A Channel does not grant an Agent every application capability. Grant tools separately. For inbound webhook verification or chat admission, follow the Agent Channels and Triggers guidance instead.

Prove one outbound delivery and its result on the target channel.
