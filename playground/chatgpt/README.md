# ChatGPT plan playground

This playground discovers one Connection and one Codex Agent through ViteHub. It needs Node.js 24.15 or newer, pnpm, Codex on PATH, and your own eligible ChatGPT account. The local proof used Codex 0.164.0. No API key or `codex login` is needed.

OpenAI plan usage is available to open-source projects, personal local apps and selected private apps. Paid or remotely hosted apps must join [OpenAI's waitlist](https://developers.openai.com/siwc) first.

From this worktree's root, build the distribution and its dependencies:

```sh
HEAVY_WAIT=0 heavy corepack pnpm exec vp run --cache -t vite-hub#build
cd playground/chatgpt
node prepare.mjs
corepack pnpm dev
```

`prepare.mjs` creates an owner-only `.env.local` encryption key once, without printing it. Preserve that file and the app's `.data` directory across restarts. Do not commit them. Vite listens only on `127.0.0.1:1456`.

In a second terminal, from `playground/chatgpt`:

```sh
corepack pnpm vitehub connections connect chatgpt --url http://127.0.0.1:1456
corepack pnpm vitehub connections inspect chatgpt --url http://127.0.0.1:1456
corepack pnpm vitehub connections models chatgpt --url http://127.0.0.1:1456
corepack pnpm vitehub agent dev --agent assistant --url http://127.0.0.1:1456 --prompt 'Say exactly: Hello from my ChatGPT plan.'
```

The first command opens the browser. Choose your ChatGPT account and allow plan usage, then return to the terminal. Inspection should show your email, `plan: enabled`, the `chatgpt.tokens.use.direct` scope, expiry, an `oaiapp_…` client ID and a `urn:uuid:…` host ID. It must show no tokens. The model command lists visible model IDs. The Agent should return the requested greeting.

The Agent defaults to `gpt-6.1-sol`, as in OpenAI's current SIWC example. If that ID is absent from your catalog, stop the server and restart it with `CHATGPT_MODEL=<listed-id> corepack pnpm dev`. A rejected model or plan grant fails explicitly; it cannot fall back to API billing.

Run `connections connect` again and inspect. The client and host IDs should remain the same. To check a full sign-out and returning sign-in:

```sh
corepack pnpm vitehub connections revoke chatgpt --confirm chatgpt --url http://127.0.0.1:1456
corepack pnpm vitehub connections connect chatgpt --url http://127.0.0.1:1456
corepack pnpm vitehub connections inspect chatgpt --url http://127.0.0.1:1456
```

For VM transfer, follow the [Connections guide](../../docs/content/docs/connections/chatgpt.md#move-the-grant-to-a-vm). Export moves refresh ownership off the laptop; import keeps the VM's host ID. This live transfer and OpenAI's dynamic registration still need Maxi's account to verify.

Stop the server with Ctrl+C. Confirm its port is free:

```sh
ss -ltn 'sport = :1456'
```

## Local proof without an OpenAI account

From the worktree root:

```sh
HEAVY_WAIT=0 heavy corepack pnpm exec vp run --cache -t @vite-hub/agent#build
HEAVY_WAIT=0 VITEHUB_TEST_REAL_CODEX=1 heavy --light corepack pnpm --dir packages/agent exec vp test test/chatgpt-codex.test.ts
```

Install `@openai/codex@0.164.0` in the app first. The gateway resolves the installed package and rejects a caller-supplied executable. This runs real Codex against a loopback OAuth, JWKS and Responses fake. It exercises a ViteHub Capability, a shell environment dump, HTTP errors, bounded retries and token expiry. It uses an isolated Codex Home, closes its listeners and never calls real OpenAI authentication. Without `VITEHUB_TEST_REAL_CODEX`, these integration tests are skipped.
