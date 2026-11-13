---
title: Build an AI Discord bot with ViteHub
description: "Build an AI Discord bot with a ViteHub Agent. Create the Discord app, add discord() to defineAgent, and run it on a Node server that keeps the Gateway open."
navigation.title: Discord AI bot
navigation.order: 5
navigation.group: Chat bots
icon: i-lucide-bot
---

Create a Discord application, turn on the Message Content intent, and add `discord({ adapter: true })` from `vite-hub/agent/channels` to a `defineAgent()` file. Set `DISCORD_BOT_TOKEN`, `DISCORD_PUBLIC_KEY`, and `DISCORD_APPLICATION_ID`, and run with the `node` host. The server opens the Discord Gateway at start, and the Agent answers direct messages and mentions.

## What a ViteHub Discord bot is

A [Discord bot](https://discord.com/developers/docs/intro) is the bot user of a Discord application. Discord does not send chat messages to a webhook. A bot gets them through the [Gateway](https://discord.com/developers/docs/events/gateway), a WebSocket that stays open. The HTTP interactions endpoint gets only slash commands, buttons, and other interactions.

In ViteHub, the bot is a [Channel](/docs/agents/channels) of an Agent: a way for messages to reach it. `discord()` builds a [Chat SDK](https://chat-sdk.dev) Discord adapter. On the `node` host, a Nitro plugin opens the Gateway at server start, reopens it every 9 minutes, and closes it at stop. Each accepted message starts one Agent run (Invocation). In a server channel, the answer goes in a thread.

## Create the Discord application

1. Open the [Discord Developer Portal](https://discord.com/developers/applications) and select **New Application**.
2. On **General Information**, copy the **Application ID** (`DISCORD_APPLICATION_ID`) and the **Public Key** (`DISCORD_PUBLIC_KEY`).
3. On **Bot**, select **Reset Token** and copy the token (`DISCORD_BOT_TOKEN`). Anyone with the token controls the bot, so keep it secret.
4. On **Bot**, under **Privileged Gateway Intents**, turn on **Message Content Intent**. The adapter asks for it, and Discord closes the Gateway connection if it is off. An app that more than 10,000 unique users can see across its servers needs Discord's review to keep privileged intents. See [Privileged Intent Access Review](https://docs.discord.com/developers/events/gateway#privileged-intent-access-review).
5. On **OAuth2**, open **OAuth2 URL Generator**, select the `bot` scope and these permissions: **View Channels**, **Send Messages**, **Create Public Threads**, **Send Messages in Threads**, and **Read Message History**. Open the generated URL to add the bot to your server.

The adapter asks for the Guilds, Guild Messages, Message Content, Direct Messages, and reaction intents. Only Message Content is privileged, so you turn on only that one.

## Set up the app

Start with the app from [Installation](/docs/getting-started/installation) and install the Discord adapter yourself:

```bash [Terminal]
pnpm add @chat-adapter/discord
```

Use the version that matches ViteHub's `chat` package. `pnpm why chat` shows it.

### Enable Agents on the Node host

::tabs{sync="framework"}
:::tabs-item{label="Nuxt"}
```ts [nuxt.config.ts]
export default defineNuxtConfig({
  modules: ['vite-hub/nuxt'],
  vitehub: {
    host: 'node',
    agent: true,
    workflow: false,
  },
})
```
:::

:::tabs-item{label="Nitro"}
```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { nitro } from 'nitro/vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [
    vitehub({
      host: 'node',
      agent: true,
      workflow: false,
    }),
    nitro(),
  ],
})
```
:::

:::tabs-item{label="Vite"}
```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [
    vitehub({
      host: 'node',
      agent: true,
      workflow: false,
    }),
  ],
})
```
:::
::

The `node` host starts the Gateway listener in the server process. `workflow: false` runs each reply inline in that process.

### Define the Agent

```ts [server/agents/assistant.ts]
import { defineAgent } from 'vite-hub/agent'
import { access } from 'vite-hub/agent/capabilities'
import { discord } from 'vite-hub/agent/channels'

const allowedUsers = new Set(['discord:111111111111111111'])

export default defineAgent({
  channels: {
    discord: discord({
      adapter: true,
    }),
  },
  capabilities: [
    access({
      chat: {
        resolve: ({ invoker }) => invoker !== undefined && allowedUsers.has(invoker.id),
      },
    }),
  ],
  driver: {
    model: 'openai/gpt-5.1-mini',
    instructions: 'You are a helpful assistant in Discord. Keep answers short.',
  },
})
```

- `adapter: true` builds the adapter from Server Env. With no `adapter` option, `discord()` has no adapter and no Gateway listener.
- `access()` admits only the invoker IDs in the set. Each ID is `discord:<user ID>`. Return `false` and the Agent does not start or reply. The Discord adapter may already have created an empty thread for a server mention. To copy a user ID, turn on **Developer Mode** in Discord's advanced settings, then right-click the user.
- To answer a role mention, pass `adapter: { mentionRoleIds: ['<role id>'] }` instead of `adapter: true`. Omitted adapter options still come from Server Env.

The model string runs through AI Gateway, so the server needs `AI_GATEWAY_API_KEY`. See [Agent Drivers](/docs/agents/agent-drivers#use-a-model-backed-driver) to use another model.

### Set the server environment

`discord({ adapter: true })` reads its credentials from Server Env, first the `VITEHUB_` name, then the Discord name. The adapter needs all three.

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

The Gateway connection goes out from your machine to Discord, so you need no public URL or tunnel. Send the bot a direct message, or mention it in a server channel: `@Assistant what is ViteHub?`. It answers in a new thread under your message.

Check what ViteHub found:

```bash [Terminal]
pnpm vitehub agent info --agent assistant --url http://localhost:3000
```

If the bot does not answer, look for `[vitehub:agent] Discord Gateway listener failed and will retry.` in the server log. ViteHub retries 5 seconds after a failure. Listener start, stop, and failure events also show in the JSON logs under the `vitehub.channel.listener` scope. See [Inspect delivery custody](/docs/agents/channels#inspect-delivery-custody).

## Deploy the bot

Deploy the `node` host to a server or container that runs all the time. See [Node and self-hosted](/docs/frameworks-hosts/node-self-hosted) for the build output.

```bash [Terminal]
pnpm build
VITEHUB_AGENT_STATE_URL=file:/var/lib/assistant/agent-state.sqlite \
DISCORD_BOT_TOKEN=... \
DISCORD_PUBLIC_KEY=... \
DISCORD_APPLICATION_ID=... \
AI_GATEWAY_API_KEY=... \
node .output/server/index.mjs
```

Production needs durable Agent State for thread subscriptions and queued deliveries. `VITEHUB_AGENT_STATE_URL` points it at a SQLite file on a disk that survives a restart. See [History and sessions](/docs/agents/chat-history-sessions).

Run one server process for the bot, because each process opens its own Gateway connection.

## Serverless hosts

A serverless function cannot keep the Gateway open, so the listener starts only on the `node` host. You can generate a wake route instead:

::tabs{sync="framework"}
:::tabs-item{label="Nuxt"}
```ts [nuxt.config.ts]
export default defineNuxtConfig({
  modules: ['vite-hub/nuxt'],
  vitehub: {
    host: 'vercel',
    agent: { routes: { discordGateway: true } },
  },
})
```
:::

:::tabs-item{label="Nitro"}
```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { nitro } from 'nitro/vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [
    vitehub({
      host: 'vercel',
      agent: { routes: { discordGateway: true } },
    }),
    nitro(),
  ],
})
```
:::

:::tabs-item{label="Vite"}
```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [
    vitehub({
      host: 'vercel',
      agent: { routes: { discordGateway: true } },
    }),
  ],
})
```
:::
::

This adds `GET /api/_vitehub/agents/<agent>/discord/gateway`. In production it needs `VITEHUB_DISCORD_GATEWAY_SECRET` and an `Authorization: Bearer <secret>` header. Each call opens the Gateway for 9 minutes (or `VITEHUB_DISCORD_GATEWAY_DURATION_MS`) and forwards each event to the webhook route `/api/_vitehub/agents/<agent>/webhooks/discord`.

ViteHub does not call this route. Call it on a timer that overlaps the listener time, and the host must let the function run that long. Many serverless plans stop it sooner, and we have no deployed test of this path. For an always-online bot, use the `node` host. There, `routes.discordGateway` adds no route, because the server process owns the listener.

## Limits

- **Mentions.** In a direct message, the bot answers every message. In a server channel, it answers only messages that mention it, and it answers in a new thread. To also answer replies in that thread without a mention, set `messages: { replyToSubscribedThreads: true }`. Read [Answer replies in subscribed threads](/docs/agents/channels#answer-replies-in-subscribed-threads).
- **Other bots.** ViteHub ignores messages from other bots. Set `messages: { allowBots: true }` to change this.
- **Allowed users.** The `access()` allow-list checks provider-derived invoker IDs. It does not authenticate a user with your app. A Discord user ID alone is not a trusted application identity. Before the Agent reads private data, authenticate the user with your app and resolve a trusted [Invoker](/docs/agents/trusted-invokers).
- **Slash commands.** The Agent answers chat messages. ViteHub does not register slash commands for you.
- **Host.** The always-online path needs a long-running Node.js process. Check the [support matrix](/docs/frameworks-hosts/support-matrix) before you choose another host.
- **Proof.** ViteHub has contract tests for the Discord Channel, the Gateway route, and the Node listener plugin. It does not run a deployed Discord bot in CI.

## Next steps

- [Agent Channels](/docs/agents/channels): admission, delivery, attachments, and Channel instructions.
- [Trusted Invokers](/docs/agents/trusted-invokers): pass a trusted identity to the Agent.
- [Learn to build with Agents](/docs/agents/get-started): add tools and Workspaces to the same Agent.
- [Build an AI Slack bot](/docs/guides/slack-ai-bot) and [Build an AI Telegram bot](/docs/guides/telegram-ai-bot) with the same Agent file.
