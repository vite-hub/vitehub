---
title: Build an AI Discord bot with ViteHub
description: Build an AI Discord bot with a ViteHub Agent. Create the app in the Discord Developer Portal, add discord() to defineAgent, and run it on a Node server that keeps the Gateway connection open.
navigation.title: Discord AI bot
navigation.order: 5
navigation.group: Chat bots
icon: i-simple-icons-discord
---

To build an AI Discord bot with ViteHub, create an application in the Discord Developer Portal, turn on the Message Content intent, and add `discord({ adapter: true })` from `vite-hub/agent/channels` to a `defineAgent()` file. Set `DISCORD_BOT_TOKEN`, `DISCORD_PUBLIC_KEY`, and `DISCORD_APPLICATION_ID`, then run the app with the `node` preset. The Node server opens the Discord Gateway connection when it starts, and the Agent answers direct messages and messages that mention the bot.

## What a ViteHub Discord bot is

A [Discord bot](https://discord.com/developers/docs/intro) is the bot user of a Discord application. Discord does not send ordinary chat messages to a webhook. A bot receives them through the [Gateway](https://discord.com/developers/docs/events/gateway), a WebSocket connection that stays open. The HTTP interactions endpoint receives only slash commands, buttons, and other interactions.

In ViteHub, the bot is a [Channel](/docs/agents/channels) of an Agent. `discord()` builds a [Chat SDK](https://chat-sdk.dev) Discord adapter. On the `node` preset, ViteHub adds a Nitro plugin that opens the Gateway connection when the server starts, opens a new connection every 9 minutes, and closes it when the server stops. Each message that ViteHub accepts starts one Agent Invocation. The Agent writes the answer. In a server channel, ViteHub posts the answer in a thread under the message.

## Create the Discord application

1. Open the [Discord Developer Portal](https://discord.com/developers/applications) and select **New Application**.
2. On **General Information**, copy the **Application ID** (`DISCORD_APPLICATION_ID`) and the **Public Key** (`DISCORD_PUBLIC_KEY`).
3. On **Bot**, select **Reset Token** and copy the token (`DISCORD_BOT_TOKEN`). Anyone with the token controls the bot, so keep it secret.
4. On **Bot**, under **Privileged Gateway Intents**, turn on **Message Content Intent**. The Chat SDK adapter asks for this intent, and Discord closes the Gateway connection when the intent is off. A bot in 100 or more servers needs Discord's approval for this intent. Read [Message Content intent](https://discord.com/developers/docs/events/gateway#message-content-intent).
5. On **OAuth2**, open **OAuth2 URL Generator**, select the `bot` scope, and select these bot permissions: **View Channels**, **Send Messages**, **Create Public Threads**, **Send Messages in Threads**, and **Read Message History**. Open the generated URL to add the bot to your server.

The Chat SDK adapter asks the Gateway for the Guilds, Guild Messages, Message Content, Direct Messages, and reaction intents. Only Message Content is privileged, so it is the only intent that you turn on in the portal.

## Set up the app

Start with the Vite app from [Installation](/docs/getting-started/installation). Install the Discord adapter. ViteHub does not install it for you.

```bash [Terminal]
pnpm add @chat-adapter/discord
```

Use the version that matches the `chat` package that ViteHub installs. `pnpm why chat` shows it.

### Enable Agents on the Node preset

```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [
    vitehub({
      preset: 'node',
      agent: true,
      workflow: false,
    }),
  ],
})
```

The `node` preset is what starts the Gateway listener in the server process. `workflow: false` keeps each reply inline in that process.

### Define the Agent

```ts [server/agents/assistant.ts]
import { defineAgent } from 'vite-hub/agent'
import { discord } from 'vite-hub/agent/channels'

const allowedUsers = new Set(['111111111111111111'])

export default defineAgent({
  channels: {
    discord: discord({
      adapter: true,
      messages: {
        filter: ({ message }) => allowedUsers.has(message.author.userId),
      },
    }),
  },
  driver: {
    model: 'openai/gpt-5.1-mini',
    instructions: 'You are a helpful assistant in Discord. Keep answers short.',
  },
})
```

- `adapter: true` tells ViteHub to build the adapter from Server Env. Without an `adapter` option, `discord()` has no adapter, and ViteHub does not start a Gateway listener for it.
- `messages.filter` is optional. Here it admits only the Discord user IDs in the set. Return `false` and the Agent does not start and posts nothing. To copy a user ID, turn on **Developer Mode** in Discord's advanced settings, then right-click the user.
- To answer a role mention, pass `adapter: { mentionRoleIds: ['<role id>'] }` instead of `adapter: true`. Adapter options that you omit still come from Server Env.

The model string runs through AI Gateway, so the server needs `AI_GATEWAY_API_KEY`. Read [Agent Drivers](/docs/agents/agent-drivers#use-a-model-backed-driver) to use another model.

### Set the server environment

`discord({ adapter: true })` reads its credentials from Server Env. For each value, ViteHub reads the `VITEHUB_` name first and then the Discord name. The Chat SDK adapter requires all three.

| Value | Variable |
| --- | --- |
| Bot token | `VITEHUB_DISCORD_BOT_TOKEN` or `DISCORD_BOT_TOKEN` |
| Public key | `VITEHUB_DISCORD_PUBLIC_KEY` or `DISCORD_PUBLIC_KEY` |
| Application ID | `VITEHUB_DISCORD_APPLICATION_ID` or `DISCORD_APPLICATION_ID` |

```bash [.env]
DISCORD_BOT_TOKEN=your-bot-token
DISCORD_PUBLIC_KEY=your-public-key
DISCORD_APPLICATION_ID=your-application-id
AI_GATEWAY_API_KEY=your-ai-gateway-key
```

Do not commit `.env`. See [Channel Env](/docs/agents/channels#channel-env).

## Test the bot locally

```bash [Terminal]
pnpm dev
```

The Gateway connection goes out from your machine to Discord, so you do not need a public URL or a tunnel for messages. Send the bot a direct message, or mention it in a server channel, for example `@Assistant what is ViteHub?`. The bot creates a thread under your message and answers there.

Check what ViteHub discovered:

```bash [Terminal]
pnpm vitehub agent info --agent assistant --url http://localhost:3000
```

If the bot does not answer, look for `[vitehub:agent] Discord Gateway listener failed and will retry.` in the server log. ViteHub retries 5 seconds after a failure. Gateway listener start, stop, and failure events also appear in the JSON logs under the `vitehub.channel.listener` scope. Read [Inspect delivery custody](/docs/agents/channels#inspect-delivery-custody).

## Deploy the bot

Deploy the `node` preset to a server or container that runs all the time. Read [Node and self-hosted](/docs/frameworks-hosts/node-self-hosted) for the build output.

```bash [Terminal]
pnpm build
VITEHUB_AGENT_STATE_URL=file:/var/lib/assistant/agent-state.sqlite \
DISCORD_BOT_TOKEN=... \
DISCORD_PUBLIC_KEY=... \
DISCORD_APPLICATION_ID=... \
AI_GATEWAY_API_KEY=... \
node .output/server/index.mjs
```

A production build needs durable Agent State for thread subscriptions and queued deliveries. `VITEHUB_AGENT_STATE_URL` gives it a SQLite file on a disk that survives a restart. Read [History and sessions](/docs/agents/chat-history-sessions).

Run one server process for the bot. Each process opens its own Gateway connection.

## Serverless hosts

A serverless function cannot keep the Gateway connection open, so ViteHub starts the listener only on the `node` preset. You can generate a wake route instead:

```ts [vite.config.ts]
vitehub({
  preset: 'vercel',
  agent: { routes: { discordGateway: true } },
})
```

This adds `GET /api/_vitehub/agents/<agent>/discord/gateway`. In production the route requires `VITEHUB_DISCORD_GATEWAY_SECRET` and an `Authorization: Bearer <secret>` header. Each call opens the Gateway for 9 minutes, or for `VITEHUB_DISCORD_GATEWAY_DURATION_MS`, and forwards each event to the Agent webhook route at `/api/_vitehub/agents/<agent>/webhooks/discord`.

ViteHub does not call this route for you. You must call it on a timer that overlaps the listener time, and the host must let the function run for that time. Many serverless plans stop a function sooner. ViteHub has no deployed test of this path. Use the `node` preset when you need a Discord bot that is always online. On the `node` preset, `routes.discordGateway` adds no route, because the server process owns the listener.

## Limits

- **Mentions.** In a direct message, the bot answers every message. In a server channel, it answers only messages that mention it, and it answers in a new thread. To also answer replies in that thread without a mention, set `messages: { replyToSubscribedThreads: true }`. Read [Answer replies in subscribed threads](/docs/agents/channels#answer-replies-in-subscribed-threads).
- **Other bots.** ViteHub ignores messages from other bots. Set `messages: { allowBots: true }` to change this.
- **Allowed users.** `messages.filter` is a filter, not sign-in. A Discord user ID is not a trusted identity for your app. When the Agent reads private data, resolve a trusted [Actor](/docs/agents/actors) first.
- **Slash commands.** The Agent answers chat messages. ViteHub does not register slash commands for you.
- **Host.** The always-online path needs a long-running Node.js process. Check the [support matrix](/docs/frameworks-hosts/support-matrix) before you choose another host.
- **Proof.** ViteHub has contract tests for the Discord Channel, the Gateway route, and the Node listener plugin. It does not run a deployed Discord bot in CI.

## Next steps

- [Agent Channels](/docs/agents/channels): admission, delivery, attachments, and Channel instructions.
- [Agent Actors](/docs/agents/actors): pass a trusted identity to the Agent.
- [Learn to build with Agents](/docs/agents/get-started): add tools and Workspaces to the same Agent.
- [Build an AI Slack bot](/docs/guides/slack-ai-bot) and [Build an AI Telegram bot](/docs/guides/telegram-ai-bot) with the same Agent file.
