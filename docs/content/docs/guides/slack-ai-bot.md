---
title: Build an AI Slack bot with ViteHub
description: "Create a Slack bot that answers with AI. Make the Slack app from a manifest, pass the Chat SDK Slack adapter to slack(), and send Slack events to ViteHub."
navigation.title: Slack AI bot
navigation.order: 4
navigation.group: Chat bots
icon: i-simple-icons-slack
---

Create a Slack app with the `app_mentions:read`, `chat:write`, and history scopes. Install `@chat-adapter/slack` and pass `createSlackAdapter()` to `slack()` from `vite-hub/agent/channels` in a `defineAgent()` file. Set the **Event Subscriptions** Request URL to `https://<your-app>/api/_vitehub/agents/<agent>/webhooks/slack`. The Agent answers direct messages and channel mentions in a thread.

## What a ViteHub Slack bot is

A [Slack app](https://api.slack.com/start) with a bot user gets events from the [Events API](https://api.slack.com/apis/events-api). Slack sends each event as a signed HTTPS `POST` to your Request URL.

In ViteHub, the bot is a [Channel](/docs/agents/channels) of an Agent: a way for messages to reach it. `slack()` connects a [Chat SDK](https://chat-sdk.dev) Slack adapter to the Agent webhook route. The adapter checks the signature, answers Slack's URL check, and reads the message. Each accepted message starts one Agent run (Invocation), and ViteHub posts the answer in the thread.

Unlike `discord()` and `telegram()`, `slack()` does not build the adapter or read credentials. You pass the adapter, and it reads the Slack token and signing secret.

## Create the Slack app

Open [api.slack.com/apps](https://api.slack.com/apps), select **Create New App**, then **From an app manifest**, and choose your workspace. Paste this manifest and put your app's public URL in the Request URL. See [App manifests](https://api.slack.com/reference/manifests) for each field.

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
| `app_mentions:read` | Get `app_mention` events when someone mentions the bot. |
| `chat:write` | Post answers. |
| `channels:history`, `groups:history`, `mpim:history` | Read messages in public channels, private channels, and group DMs. |
| `im:history` | Read direct messages to the bot. |
| `users:read` | Show the name of the message author. |

`messages_tab_enabled` lets people message the bot from its **Messages** tab.

Slack checks the Request URL when you save it, so the app must be running there. If it is not live yet, create the Slack app now and set the URL on **Event Subscriptions** later.

Then:

1. On **Basic Information**, under **App Credentials**, copy the **Signing Secret** (`SLACK_SIGNING_SECRET`).
2. On **OAuth & Permissions**, select **Install to Workspace**, then copy the **Bot User OAuth Token**, which starts with `xoxb-` (`SLACK_BOT_TOKEN`).

Keep both secret. Install the app again after you change scopes or events.

## Set up the app

Start with the app from [Installation](/docs/getting-started/installation) and install the Slack adapter:

```bash [Terminal]
pnpm add @chat-adapter/slack
```

Use the version that matches ViteHub's `chat` package. `pnpm why chat` shows it.

### Enable Agents

::tabs{sync="framework"}
:::tabs-item{label="Nuxt"}
```ts [nuxt.config.ts]
export default defineNuxtConfig({
  modules: ['vite-hub/nuxt'],
  vitehub: {
    preset: 'node',
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
      preset: 'node',
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
      preset: 'node',
      agent: true,
      workflow: false,
    }),
  ],
})
```
:::
::

`workflow: false` runs each reply inline in the server process.

### Define the Agent

```ts [server/agents/assistant.ts]
import { createSlackAdapter } from '@chat-adapter/slack'
import { defineAgent } from 'vite-hub/agent'
import { access } from 'vite-hub/agent/capabilities'
import { slack } from 'vite-hub/agent/channels'

const allowedUsers = new Set(['slack:U0123456789'])

export default defineAgent({
  channels: {
    slack: slack({
      adapter: () => createSlackAdapter({
        botToken: process.env.SLACK_BOT_TOKEN,
        signingSecret: process.env.SLACK_SIGNING_SECRET,
      }),
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
    instructions: 'You are a helpful assistant in Slack. Keep answers short.',
  },
})
```

- The file name is the Agent name (`assistant`), and the `channels` key is the webhook name (`slack`). Together they make the Request URL `/api/_vitehub/agents/assistant/webhooks/slack`.
- `adapter` is a function, so ViteHub creates the adapter and reads the environment when a request arrives.
- `access()` admits only the invoker IDs in the set. Each ID is `slack:<member ID>`. Return `false` and the Agent does not start and posts nothing. To copy a member ID, open a profile in Slack and select **Copy member ID**.

The model string runs through AI Gateway, so the server needs `AI_GATEWAY_API_KEY`. See [Agent Drivers](/docs/agents/agent-drivers#use-a-model-backed-driver) to use another model.

### Set the server environment

```bash [.env]
SLACK_BOT_TOKEN=xoxb-your-token
SLACK_SIGNING_SECRET=your-signing-secret
AI_GATEWAY_API_KEY=your-ai-gateway-key
```

Do not commit `.env`. Slack values are not declared in [Server Env](/docs/env), because your adapter code reads them, not `slack()`.

## Test the bot locally

Slack must reach the Request URL over public HTTPS, so open a tunnel to the dev server. This example uses a [Cloudflare quick tunnel](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/). Run the dev server:

```bash [Terminal 1]
pnpm dev
```

Then open the tunnel in a second terminal:

```bash [Terminal 2]
cloudflared tunnel --url http://localhost:3000
```

Vite blocks unknown host names, so add the tunnel domain to `server.allowedHosts` (`vite.server.allowedHosts` in Nuxt).

::tabs{sync="framework"}
:::tabs-item{label="Nuxt"}
```ts [nuxt.config.ts]
export default defineNuxtConfig({
  modules: ['vite-hub/nuxt'],
  vitehub: {
    preset: 'node',
    agent: true,
    workflow: false,
  },
  vite: {
    server: { allowedHosts: ['.trycloudflare.com'] },
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
  server: { allowedHosts: ['.trycloudflare.com'] },
  plugins: [
    vitehub({
      preset: 'node',
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
  server: { allowedHosts: ['.trycloudflare.com'] },
  plugins: [
    vitehub({
      preset: 'node',
      agent: true,
      workflow: false,
    }),
  ],
})
```
:::
::

Check the webhook route. A `HEAD` request returns `204` and names the provider:

```bash [Terminal]
curl -I https://your-tunnel.trycloudflare.com/api/_vitehub/agents/assistant/webhooks/slack
# HTTP/2 204
# x-vitehub-channel-provider: slack
```

Set `https://your-tunnel.trycloudflare.com/api/_vitehub/agents/assistant/webhooks/slack` as the Request URL on **Event Subscriptions**. Slack shows **Verified** when the route answers. Save.

Invite the bot with `/invite @Assistant`, then mention it: `@Assistant what is ViteHub?`. It answers in a thread. You can also send it a direct message from its **Messages** tab.

A quick tunnel gets a new URL on each start. Update the Request URL after a restart, and again for production.

## Deploy the bot

This example deploys the `node` preset to your own server, behind an HTTPS reverse proxy. See [Node and self-hosted](/docs/frameworks-hosts/node-self-hosted) for the build output.

```bash [Terminal]
pnpm build
VITEHUB_AGENT_STATE_URL=file:/var/lib/assistant/agent-state.sqlite \
SLACK_BOT_TOKEN=... \
SLACK_SIGNING_SECRET=... \
AI_GATEWAY_API_KEY=... \
PORT=3000 node .output/server/index.mjs
```

Production needs durable Agent State for thread subscriptions and queued deliveries. `VITEHUB_AGENT_STATE_URL` points it at a SQLite file on a disk that survives a restart. See [History and sessions](/docs/agents/chat-history-sessions).

Then set the production Request URL, such as `https://bot.example.com/api/_vitehub/agents/assistant/webhooks/slack`, on **Event Subscriptions**. ViteHub does not register Slack URLs; `vitehub channels sync` supports only Telegram.

The webhook route also works off Node:

- On Cloudflare, Agent State lives in a Durable Object. The Agent must answer in about 28 seconds, because Cloudflare stops background work after 30.
- On Vercel and Netlify, set `VITEHUB_AGENT_STATE_URL` to a hosted libSQL database, because they reject `file:` URLs.

See [Deploy the same Agent on Cloudflare and Vercel](/docs/guides/deploy-agent-cloudflare-vercel) for those presets.

## Limits

- **Mentions.** In a direct message, the bot answers every message. In a channel, it answers only messages that mention it. To also answer replies in that thread without a mention, set `messages: { replyToSubscribedThreads: true }`. Slack sends those replies only with the `message.channels`, `message.groups`, or `message.mpim` events. Read [Answer replies in subscribed threads](/docs/agents/channels#answer-replies-in-subscribed-threads).
- **Other bots.** ViteHub ignores messages from other bots. Set `messages: { allowBots: true }` to change this.
- **Allowed users.** The `access()` allow-list checks provider-derived invoker IDs. It does not authenticate a user with your app. A Slack member ID alone is not a trusted application identity. Before the Agent reads private data, authenticate the user with your app and resolve a trusted [Invoker](/docs/agents/trusted-invokers).
- **One workspace.** This setup uses one bot token for one workspace. For an app that many workspaces install, configure OAuth in the Chat SDK adapter. Read the [Slack adapter docs](https://chat-sdk.dev/adapters/official/slack).
- **Socket Mode.** The ViteHub webhook route needs the Events API over HTTPS. ViteHub does not start a Socket Mode listener.
- **Proof.** `slack()` is a thin Channel over your adapter. ViteHub tests its types and the shared Chat SDK webhook route, but it does not run a Slack adapter or a deployed Slack bot in CI.

## Next steps

- [Agent Channels](/docs/agents/channels): admission, delivery, attachments, and Channel instructions.
- [Trusted Invokers](/docs/agents/trusted-invokers): pass a trusted identity to the Agent.
- [Learn to build with Agents](/docs/agents/get-started): add tools and Workspaces to the same Agent.
- [Build an AI Discord bot](/docs/guides/discord-ai-bot) and [Build an AI Telegram bot](/docs/guides/telegram-ai-bot) with the same Agent file.
