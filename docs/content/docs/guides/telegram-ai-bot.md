---
title: Build an AI Telegram bot with ViteHub
description: Build an AI Telegram bot with a ViteHub Agent. Create the bot with BotFather, add telegram() to defineAgent, register the webhook with the ViteHub CLI, and deploy it.
navigation.title: Telegram AI bot
navigation.order: 6
navigation.group: Chat bots
icon: i-simple-icons-telegram
---

To build an AI Telegram bot with ViteHub, create a bot with BotFather, add `telegram()` from `vite-hub/agent/channels` to the `channels` of a `defineAgent()` file, and set `TELEGRAM_BOT_TOKEN` and `TELEGRAM_WEBHOOK_SECRET_TOKEN` on the server. ViteHub serves the webhook at `/api/_vitehub/agents/<agent>/webhooks/telegram`. Run `vitehub channels sync` once to point Telegram at that URL. The Agent then answers direct messages, and group messages that mention the bot.

## What a ViteHub Telegram bot is

A [Telegram bot](https://core.telegram.org/bots) is a Telegram account that a program controls through the [Bot API](https://core.telegram.org/bots/api). Telegram sends each new message to your webhook URL as an HTTPS `POST`.

In ViteHub, the bot is a [Channel](/docs/agents/channels) of an Agent. The `telegram()` Channel helper builds a [Chat SDK](https://chat-sdk.dev) Telegram adapter, checks the webhook secret, and starts one Agent Invocation for each message that it accepts. The Agent writes the answer, and ViteHub sends it back to the same chat as a reply to the message. You write the Agent. ViteHub owns the webhook route, the secret check, and the reply.

## Create the bot with BotFather

1. Open [@BotFather](https://t.me/botfather) in Telegram and send `/newbot`.
2. Give the bot a display name and a username that ends in `bot`, such as `acme_assistant_bot`.
3. Copy the token that BotFather sends. This is `TELEGRAM_BOT_TOKEN`. Anyone with the token controls the bot, so keep it secret.
4. To use the bot in groups, send `/setprivacy` to BotFather, select the bot, and choose **Disable**. With privacy mode on, Telegram does not send all group messages to the bot. ViteHub still answers only the group messages that mention the bot. Add the bot to the group again after you change this setting.

Then make a webhook secret. Telegram sends it back in the `X-Telegram-Bot-Api-Secret-Token` header of each webhook request, and ViteHub rejects requests without it. Telegram accepts 1 to 256 characters: letters, digits, `_`, and `-`.

```bash [Terminal]
openssl rand -hex 32
```

Read the [BotFather guide](https://core.telegram.org/bots/features#botfather) for the other bot settings, such as the profile photo and the command list.

## Set up the app

Start with the Vite app from [Installation](/docs/getting-started/installation). The Telegram adapter is a dependency of `vite-hub`, so you do not install another package.

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

`workflow: false` keeps each reply inline in the server process. Read [Workflow](/docs/workflows) when a reply must survive a restart.

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

- The file name is the Agent name: `assistant`.
- The key in `channels` is the webhook name: `telegram`.
- `mode: 'webhook'` makes the adapter use webhooks only. Without it, the Chat SDK adapter selects webhook or polling mode at startup.
- `allowedUserIds` is a list of numeric Telegram user IDs. The bot ignores messages from all other users and sends no answer. Remove the option to let every Telegram user talk to the bot. When you omit it, the adapter reads a comma-separated list from `TELEGRAM_ALLOWED_USER_IDS`.
- `telegram()` adds Telegram formatting rules to the Agent instructions, for example no Markdown tables.

The model string runs through AI Gateway, so the server needs `AI_GATEWAY_API_KEY`. Read [Agent Drivers](/docs/agents/agent-drivers#use-a-model-backed-driver) to use another model or credential.

### Set the server environment

`telegram()` reads its credentials from Server Env. For each value, ViteHub reads the `VITEHUB_` name first and then the Telegram name.

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

Do not commit `.env`. Options that you pass to `telegram()`, such as `botToken`, take precedence over Server Env. See [Channel Env](/docs/agents/channels#channel-env).

## Test the bot locally

Telegram must reach the webhook over public HTTPS on port 443, 80, 88, or 8443. To test the dev server, open a tunnel to it. This example uses a [Cloudflare quick tunnel](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/):

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
curl -I https://your-tunnel.trycloudflare.com/api/_vitehub/agents/assistant/webhooks/telegram
# HTTP/2 204
# x-vitehub-channel-provider: telegram
```

Then register the webhook with Telegram. The first command prints the plan and changes nothing. The second command applies it.

```bash [Terminal]
pnpm vitehub channels sync --stage development \
  --url https://your-tunnel.trycloudflare.com \
  --agent assistant --channel telegram

pnpm vitehub channels sync --stage development \
  --url https://your-tunnel.trycloudflare.com \
  --agent assistant --channel telegram \
  --apply --confirm-origin https://your-tunnel.trycloudflare.com
```

The command reads the bot token and the webhook secret from the environment, checks that the route is live at that origin, and calls Telegram's `setWebhook`. It never prints the secrets. Read [Synchronize Channel webhooks](/docs/development/cli#synchronize-channel-webhooks) for the other flags.

Send the bot a direct message in Telegram. The bot answers as a reply to your message. In a group, mention it, for example `@acme_assistant_bot what is ViteHub?`.

A quick tunnel gets a new URL each time it starts. Run `channels sync` again after a restart, or when you move to the production URL.

## Deploy the bot

This example deploys the `node` preset to a server that you control. Put an HTTPS reverse proxy in front of it. Read [Node and self-hosted](/docs/frameworks-hosts/node-self-hosted) for the build output.

```bash [Terminal]
pnpm build
VITEHUB_AGENT_STATE_URL=file:/var/lib/assistant/agent-state.sqlite \
TELEGRAM_BOT_TOKEN=... \
TELEGRAM_WEBHOOK_SECRET_TOKEN=... \
AI_GATEWAY_API_KEY=... \
PORT=3000 node .output/server/index.mjs
```

A production build needs durable Agent State for thread subscriptions and queued deliveries. `VITEHUB_AGENT_STATE_URL` gives it a SQLite file. Keep that file on a disk that survives a restart. Read [History and sessions](/docs/agents/chat-history-sessions) for the State options.

Then point Telegram at the production URL:

```bash [Terminal]
pnpm vitehub channels sync --stage production \
  --url https://bot.example.com \
  --agent assistant --channel telegram \
  --apply --confirm-origin https://bot.example.com
```

The webhook route is not specific to Node. On Cloudflare, ViteHub keeps Agent State in a Durable Object, and the Agent must answer in about 28 seconds because Cloudflare stops background work after 30 seconds. On Vercel and Netlify, set `VITEHUB_AGENT_STATE_URL` to a hosted libSQL database, because those hosts reject `file:` URLs. Read [Deploy the same Agent on Cloudflare and Vercel](/docs/guides/deploy-agent-cloudflare-vercel) for those presets.

## Limits

- **Mentions.** In a direct chat, the bot answers every message. In a group, it answers only messages that mention it. To also answer replies in a thread that the bot already joined, set `messages: { replyToSubscribedThreads: true }`. Read [Answer replies in subscribed threads](/docs/agents/channels#answer-replies-in-subscribed-threads).
- **Other bots.** ViteHub ignores messages from other bots, so two bots do not answer each other without end. Set `messages: { allowBots: true }` to change this.
- **Allowed users.** `allowedUserIds` is a filter, not sign-in. A Telegram user ID is not a trusted identity for your app. When the Agent reads private data, resolve a trusted [Actor](/docs/agents/actors) first.
- **History.** Telegram keeps only 100 messages for seven days for a bot. With durable Agent State, ViteHub also keeps a transcript of each chat. Read [Keep transcripts](/docs/agents/channels#keep-transcripts).
- **Polling.** The generated routes serve webhook mode. With `mode: 'polling'`, `channels sync` plans to remove the webhook, and your app must start the listener itself with `createTelegramPollingRouteHandler()` from `vite-hub/agent/server`.
- **Proof.** ViteHub has contract tests for the Telegram Channel and its webhook route. It does not run a deployed Telegram bot in CI.

## Next steps

- [Agent Channels](/docs/agents/channels): admission, delivery, attachments, and Channel instructions.
- [Agent Actors](/docs/agents/actors): pass a trusted identity to the Agent.
- [Learn to build with Agents](/docs/agents/get-started): add tools and Workspaces to the same Agent.
- [Build an AI Slack bot](/docs/guides/slack-ai-bot) and [Build an AI Discord bot](/docs/guides/discord-ai-bot) with the same Agent file.
