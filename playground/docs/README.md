# Docs playground

A Nuxt 4 docs site for a made-up CLI, Lumen, on `@vite-hub/docs`, with the docs assistant and Console editing turned on. The app has no `app/` folder: the package renders every page. `server/agents/docs.ts` extends `docsAssistant` and adds one instruction. `server/connections/chatgpt.ts` holds the ChatGPT grant. `server/content.ts` lets the Console edit the pages. The pages are in `content/`.

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

## Edit pages in the Console

`server/content.ts` adds `docsCollection()` on the Blob + Database store of the CMS, and lets everyone edit on the development server. The store starts empty. With the dev server running, create the CMS tables once and import the pages:

```sh
corepack pnpm vitehub db generate
corepack pnpm vitehub db migrate
for file in $(cd content && find . -name '*.md' | sed 's|^\./||'); do
  corepack pnpm vitehub content edit docs "${file%.md}" --file "content/$file" --url http://127.0.0.1:4731
done
```

Open <http://127.0.0.1:4731/_vitehub/content>, open a page, and select **Preview the page**. An edit shows in the preview through the docs UI before it is saved. **Publish** copies the draft to the `published` ref. The site still renders the files in `content/`.

The `@vite-hub/*` packages are listed in `package.json` only because Nitro 2 leaves them external in this workspace, and Node resolves them from the app folder. `@nuxt/ui` is listed in `modules` so that Nuxt installs `@nuxt/icon` with it.

Stop the server with Ctrl+C and check that the port is free:

```sh
ss -ltn 'sport = :4731'
```
