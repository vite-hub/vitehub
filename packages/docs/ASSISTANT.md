## Docs assistant

The docs assistant answers reader questions from your Markdown pages and links the pages it used. It is a ViteHub Agent, so you change it with `defineAgent()` like any other Agent.

By default it runs Codex on your ChatGPT plan. You sign in once with your ChatGPT account. No API key is needed.

### Turn it on

The assistant needs ViteHub Agents and Connections, and Codex in the app:

```sh
pnpm add vite-hub @openai/codex
```

```ts [nuxt.config.ts]
export default defineNuxtConfig({
  modules: [
    ['vite-hub/nuxt', { preset: 'node', agent: true, connections: true, database: true }],
    '@vite-hub/docs/nuxt',
  ],
  docs: { assistant: true },
})
```

Add two files. The Agent answers from the pages in `content/`:

```ts [server/agents/docs.ts]
import { docsAssistant } from '@vite-hub/docs/assistant'
import { defineAgent } from 'vite-hub/agent'

export default defineAgent({ extends: docsAssistant })
```

The Connection holds the ChatGPT grant and lets the `docs` Agent use it:

```ts [server/connections/chatgpt.ts]
import { defineConnection } from 'vite-hub/connections'
import { chatgpt } from 'vite-hub/connections/chatgpt'

export default defineConnection({
  provider: chatgpt({ appName: 'My docs', appVersion: '1.0.0' }),
  access: { 'agent:docs': { read: true } },
})
```

Connections encrypts the grant with `VITEHUB_CONNECTIONS_KEY`. Set it to 32 random bytes in `.env` and keep it across restarts. Start the app, then sign in once from the app folder:

```sh
pnpm vitehub connections connect chatgpt --url http://localhost:3000
```

`DocsAssistant` shows an **Ask** button at the bottom right of every page (`⌘I` opens it). It opens a panel with the conversation. When the grant is missing, the panel shows the sign-in command. When the plan limit is reached or the account is not eligible, it says so. `useDocsAssistant().toggle()` opens the panel from any other control.

### What the preset sets

| Part | Default | Change it with |
| --- | --- | --- |
| Driver | Codex on `chatgpt()`, the `chatgpt` Connection | `driver: { gateway, model }` |
| Instructions | Answer only from the pages, link each page used, say when the docs do not cover a question | `driver: { instructions }` fills the slot after these rules |
| Pages | Read-only Workspace with `content/**/*.md` as the `pages` Source | `workspace: { sources: { pages: glob(...) } }` |
| Channel | `web`, a `webChat()` at `/api/_vitehub/agents/docs/chat` | `channels: { web: webChat(...) }` |
| Rate limit | 30 questions per hour for the whole site, in process memory | `docsRateLimit({ limit, window, identity })` |
| Budget | 2 answers at a time, 8 waiting; records answers over 200,000 tokens | `budget` |

Each request sends the path of the open page. The server accepts only a plain path, such as `/docs/guide/setup`, and adds it to the instructions, so a vague question gets an answer about that page.

### Customize

```ts [server/agents/docs.ts]
import { docsAssistant, docsRateLimit } from '@vite-hub/docs/assistant'
import { defineAgent } from 'vite-hub/agent'
import { openai } from 'vite-hub/gateways'
import { glob } from 'vite-hub/workspace'
import { searchIssues } from '../capabilities/issues'

export default defineAgent({
  extends: docsAssistant,
  driver: {
    // Your rules. The docs rules stay before them.
    instructions: 'Answer in the language of the question. Link the GitHub issue when a page names one.',
    // An API key instead of the ChatGPT plan. Reads OPENAI_API_KEY. Remove the Connection file.
    gateway: openai(),
    model: 'gpt-5.1-mini',
  },
  capabilities: [
    // Your Capabilities join the default ones.
    searchIssues(),
    // Replaces the default limit: 10 questions per hour for each client address behind your proxy.
    docsRateLimit({ limit: 10, identity: 'ip', trustedIpHeaders: ['x-forwarded-for'] }),
  ],
  // Pages in another folder.
  workspace: { sources: { pages: glob({ cwd: 'docs', include: ['**/*.md'], keyCache: false }) } },
})
```

Child settings follow the normal [Agent merge rules](https://vitehub.dev/docs/agents/agent-presets#extend-an-agent): Capabilities merge by id, Channels and Sources by key, and a `driver` key replaces the inherited value. Name the Agent file something other than `docs.ts` and set `docs: { assistant: { agent: 'support' } }` to use another Agent.

### Hosts and limits

- **Node.js only.** Codex runs as a local process. A production build for Cloudflare Workers or another non-Node Nitro preset fails with a `[@vite-hub/docs]` error while `docs.assistant` is on. Turn it off for that build, for example `assistant: process.env.NITRO_PRESET !== 'cloudflare-module'`. The development server always runs on Node.
- **Nuxt development server only, with the ChatGPT plan.** `vite-hub/nuxt` does not support Connections in production builds yet (`VITE_HUB_B0012`). An API key gateway does not need Connections.
- **Plan use.** OpenAI allows plan usage for open-source projects, personal apps that run locally, and selected private apps. Paid or remotely hosted apps must join OpenAI's waitlist first. One host holds one grant. See [ChatGPT plan usage](https://vitehub.dev/docs/connections/chatgpt).
- **Shell access.** Codex reads the pages with shell commands in a temporary copy. Its sandbox blocks network and writes outside that copy, but it can read other files that the server user can read. A reader can ask for them. Run a public assistant as a user that can read only the app.
- **Rate limit.** The default limit lives in process memory. It resets on restart and does not span processes. It counts questions for the whole site, so one reader can use the hour's budget for everyone.
- **Budget.** Codex reports token use when an answer ends. The budget records an expensive answer in the Invocation; it does not stop one.
