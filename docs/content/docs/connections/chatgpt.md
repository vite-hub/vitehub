---
title: ChatGPT plan usage
description: Run a Codex Agent on a signed-in user's ChatGPT plan.
navigation.order: 7
icon: i-lucide-bot
---

Sign in once to run a Codex Agent on your ChatGPT Plus or Pro plan. Connections owns the OAuth grant, refresh tokens and account identity. The Agent receives a fresh access token through the runtime. Application code never reads it.

OpenAI makes plan usage available to open-source projects, personal apps that run locally, and selected private apps. Paid or remotely hosted apps must join [OpenAI's waitlist](https://developers.openai.com/siwc) first. ViteHub does not enforce eligibility. It never falls back to an API key or another gateway.

## Define the Connection and Agent

Enable `agent: true` and `connections: true` in `vitehub()`. Connections uses the app's database and its existing `VITEHUB_CONNECTIONS_KEY` encryption key. Keep both across restarts. See [Connections setup](/docs/connections/get-started).

```ts [server/connections/chatgpt.ts]
import { defineConnection } from 'vite-hub/connections'
import { chatgpt } from 'vite-hub/connections/chatgpt'

export default defineConnection({
  provider: chatgpt({ appName: 'My app', appVersion: '1.0.0' }),
  access: { 'agent:assistant': { read: true } },
})
```

```ts [server/agents/assistant.ts]
import { defineAgent } from 'vite-hub/agent'
import { chatgpt } from 'vite-hub/gateways'

export default defineAgent({
  driver: { kind: 'codex', gateway: chatgpt() },
})
```

`chatgpt()` selects the `chatgpt` Connection. Use `chatgpt({ connection: 'personal' })` for another named Connection. The provider requires an explicit access map. Give each saved account or workspace its own Connection name. A returning sign-in must match the account already bound to that Connection.

Library consumers can use `@vite-hub/connections/chatgpt` and `@vite-hub/gateways`. Gateways live in `vite-hub/gateways`, not `vite-hub/agent/gateways`.

## Sign in and inspect

Start the local app, then run from its directory:

```sh
pnpm vitehub connections connect chatgpt --url http://127.0.0.1:3000
pnpm vitehub connections inspect chatgpt --url http://127.0.0.1:3000
pnpm vitehub connections models chatgpt --url http://127.0.0.1:3000
```

The CLI opens the system browser and listens on `127.0.0.1`. If the browser does not open, use the printed URL. ViteHub validates state, PKCE, nonce and the ID token's signature, issuer, audience, expiry and account. It stores the issued `oaiapp_…` client ID and reuses it on later sign-ins. No client secret is needed.

Inspection shows the account email, granted and missing scopes, plan status, token expiry, client ID and host ID. It never prints access, refresh or ID tokens. The Console shows the same plan details and directs sign-in to the CLI. A website redirect cannot grant plan usage.

The model command requests the account's current model catalog and keeps `visibility == "list"`. Set `driver.model` to one of the returned IDs. Codex's bundled model catalog is not an entitlement check.

Sign out with:

```sh
pnpm vitehub connections revoke chatgpt --confirm chatgpt --url http://127.0.0.1:3000
```

Revocation sends the refresh token and client ID to OpenAI. It keeps the account registration and host ID for the next sign-in. A failed revocation leaves the grant available for retry and reports the failure.

## Move the grant to a VM

Follow [OpenAI's self-hosted VM flow](https://developers.openai.com/siwc/token-sharing-open-source/self-hosted-vms). Sign in on the laptop, then export an owner-only credential file:

```sh
pnpm vitehub connections export chatgpt --file ./chatgpt-grant.json --url http://127.0.0.1:3000
scp ./chatgpt-grant.json your-vm:/path/to/app/chatgpt-grant.json
```

On the VM, from its app directory:

```sh
pnpm vitehub connections import chatgpt --file ./chatgpt-grant.json --url http://127.0.0.1:3000
pnpm vitehub connections inspect chatgpt --url http://127.0.0.1:3000
rm ./chatgpt-grant.json
```

Delete the laptop's copy after import. Export removes the source token set before it returns the file. The laptop can no longer refresh or revoke that transferred grant. Import preserves the VM's host ID and rotates the refresh token. If export fails after removing the source grant, sign in again. Never give two running hosts the same rotating refresh token.

One Connections store identifies one host. Do not clone the whole database onto another host. Import only the transfer file into a separate store. Keep the VM's database and encryption key on persistent storage.

## Runtime behavior and limits

Use a local Codex Driver on a POSIX Node.js host. `driver.launch`, `providerSettings.launchArgs`, `binaryPath`, `homePath`, `shadowHomePath` and Agent `sandbox` are rejected with `AGENT_R1015`. They would let caller code replace the runtime-owned launch or receive its credentials. Install `@openai/codex` in the app; this gateway does not fall back to a command from `PATH`. The first-party Codex `auth.json` login is a separate credential flow.

ViteHub selects `openai_chatgpt_plan` and relays HTTP streaming to the public Responses endpoint. It sets Codex `clientInfo` from `appName` and `appVersion`. The ChatGPT token stays in runtime memory. An Invocation-owned loopback relay adds it to upstream requests; Codex receives only a temporary relay key through its private app-server input pipe. The relay and Capability bearer keys never enter process environments, launch arguments or generated launcher files. Both keys are redacted from protocol output and errors. The relay accepts only Responses and model discovery requests, redacts the token from responses, and closes on cancellation or cleanup. The grant never enters child environments, launch arguments or Codex credential files, including environments readable by same-user commands on Linux.

Codex's internal helper commands use the host executable search path. `driver.env.PATH`, toolchains and managed browser settings apply to command tools separately. Managed Chromium's library and font settings reach those tools without entering the credential-bearing process.

Each Invocation uses a fresh runtime-owned Codex Home, ignores inherited `CODEX_HOME`, and disables project configuration, inherited MCP servers and hooks. Only ViteHub supplies the Capability tool transport. The Home is removed after shutdown. Follow-up turns replay the supplied conversation history; native Codex session cursors and Home retention are not used for this gateway.

The gateway disables apps, plugins, image generation, computer/browser use, tool search, code mode and child agents. ViteHub Capability tools still run through Codex's local tool transport. They do not use hosted Responses MCP. The verified Codex version, `0.164.0`, sends `store: false`, `stream: true`, array input and developer instructions without the rejected Responses parameters. A different Codex version should pass the local integration test before use.

Connections refreshes when less than 15 minutes remain, subject to OpenAI's `earliest_refresh_at`. It serializes refreshes and stores the replacement access token, expiry and rotating refresh token together. Terminal refresh errors such as `refresh_token_reused` clear the unusable grant and require sign-in.

If a token expires during an Invocation, ViteHub stops Codex and reports `AGENT_R1024`. Review completed tool effects, then start another Invocation. ViteHub resolves a new token and replays the supplied conversation history when the caller continues the same thread. It does not replay the interrupted Invocation automatically. Transient inference failures get at most three HTTP attempts.

Model Drivers through the AI SDK are a follow-up. This Codex path cannot run in Cloudflare Workers. An AI SDK path needs its own runtime-owned credential transport, request restrictions and streaming error handling.

## Recovery

| Diagnostic | Recovery |
| --- | --- |
| `AGENT_R1024` | Token expired during a run. Review tool effects and start another Invocation. |
| `AGENT_R1016` | Check Connection access and plan scopes, then sign in if required. For `invalid_user`, check OpenAI status before replacing the grant. |
| `AGENT_R1017` | The usage limit was reached. Check [ChatGPT usage settings](https://chatgpt.com/settings/usage). |
| `AGENT_R1018` | Check the account's plan and app eligibility. |
| `AGENT_R1019` | Remove the unsupported capability. Use function/custom tools or supported web search. |
| `AGENT_R1020` | Usage is temporarily unavailable after bounded retries. Try later. |
| `AGENT_R1021` | A `chatpass_v2_*` or `subscription_sharing_route_not_supported` error means configuration, request route or app approval needs attention. |
| `AGENT_R1022` | Codex returned HTTP 403 without its provider error code. Check eligibility, registration, scopes and app approval. |
| `AGENT_R1023` | Codex returned an inference failure without its provider code. Check usage settings, OpenAI status, model and scopes before retrying. |

Codex 0.164.0 drops the provider body for HTTP 403 and the error code from `response.failed` events. ViteHub maps named errors when they survive the transport, reports `AGENT_R1022` when only HTTP 403 remains, and uses `AGENT_R1023` for an opaque failure. Exact recovery for these cases needs upstream Codex error preservation. ViteHub does not infer a missing code from prose or switch billing.

The OpenAI docs fetched on 2026-10-27 use Bearer authentication and do not require `ChatGPT-Account-Id`, including the current quickstart. ViteHub sends no such header. The Codex guide calls `clientInfo.name` a stable identifier, gives a slug example, and also says it must match `agent_name_hint`. ViteHub uses the same `appName` for both; the real Codex fake-server test verifies attribution. Acceptance by live OpenAI still needs a user sign-in.

The runnable repository check is in `playground/chatgpt/README.md`. Automated tests use local OAuth, JWKS and Responses servers and never register a real OpenAI client.
