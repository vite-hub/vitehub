---
title: Build an AI Slack bot with ViteHub
description: Create a Slack bot that answers with AI. Make the Slack app from a manifest, pass the Chat SDK Slack adapter to slack() in defineAgent, and point Slack Event Subscriptions at the ViteHub webhook route.
navigation.title: Slack AI bot
navigation.order: 4
navigation.group: Chat bots
icon: i-simple-icons-slack
---

To build an AI Slack bot with ViteHub, create a Slack app with the `app_mentions:read`, `chat:write`, and history scopes, install `@chat-adapter/slack`, and pass `createSlackAdapter()` to `slack()` from `vite-hub/agent/channels` in a `defineAgent()` file. Then set the Slack **Event Subscriptions** Request URL to `https://<your-app>/api/_vitehub/agents/<agent>/webhooks/slack`. The Agent answers direct messages, and channel messages that mention the bot, in a thread.

## What a ViteHub Slack bot is

A [Slack app](https://api.slack.com/start) with a bot user receives events from the [Events API](https://api.slack.com/apis/events-api). Slack sends each event as an HTTPS `POST` to your Request URL and signs it with your app's signing secret.

In ViteHub, the bot is a [Channel](/docs/agents/channels) of an Agent. `slack()` connects a [Chat SDK](https://chat-sdk.dev) Slack adapter to the Agent webhook route. The adapter checks the Slack signature, answers Slack's URL check, and reads the message. Each message that ViteHub accepts starts one Agent Invocation, and ViteHub posts the answer in the message thread.

Unlike `discord()` and `telegram()`, `slack()` does not build the adapter or read Slack credentials for you. You pass the adapter, and the adapter reads the Slack token and signing secret.

## Create the Slack app

Open [api.slack.com/apps](https://api.slack.com/apps), select **Create New App**, then **From an app manifest**, and choose your workspace. Paste this manifest and replace the Request URL host with the public URL of your app. Read [App manifests](https://api.slack.com/reference/manifests) for every field.

```yaml [slack-manifest.yaml]
display_information:
  name: Assistant
features:
  app_home:
    messages_tab_enabled: true
    messages_tab_read_only_enabled: false
  bot_user:
    display_name: Assistant
    always_online: true
oauth_config:
  scopes:
    bot:
      - app_mentions:read
      - channels:history
      - chat:write
      - groups:history
      - im:history
      - mpim:history
      - users:read
settings:
  event_subscriptions:
    request_url: https://bot.example.com/api/_vitehub/agents/assistant/webhooks/slack
    bot_events:
      - app_mention
      - message.channels
      - message.groups
      - message.im
      - message.mpim
  org_deploy_enabled: false
  socket_mode_enabled: false
  token_rotation_enabled: false
```

| Scope | Why the bot needs it |
| --- | --- |
| `app_mentions:read` | Receive `app_mention` events when someone mentions the bot. |
| `chat:write` | Post answers. |
| `channels:history`, `groups:history`, `mpim:history` | Receive and read messages in public channels, private channels, and group DMs. |
| `im:history` | Receive and read direct messages to the bot. |
| `users:read` | Show the name of the person who wrote a message. |

`messages_tab_enabled` lets people send direct messages to the bot from its **Messages** tab.

Slack checks the Request URL when you save it, so the app must be running at that URL. If it is not live yet, create the app first. Then set the URL on the **Event Subscriptions** page after you start the app.

After you create the app:

1. On **Basic Information**, under **App Credentials**, copy the **Signing Secret** (`SLACK_SIGNING_SECRET`).
2. On **OAuth & Permissions**, select **Install to Workspace**, then copy the **Bot User OAuth Token**, which starts with `xoxb-` (`SLACK_BOT_TOKEN`).

Keep both values secret. After you change scopes or events, install the app again.

## Set up the app

Start with the Vite app from [Installation](/docs/getting-started/installation). Install the Slack adapter:

```bash [Terminal]
pnpm add @chat-adapter/slack
```

Use the version that matches the `chat` package that ViteHub installs. `pnpm why chat` shows it.

### Enable Agents

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

`workflow: false` keeps each reply inline in the server process.

### Define the Agent

```ts [server/agents/assistant.ts]
import { createSlackAdapter } from '@chat-adapter/slack'
import { defineAgent } from 'vite-hub/agent'
import { slack } from 'vite-hub/agent/channels'

const allowedUsers = new Set(['U0123456789'])

export default defineAgent({
  channels: {
    slack: slack({
      adapter: () => createSlackAdapter({
        botToken: process.env.SLACK_BOT_TOKEN,
        signingSecret: process.env.SLACK_SIGNING_SECRET,
      }),
      messages: {
        filter: ({ message }) => allowedUsers.has(message.author.userId),
      },
    }),
  },
  driver: {
    model: 'openai/gpt-5.1-mini',
    instructions: 'You are a helpful assistant in Slack. Keep answers short.',
  },
})
```

- The file name is the Agent name: `assistant`. The key in `channels` is the webhook name: `slack`. Together they make the Request URL `/api/_vitehub/agents/assistant/webhooks/slack`.
- `adapter` is a function, so ViteHub creates the adapter when a request arrives and reads the environment at that time.
- `messages.filter` is optional. Here it admits only the Slack member IDs in the set. Return `false` and the Agent does not start and posts nothing. To copy a member ID, open a profile in Slack and select **Copy member ID**.

The model string runs through AI Gateway, so the server needs `AI_GATEWAY_API_KEY`. Read [Agent Drivers](/docs/agents/agent-drivers#use-a-model-backed-driver) to use another model.

### Set the server environment

```bash [.env]
SLACK_BOT_TOKEN=xoxb-your-token
SLACK_SIGNING_SECRET=your-signing-secret
AI_GATEWAY_API_KEY=your-ai-gateway-key
```

Do not commit `.env`. ViteHub does not declare Slack values in [Server Env](/docs/env), because `slack()` does not read them. Your adapter code reads them.

## Test the bot locally

Slack must reach the Request URL over public HTTPS. To test the dev server, open a tunnel to it. This example uses a [Cloudflare quick tunnel](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/):

```bash [Terminal]
pnpm dev
cloudflared tunnel --url http://localhost:3000
```

Vite blocks requests for host names that it does not know. Add the tunnel domain to `server.allowedHosts` in `vite.config.ts`:

```ts [vite.config.ts]
export default defineConfig({
  server: { allowedHosts: ['.trycloudflare.com'] },
  plugins: [/* ... */],
})
```

Check that the webhook route answers. A `HEAD` request returns `204` and names the provider:

```bash [Terminal]
curl -I https://your-tunnel.trycloudflare.com/api/_vitehub/agents/assistant/webhooks/slack
# HTTP/2 204
# x-vitehub-channel-provider: slack
```

Set `https://your-tunnel.trycloudflare.com/api/_vitehub/agents/assistant/webhooks/slack` as the Request URL on **Event Subscriptions**. Slack shows **Verified** when the route answers its check. Save the change.

Invite the bot to a channel with `/invite @Assistant`, then mention it: `@Assistant what is ViteHub?`. The bot answers in a thread. You can also open the bot's **Messages** tab and send it a direct message.

A quick tunnel gets a new URL each time it starts. Update the Request URL after a restart, and again when you move to the production URL.

## Deploy the bot

This example deploys the `node` preset to a server that you control. Put an HTTPS reverse proxy in front of it. Read [Node and self-hosted](/docs/frameworks-hosts/node-self-hosted) for the build output.

```bash [Terminal]
pnpm build
VITEHUB_AGENT_STATE_URL=file:/var/lib/assistant/agent-state.sqlite \
SLACK_BOT_TOKEN=... \
SLACK_SIGNING_SECRET=... \
AI_GATEWAY_API_KEY=... \
PORT=3000 node .output/server/index.mjs
```

A production build needs durable Agent State for thread subscriptions and queued deliveries. `VITEHUB_AGENT_STATE_URL` gives it a SQLite file on a disk that survives a restart. Read [History and sessions](/docs/agents/chat-history-sessions).

Then set the production Request URL, such as `https://bot.example.com/api/_vitehub/agents/assistant/webhooks/slack`, on **Event Subscriptions**. ViteHub does not register Slack URLs for you; `vitehub channels sync` supports only Telegram.

The webhook route is not specific to Node. On Cloudflare, ViteHub keeps Agent State in a Durable Object, and the Agent must answer in about 28 seconds because Cloudflare stops background work after 30 seconds. On Vercel and Netlify, set `VITEHUB_AGENT_STATE_URL` to a hosted libSQL database, because those hosts reject `file:` URLs. Read [Deploy the same Agent on Cloudflare and Vercel](/docs/guides/deploy-agent-cloudflare-vercel) for those presets.

## Limits

- **Mentions.** In a direct message, the bot answers every message. In a channel, it answers only messages that mention it. To also answer replies in that thread without a mention, set `messages: { replyToSubscribedThreads: true }`. Slack sends those replies only with the `message.channels`, `message.groups`, or `message.mpim` events. Read [Answer replies in subscribed threads](/docs/agents/channels#answer-replies-in-subscribed-threads).
- **Other bots.** ViteHub ignores messages from other bots. Set `messages: { allowBots: true }` to change this.
- **Allowed users.** `messages.filter` is a filter, not sign-in. A Slack member ID is not a trusted identity for your app. When the Agent reads private data, resolve a trusted [Actor](/docs/agents/actors) first.
- **One workspace.** This setup uses one bot token for one workspace. For an app that many workspaces install, configure OAuth in the Chat SDK adapter. Read the [Slack adapter docs](https://chat-sdk.dev/adapters/official/slack).
- **Socket Mode.** The ViteHub webhook route needs the Events API over HTTPS. ViteHub does not start a Socket Mode listener.
- **Proof.** `slack()` is a thin Channel over your adapter. ViteHub tests its types and the shared Chat SDK webhook route, but it does not run a Slack adapter or a deployed Slack bot in CI.

## Next steps

- [Agent Channels](/docs/agents/channels): admission, delivery, attachments, and Channel instructions.
- [Agent Actors](/docs/agents/actors): pass a trusted identity to the Agent.
- [Learn to build with Agents](/docs/agents/get-started): add tools and Workspaces to the same Agent.
- [Build an AI Discord bot](/docs/guides/discord-ai-bot) and [Build an AI Telegram bot](/docs/guides/telegram-ai-bot) with the same Agent file.
