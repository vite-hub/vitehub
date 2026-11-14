---
title: ChatGPT plan usage
description: Run an Agent on a signed-in user's ChatGPT plan, with Codex on Node.js or with a model-backed Driver on any host.
navigation.order: 8
icon: i-lucide-bot
---

Sign in once to run an Agent on your ChatGPT Plus or Pro plan. Connections keeps the OAuth grant, refresh tokens, and account. The Agent gets a fresh access token that your code never reads.

OpenAI allows plan usage for open-source projects, local personal apps, and some private apps. Paid or remotely hosted apps must join [OpenAI's waitlist](https://developers.openai.com/siwc) first. ViteHub does not check eligibility and never falls back to an API key or another gateway.

## Define the Connection and Agent

Set `agent: true` and `connections: true` in `vitehub()`. Connections uses the app's database and `VITEHUB_CONNECTIONS_KEY`, which must both survive restarts. See [Connections setup](/docs/connections/get-started).

```ts [server/connections/chatgpt.ts]
import { defineConnection } from 'vite-hub/connections'
import { chatgpt } from 'vite-hub/connections/chatgpt'

export default defineConnection({
  provider: chatgpt({ appName: 'My app', appVersion: '1.0.0' }),
  access: { 'agent:assistant': { read: true } },
})
```

```ts [server/agents/assistant.ts]
import { codexDriver, defineAgent } from 'vite-hub/agent'
import { chatgpt } from 'vite-hub/gateways'

export default defineAgent({
  driver: codexDriver({ gateway: chatgpt() }),
})
```

Install Codex in the app. The gateway runs this package, never a `codex` command from `PATH`. `vitehub connections connect` and `inspect` warn when it is missing:

```sh
pnpm add @openai/codex
```

### Use a model-backed Driver

A model-backed Driver uses the same grant without Codex. ViteHub calls the Responses API over HTTP, so the Agent also runs on Cloudflare Workers and other hosts without Node.js:

```ts [server/agents/assistant.ts]
import { defineAgent } from 'vite-hub/agent'
import { chatgpt } from 'vite-hub/gateways'

export default defineAgent({
  driver: { model: 'gpt-5.5', gateway: chatgpt() },
})
```

`model` is an ID from `vitehub connections models chatgpt`. Tools, Workspace, and Capabilities work as usual, without `@openai/codex`.

`chatgpt()` uses the `chatgpt` Connection, and `chatgpt({ connection: 'personal' })` another one. The provider needs an explicit access map. Give each account or workspace its own Connection name. A later sign-in must match the linked account.

Libraries can use `@vite-hub/connections/chatgpt` and `@vite-hub/gateways`. [AI Gateways](/docs/gateways) live in `vite-hub/gateways`, not `vite-hub/agent/gateways`.

## Sign in and inspect

Start the local app, then run this in its folder:

```sh
pnpm vitehub connections connect chatgpt
pnpm vitehub connections inspect chatgpt
pnpm vitehub connections models chatgpt
```

The CLI finds the project's dev server. For another app, pass `--url`, such as `--url http://127.0.0.1:3000`.

The CLI opens the browser and listens on `127.0.0.1`. If no browser opens, use the printed URL. ViteHub checks state, PKCE, nonce, and the ID token's signature, issuer, audience, expiry, and account. It keeps the `oaiapp_…` client ID for later sign-ins. No client secret is needed.

The link works once, for 10 minutes, and the CLI waits until it expires.

### Sign in on a server without a browser

The browser returns to `127.0.0.1` on its own computer. For an app on a server, pick a port with `--port` and forward it from the browser's computer:

```sh
# On the server
pnpm vitehub connections connect chatgpt --port 4799

# On the computer with the browser
ssh -N -L 4799:127.0.0.1:4799 user@server
```

Open the printed URL in that browser. If only the server can reach the laptop, run `ssh -N -R 4799:127.0.0.1:4799 user@laptop` on the server. Over SSH, or with no browser, the CLI prints the port to forward.

Inspection shows the email, granted and missing scopes, plan status, token expiry, client ID, and host ID, never tokens. Sign-in uses the CLI, because a website redirect cannot grant plan usage.

`models` fetches the account's models with `visibility == "list"`. Set `driver.model` to one of them. Codex's built-in list does not prove access.

Sign out with:

```sh
pnpm vitehub connections revoke chatgpt --confirm chatgpt
```

Sign-out sends the refresh token and client ID to OpenAI, and keeps the registration and host ID for the next sign-in. A failed sign-out reports the error and keeps the grant for a retry.

## Move the grant to a VM

Follow [OpenAI's self-hosted VM flow](https://developers.openai.com/siwc/token-sharing-open-source/self-hosted-vms). Sign in on the laptop, then export a credential file that only you can read:

```sh
pnpm vitehub connections export chatgpt --file ./chatgpt-grant.json --url http://127.0.0.1:3000
scp ./chatgpt-grant.json your-vm:/path/to/app/chatgpt-grant.json
```

On the VM, in its app folder:

```sh
pnpm vitehub connections import chatgpt --file ./chatgpt-grant.json --url http://127.0.0.1:3000
pnpm vitehub connections inspect chatgpt --url http://127.0.0.1:3000
rm ./chatgpt-grant.json
```

Delete the file on the laptop after import. Export removes the laptop's tokens first, so the laptop can no longer refresh or revoke the grant. If export then fails, sign in again. Import keeps the VM's host ID and rotates the refresh token. Never give two running hosts one refresh token.

One Connections store is one host. Never copy the whole database to another host; import only the transfer file into a separate store. Keep the VM's database and encryption key on persistent storage.

## Runtime behavior and limits

### Model-backed Driver

Each model call gets a fresh grant through the Connection and sends one `POST /v1/responses` request:

- The token goes only in the `Authorization` header, never to the AI SDK or the app, and is hidden in error bodies.
- The request always has `store: false` and `stream: true`.
- Fields that plan usage rejects, such as `temperature`, `max_output_tokens`, and `previous_response_id`, are removed. History goes in `input`, and instructions as a developer message.
- Encrypted reasoning keeps the reasoning across a tool loop without stored responses.
- A hosted tool that plan usage rejects, such as image generation or file search, fails with `AGENT_R1019`.
- `appName` goes in the `originator` header, like Codex.

Plan usage accepts only streams, so a generate call reads the stream into one result. Provider errors map to the codes in [Recovery](#recovery). The Connection runs where the app runs, so a Worker needs its own grant; see [Move the grant to a VM](#move-the-grant-to-a-vm).

### Codex Driver

Use a local Codex Driver on a POSIX Node.js host. `driver.launch`, `providerSettings.launchArgs`, `binaryPath`, `homePath`, `shadowHomePath`, and Agent `sandbox` fail with `AGENT_R1015`, because they would let your code replace the launch or get its credentials. Without `@openai/codex` in the app, an Invocation (one Agent run) fails with `AGENT_R1026`. Codex's own `auth.json` login is a separate flow.

ViteHub selects `openai_chatgpt_plan`, relays HTTP streams to the public Responses endpoint, and sets Codex `clientInfo` from `appName` and `appVersion`. The token stays in runtime memory:

- A local relay owned by the Invocation adds the token to upstream requests. Codex gets only a temporary relay key through its private input pipe.
- The relay and Capability keys never enter process environments, launch arguments, or launcher files, and are hidden in output and errors.
- The relay accepts only Responses and model list requests, hides the token in responses, and closes on cancel or cleanup.
- The grant never enters child environments, launch arguments, or Codex credential files, so other commands of the same Linux user cannot read it.

Codex's helper commands use the host `PATH`. `driver.env.PATH`, toolchains, and managed browser settings apply only to command tools. Managed Chromium's library and font settings reach those tools, not the process with the credential.

Each Invocation gets a new Codex Home, ignores `CODEX_HOME`, and turns off project config, inherited MCP servers, and hooks. Only ViteHub supplies the Capability tool transport. The Home is deleted after shutdown. Follow-up turns replay the history, not Codex session cursors.

The gateway turns off apps, plugins, image generation, computer and browser use, tool search, code mode, and child agents. ViteHub Capability tools still run through Codex's local tool transport, not hosted Responses MCP. The tested Codex `0.164.0` sends `store: false`, `stream: true`, array input, and developer instructions without rejected parameters. Run the local integration test before you use another version.

Connections refreshes when less than 15 minutes remain, but not before OpenAI's `earliest_refresh_at`. It runs one refresh at a time and stores the new access token, expiry, and refresh token together. A final error, such as `refresh_token_reused`, clears the grant until you sign in again.

If a token expires during an Invocation, ViteHub stops Codex and reports `AGENT_R1024`. Check what the tools did, then start another Invocation. A continued thread gets a new token and replays the history. The stopped Invocation never replays by itself. Temporary inference failures get up to three HTTP attempts.

Codex cannot run in Cloudflare Workers. Use a [model-backed Driver](#use-a-model-backed-driver) there.

## Recovery

| Diagnostic | Recovery |
| --- | --- |
| `AGENT_R1024` | Token expired during a run. Check tool effects and start another Invocation. |
| `AGENT_R1016` | Check Connection access and plan scopes, then sign in if needed. For `invalid_user`, check OpenAI status before you replace the grant. |
| `AGENT_R1017` | Usage limit reached. Check [ChatGPT usage settings](https://chatgpt.com/settings/usage). |
| `AGENT_R1018` | Check the plan and app eligibility. |
| `AGENT_R1019` | Remove the unsupported capability. Use function or custom tools, or supported web search. |
| `AGENT_R1020` | Usage is down for now after limited retries. Try later. |
| `AGENT_R1021` | A `chatpass_v2_*` or `subscription_sharing_route_not_supported` error. Check config, request route, or app approval. |
| `AGENT_R1022` | Codex returned HTTP 403 without a provider code. Check eligibility, registration, scopes, and app approval. |
| `AGENT_R1023` | Codex returned an inference failure without a provider code. Check usage settings, OpenAI status, model, and scopes, then retry. |
| `AGENT_R1026` | The app cannot resolve `@openai/codex`. Install it in the app and restart the server. |

Codex 0.164.0 drops the body of an HTTP 403 and the code of `response.failed` events. ViteHub maps named errors that get through, and reports `AGENT_R1022` for a bare 403 and `AGENT_R1023` for an unknown failure. Exact recovery needs Codex to keep these errors. ViteHub never guesses a code from error text or switches billing.

The OpenAI docs of 2026-10-27, including the quickstart, use Bearer auth and do not require `ChatGPT-Account-Id`, so ViteHub sends no such header. The Codex guide calls `clientInfo.name` a stable identifier, shows a slug, and says it must match `agent_name_hint`. ViteHub uses `appName` for both, checked by a test of real Codex against a fake server. A live OpenAI check still needs a user sign-in.

Run the repository check from `playground/chatgpt/README.md`. Automated tests use local OAuth, JWKS, and Responses servers, never a real OpenAI client.
