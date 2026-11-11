---
title: Build an AI Telegram bot with ViteHub
description: "Build an AI Telegram bot with a ViteHub Agent. Create the bot with BotFather, add telegram() to defineAgent, register the webhook with the CLI, and deploy it."
navigation.title: Telegram AI bot
navigation.order: 6
navigation.group: Chat bots
icon: i-simple-icons-telegram
---

Create a bot with BotFather, add `telegram()` from `vite-hub/agent/channels` to the `channels` of a `defineAgent()` file, and set `TELEGRAM_BOT_TOKEN` and `TELEGRAM_WEBHOOK_SECRET_TOKEN` on the server. ViteHub serves the webhook at `/api/_vitehub/agents/<agent>/webhooks/telegram`. Run `vitehub channels sync` once to point Telegram at it. The Agent then answers direct messages, and group messages that mention the bot.

## What a ViteHub Telegram bot is

A [Telegram bot](https://core.telegram.org/bots) is a Telegram account that a program controls through the [Bot API](https://core.telegram.org/bots/api). Telegram sends each new message to your webhook URL as an HTTPS `POST`.

In ViteHub, the bot is a [Channel](/docs/agents/channels) of an Agent: a way for messages to reach it. `telegram()` builds a [Chat SDK](https://chat-sdk.dev) Telegram adapter, checks the webhook secret, and starts one Agent run (Invocation) per accepted message. ViteHub sends the answer to the same chat as a reply. You write the Agent; ViteHub owns the webhook route, the secret check, and the reply.

## Create the bot with BotFather

1. Open [@BotFather](https://t.me/botfather) in Telegram and send `/newbot`.
2. Give the bot a display name and a username that ends in `bot`, such as `acme_assistant_bot`.
3. Copy the token BotFather sends (`TELEGRAM_BOT_TOKEN`). Anyone with the token controls the bot, so keep it secret.
4. For groups, send `/setprivacy` to BotFather, select the bot, and choose **Disable**. With privacy mode on, Telegram does not send all group messages to the bot. ViteHub still answers only mentions. Add the bot to the group again after this change.

Then make a webhook secret. Telegram sends it in the `X-Telegram-Bot-Api-Secret-Token` header of each request, and ViteHub rejects requests without it. It takes 1 to 256 characters: letters, digits, `_`, and `-`.

```bash [Terminal]
openssl rand -hex 32
```

See the [BotFather guide](https://core.telegram.org/bots/features#botfather) for other settings, such as the profile photo and command list.

## Set up the app

Start with the app from [Installation](/docs/getting-started/installation). `vite-hub` already includes the Telegram adapter.

### Enable Agents

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

`workflow: false` runs each reply inline in the server process. If a reply must survive a restart, see [Workflow](/docs/workflows).

### Define the Agent

```ts [server/agents/assistant.ts]
import { defineAgent } from 'vite-hub/agent'
import { telegram } from 'vite-hub/agent/channels'

export default defineAgent({
  channels: {
    telegram: telegram({
      mode: 'webhook',
      allowedUserIds: ['123456789'],
    }),
  },
  driver: {
    model: 'openai/gpt-5.1-mini',
    instructions: 'You are a helpful assistant in Telegram. Keep answers short.',
  },
})
```

- The file name is the Agent name (`assistant`), and the `channels` key is the webhook name (`telegram`).
- `mode: 'webhook'` uses webhooks only. The Chat SDK adapter can pick a mode itself, but ViteHub keeps webhook routing when `mode` is omitted. To poll, set `mode: 'polling'`, then mount and call `createTelegramPollingRouteHandler()` from `vite-hub/agent/server`.
- `allowedUserIds` lists numeric Telegram user IDs. The bot ignores everyone else and sends no answer. Without the option, the adapter reads a comma-separated list from `TELEGRAM_ALLOWED_USER_IDS`; with neither, every user can talk to the bot.
- `telegram()` adds Telegram formatting rules to the instructions, such as no Markdown tables.

The model string runs through AI Gateway, so the server needs `AI_GATEWAY_API_KEY`. See [Agent Drivers](/docs/agents/agent-drivers#use-a-model-backed-driver) to use another model or credential.

### Set the server environment

`telegram()` reads its credentials from Server Env, first the `VITEHUB_` name, then the Telegram name.

| Value | Variable | Required |
| --- | --- | --- |
| Bot token | `VITEHUB_TELEGRAM_BOT_TOKEN` or `TELEGRAM_BOT_TOKEN` | Yes |
| Webhook secret | `VITEHUB_TELEGRAM_WEBHOOK_SECRET` or `TELEGRAM_WEBHOOK_SECRET_TOKEN` | Yes, in webhook mode |
| Bot API base URL | `VITEHUB_TELEGRAM_API_BASE_URL` or `TELEGRAM_API_BASE_URL` | No |

```bash [.env]
TELEGRAM_BOT_TOKEN=123456:ABC-your-token
TELEGRAM_WEBHOOK_SECRET_TOKEN=your-random-secret
AI_GATEWAY_API_KEY=your-ai-gateway-key
```

Do not commit `.env`. Options passed to `telegram()`, such as `botToken`, win over Server Env. See [Channel Env](/docs/agents/channels#channel-env).

## Test the bot locally

Telegram must reach the webhook over public HTTPS on port 443, 80, 88, or 8443, so open a tunnel to the dev server. This example uses a [Cloudflare quick tunnel](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/). Run the dev server:

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
    host: 'node',
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
  server: { allowedHosts: ['.trycloudflare.com'] },
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

Check the webhook route. A `HEAD` request returns `204` and names the provider:

```bash [Terminal]
curl -I https://your-tunnel.trycloudflare.com/api/_vitehub/agents/assistant/webhooks/telegram
# HTTP/2 204
# x-vitehub-channel-provider: telegram
```

Then register the webhook with Telegram. The first command only prints the plan. The second applies it.

```bash [Terminal]
pnpm vitehub channels sync --stage development \
  --url https://your-tunnel.trycloudflare.com \
  --agent assistant --channel telegram

pnpm vitehub channels sync --stage development \
  --url https://your-tunnel.trycloudflare.com \
  --agent assistant --channel telegram \
  --apply --confirm-origin https://your-tunnel.trycloudflare.com
```

It reads the token and secret from the environment, checks that the route is live at that origin, and calls Telegram's `setWebhook`. It never prints the secrets. See [Synchronize Channel webhooks](/docs/development/cli#synchronize-channel-webhooks) for other flags.

Send the bot a direct message, and it replies to your message. In a group, mention it: `@acme_assistant_bot what is ViteHub?`.

A quick tunnel gets a new URL on each start. Run `channels sync` again after a restart, and for production.

## Deploy the bot

This example deploys the `node` host to your own server, behind an HTTPS reverse proxy. See [Node and self-hosted](/docs/frameworks-hosts/node-self-hosted) for the build output.

```bash [Terminal]
pnpm build
VITEHUB_AGENT_STATE_URL=file:/var/lib/assistant/agent-state.sqlite \
TELEGRAM_BOT_TOKEN=... \
TELEGRAM_WEBHOOK_SECRET_TOKEN=... \
AI_GATEWAY_API_KEY=... \
PORT=3000 node .output/server/index.mjs
```

Production needs durable Agent State for thread subscriptions and queued deliveries. `VITEHUB_AGENT_STATE_URL` points it at a SQLite file on a disk that survives a restart. See [History and sessions](/docs/agents/chat-history-sessions).

Then point Telegram at the production URL:

```bash [Terminal]
pnpm vitehub channels sync --stage production \
  --url https://bot.example.com \
  --agent assistant --channel telegram \
  --apply --confirm-origin https://bot.example.com
```

The webhook route also works off Node:

- On Cloudflare, Agent State lives in a Durable Object. The Agent must answer in about 28 seconds, because Cloudflare stops background work after 30.
- On Vercel and Netlify, set `VITEHUB_AGENT_STATE_URL` to a hosted libSQL database, because they reject `file:` URLs.

See [Deploy the same Agent on Cloudflare and Vercel](/docs/guides/deploy-agent-cloudflare-vercel) for those hosts.

## Limits

- **Mentions.** In a direct chat, the bot answers every message. In a group, it answers only messages that mention it. To also answer replies in a thread that the bot already joined, set `messages: { replyToSubscribedThreads: true }`. Read [Answer replies in subscribed threads](/docs/agents/channels#answer-replies-in-subscribed-threads).
- **Other bots.** ViteHub ignores messages from other bots, so two bots do not answer each other without end. Set `messages: { allowBots: true }` to change this.
- **Allowed users.** `allowedUserIds` is a filter, not sign-in. A Telegram user ID is not a trusted identity for your app. When the Agent reads private data, resolve a trusted [Invoker](/docs/agents/trusted-invokers) first.
- **History.** Telegram keeps only 100 messages for seven days for a bot. With durable Agent State, ViteHub also keeps a transcript of each chat. Read [Keep transcripts](/docs/agents/channels#keep-transcripts).
- **Polling.** The generated routes serve webhook mode. With `mode: 'polling'`, `channels sync` plans to remove the webhook, and your app must start the listener itself with `createTelegramPollingRouteHandler()` from `vite-hub/agent/server`.
- **Proof.** ViteHub has contract tests for the Telegram Channel and its webhook route. It does not run a deployed Telegram bot in CI.

## Next steps

- [Agent Channels](/docs/agents/channels): admission, delivery, attachments, and Channel instructions.
- [Trusted Invokers](/docs/agents/trusted-invokers): pass a trusted identity to the Agent.
- [Learn to build with Agents](/docs/agents/get-started): add tools and Workspaces to the same Agent.
- [Build an AI Slack bot](/docs/guides/slack-ai-bot) and [Build an AI Discord bot](/docs/guides/discord-ai-bot) with the same Agent file.
