# Docs assistant playground

A Nuxt 4 docs site for a made-up CLI, Lumen, with the `@vite-hub/docs` assistant turned on. `server/agents/docs.ts` extends `docsAssistant` and adds one instruction. `server/connections/chatgpt.ts` holds the ChatGPT grant. The pages are in `content/`.

The docs UI is ported separately, so `app/` renders only a page list, the page title, and `<DocsAssistant />`. Until that port lands, `@vite-hub/docs` has no `runtime/app/layouts/docs.vue`, and the module fails to start. Copy any layout to `packages/docs/dist/runtime/app/layouts/docs.vue` after the build to run this playground before then.

From the worktree root, build the packages, then start the app on port 4731:

```sh
HEAVY_WAIT=0 heavy ./node_modules/.bin/vp run --cache -t vite-hub#build
HEAVY_WAIT=0 heavy ./node_modules/.bin/vp run --cache -t @vite-hub/docs#build
cd playground/docs
node prepare.mjs
corepack pnpm dev
```

`prepare.mjs` writes an owner-only `.env` with `VITEHUB_CONNECTIONS_KEY` once. Keep it and `.data` across restarts.

Open <http://127.0.0.1:4731/docs/getting-started/install>, select **Ask** (or press `⌘I`), and ask "How do I install Lumen?". Without a ChatGPT grant, the panel shows **Connect ChatGPT** and the sign-in command. The same request from a terminal:

```sh
curl -s -X POST http://127.0.0.1:4731/api/_vitehub/agents/docs/chat \
  -H 'content-type: application/json' \
  --data '{"id":"t1","page":"/docs/getting-started/install","messages":[{"id":"m1","role":"user","parts":[{"type":"text","text":"How do I install Lumen?"}]}]}'
```

It answers HTTP 503 with `{"code":"PROVIDER_UNAVAILABLE","error":"AGENT_R1016: The ChatGPT Connection cannot provide plan access (sign-in)."}`.

Without `@openai/codex` in this app, the same request answers `AGENT_R1025` instead. To get answers, install `@openai/codex` in this app and sign in with `corepack pnpm vitehub connections connect chatgpt --url http://127.0.0.1:4731`, with your ChatGPT account. See `playground/chatgpt/README.md`. `corepack pnpm vitehub connections inspect chatgpt --url http://127.0.0.1:4731` shows the grant, and `corepack pnpm vitehub agent info --agent docs` inspects the Agent.

`server/databases/config.ts` is the Database Definition that stores the grant. `vite-hub/nuxt` needs one for Connections; the Vite plugin creates a default Database instead.

`@vite-hub/connections`, `gateways`, `runtime`, `shell`, and `source` are listed in `package.json` only because Nitro 2 leaves them external in this workspace, and Node resolves them from the app folder. `@nuxt/ui` is listed in `modules` so that Nuxt installs `@nuxt/icon` with it.

Stop the server with Ctrl+C and check that the port is free:

```sh
ss -ltn 'sport = :4731'
```
