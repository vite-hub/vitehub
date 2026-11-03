---
title: Add the docs assistant
description: Answer reader questions from your pages with a ViteHub Agent on your ChatGPT plan, on Node.js or Cloudflare Workers, and change its instructions, model, pages, and limits.
navigation.title: Docs assistant
navigation.order: 4
icon: i-lucide-message-square-text
---

The docs assistant answers reader questions from your Markdown pages, and links the pages that it used. It is a ViteHub [Agent](/docs/agents) preset, `docsAssistant`, so you change it with `defineAgent()` like any other Agent.

By default it runs on your ChatGPT plan. You sign in once with your ChatGPT account, and you need no API key. On Node.js it runs Codex. A Cloudflare Worker cannot start Codex, so a Worker build gets the same Agent with a [model-backed Driver](/docs/connections/chatgpt#use-a-model-backed-driver) on the same plan. Read [Limits](#limits) before you put it on a public site.

## Turn it on

The assistant needs ViteHub Agents and [Connections](/docs/connections). On Node.js it also needs Codex in the app. A Worker build does not:

```bash [commands/install-assistant]
pnpm add vite-hub @vite-hub/agent @vite-hub/database drizzle-orm @openai/codex
```

Add `vite-hub/nuxt` to `modules`, and set `assistant: true`:

```ts [nuxt.config.ts]
export default defineNuxtConfig({
  modules: [
    ['vite-hub/nuxt', { preset: 'node', agent: true, connections: true, database: true }],
    '@vite-hub/docs/nuxt',
  ],
  docs: { assistant: true },
})
```

For Cloudflare Workers, set `preset: 'cloudflare'` instead of `'node'`.

Add the Agent. It answers from the pages in `content/`:

```ts [server/agents/docs/agent.ts]
import { docsAssistant } from '@vite-hub/docs/assistant'
import { defineAgent } from 'vite-hub/agent'

export default defineAgent({ extends: docsAssistant, workspace: {} })
```

`workspace: {}` says that this Agent owns the Workspace of the preset, the pages in `content/`. The build then bundles the pages, so the Agent reads them also on a host without a file system, such as a Worker.

Add the Connection. It holds the ChatGPT grant and lets the `docs` Agent use it:

```ts [server/connections/chatgpt.ts]
import { defineConnection } from 'vite-hub/connections'
import { chatgpt } from 'vite-hub/connections/chatgpt'

export default defineConnection({
  provider: chatgpt({ appName: 'Lumen docs', appVersion: '1.0.0' }),
  access: { 'agent:docs': { read: true } },
})
```

Connections keeps the grant in the app Database. When the app has only named Databases, choose one with `connections: { database: 'users' }`. Otherwise add a Database Definition if the app has none:

```ts [server/databases/config.ts]
import { defineDatabase } from 'vite-hub/database'

export default defineDatabase({ schema: {} })
```

The Agent and the Connection are files of your app, like every other Agent and Connection, so the ViteHub CLI and the Console show them. The Connection grants the Agent use of your ChatGPT plan, and that grant stays in your code. `docs.assistant` adds the panel and checks this setup.

Connections encrypts the grant with `VITEHUB_CONNECTIONS_KEY`. Set it to 32 random bytes in `.env`, and keep it across restarts:

```bash [commands/connections-key]
echo "VITEHUB_CONNECTIONS_KEY=$(openssl rand -hex 32)" >> .env
```

Start the app, then sign in once from the app folder:

```bash [commands/connect-chatgpt]
pnpm vitehub connections connect chatgpt --url http://localhost:3000
```

A deployed app needs its own grant. Set `connections: { management: true }`, which puts the Connections API behind the Console sign-in, and move the grant with [`vitehub connections export` and `import`](/docs/connections/chatgpt#move-the-grant-to-a-vm).

Every page now shows an **Ask** button at the bottom right. `⌘I` (`Ctrl+I` on Windows and Linux) opens and closes the panel, and `Esc` closes it. From `lg` up, the panel is a column beside the page: drag its left edge to change the width, and double-click the edge to reset it. The browser keeps the width in a cookie. On narrower screens the panel is a sheet over the page. The panel shows the conversation. When the grant is missing, it shows the sign-in command. When the plan limit is reached or the account is not eligible, it says so.

To open the panel from your own control, call `useDocsAssistant().toggle()`.

On Node.js without `@openai/codex` in the app, the panel shows `AGENT_R1026` with the install command.

## What the preset sets

| Part | Default | Change it with |
| --- | --- | --- |
| Driver | Codex on `chatgpt()`, through the `chatgpt` Connection. In a Worker build: `{ model: 'gpt-6.1-sol', gateway: chatgpt() }`. | `driver: { gateway, model }` |
| Instructions | Answer only from the pages, link each page used, and say when the docs do not cover a question | `driver: { instructions }`. Your text comes after these rules. |
| Pages | A read-only Workspace with `content/**/*.md` as the `pages` Source | `workspace: { sources: { pages: glob(...) } }` |
| Channel | `web`, a `webChat()` at `/api/_vitehub/agents/docs/chat` | `channels: { web: webChat(...) }` |
| Rate limit | 30 questions per hour for the whole site, in process memory | `docsRateLimit({ limit, window, identity })` |
| Budget | 2 answers at a time and 8 waiting. It records answers over 200,000 tokens. | `budget` |

Each request sends the path of the open page. The server accepts only a plain path, such as `/docs/guide/install`, and adds it to the instructions. So a vague question gets an answer about the open page.

## Customize

```ts [server/agents/docs.ts]
import { docsAssistant, docsRateLimit } from '@vite-hub/docs/assistant'
import { defineAgent } from 'vite-hub/agent'
import { openai } from 'vite-hub/gateways'
import { glob } from 'vite-hub/workspace'

export default defineAgent({
  extends: docsAssistant,
  driver: {
    // Your rules. The docs rules stay before them.
    instructions: 'Answer in the language of the question.',
    // An API key instead of the ChatGPT plan. Reads OPENAI_API_KEY. Remove the Connection file.
    gateway: openai(),
    model: 'gpt-5.1-mini',
  },
  capabilities: [
    // Replaces the default limit: 10 questions per hour for each client address behind your proxy.
    docsRateLimit({ limit: 10, identity: 'ip', trustedIpHeaders: ['x-forwarded-for'] }),
  ],
  // Pages in another folder, when `docs.dir` is not `content`
  workspace: { sources: { pages: glob({ cwd: 'docs', include: ['**/*.md'], keyCache: false }) } },
})
```

Child settings follow the [Agent merge rules](/docs/agents/agent-presets#extend-an-agent): Capabilities merge by id, Channels and Sources merge by key, and a `driver` key replaces the inherited value. Your own Capabilities join the default ones. `docsRateLimit()` has the id `docs-rate-limit`, so it replaces the default limit.

To use an Agent with another name, name its file, for example `server/agents/support.ts`, and set `docs: { assistant: { agent: 'support' } }`. Give that Agent access in the Connection: `'agent:support': { read: true }`.

## Check it without a browser

Send a question to the chat route. `page` is the path of the open page:

```bash [commands/ask]
curl -s -X POST http://localhost:3000/api/_vitehub/agents/docs/chat \
  -H 'content-type: application/json' \
  --data '{"id":"t1","page":"/docs/guide/install","messages":[{"id":"m1","role":"user","parts":[{"type":"text","text":"How do I install Lumen?"}]}]}'
```

The answer streams back. Without a ChatGPT grant, the stream has an error with `AGENT_R1016`. `pnpm vitehub connections inspect chatgpt` shows the grant.

## Limits

- **Worker builds.** The `workerd` and `worker` package conditions select the model-backed Driver. It reads the pages with the read-only Workspace shell (`ls`, `cat`, `rg`), which has no network. Pick its model from `vitehub connections models chatgpt` and set `driver: { model }`. An Agent that sets `codexDriver()` itself fails a Worker build with `AGENT_B0019`.
- **ChatGPT plan.** Connections work in Nuxt development and production builds. An API key gateway does not need Connections.
- **Plan use.** OpenAI allows plan usage for open-source projects, personal apps that run locally, and selected private apps. Paid apps and remotely hosted apps must join OpenAI's waitlist first. One host holds one grant. See [ChatGPT plan usage](/docs/connections/chatgpt).
- **Shell access on Node.js.** Codex reads the pages with shell commands in a temporary copy. Its sandbox blocks the network and writes outside that copy. But it can read other files that the server user can read, and a reader can ask for them. Run a public assistant as a user that can read only the app.
- **Rate limit.** The default limit is in process memory. It resets on restart and does not span processes. In a Worker, each isolate counts on its own. It counts questions for the whole site, so one reader can use the budget of the hour for everyone.
- **Budget.** Codex reports token use when an answer ends. The budget records an expensive answer in the Invocation. It does not stop it.
