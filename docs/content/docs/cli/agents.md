---
title: Agent commands
description: Talk to an Agent, run Agent Evals, inspect and cancel Invocations, and sync, export, or replay Channel conversations from the terminal.
navigation.order: 4
navigation.group: Commands
icon: i-lucide-bot
---

The Agent package adds the `agent`, `channels`, and `conversations` namespaces when `hubAgent()` is active.

## Run Agent Evals

Use `vitehub agent eval` to test what an Agent does, not only its types.
Evals need test-only dependencies, so install them before you write one.
An optional path runs only one eval file.

```bash [Terminal]
pnpm add -D @vite-hub/agent evalite vitest
```

```bash [Terminal]
pnpm vitehub agent eval
pnpm vitehub agent eval server/agents/support.eval.ts --threshold 90
pnpm vitehub agent eval --output .vitehub/evals/support.json --hide-table
pnpm vitehub agent eval --watch
pnpm vitehub agent eval --no-cache
```

`--watch` reruns affected evals on file changes. `--no-cache` skips cached model output. For slow evals, set `agent.eval.testTimeout` in the ViteHub options in `nuxt.config.ts` or `vite.config.ts`.

## Inspect an Agent Definition

Start the dev server, then print the resolved metadata of one Agent Definition.
The command does not run the Agent.

```bash [Terminal]
pnpm vitehub agent get --agent support
pnpm vitehub agent get --agent support --json
```

The output shows the Driver (the code that runs the Agent), its execution authority, tools, visible Workspace files and Sources, instructions, Invoker Profiles, warnings, and metadata status.
Execution authority is a snapshot of what the Agent can reach: filesystem, network, environment, credentials, processes, and isolation. `unknown` means the runtime or provider cannot prove that part during inspection. It does not mean restricted or denied. The snapshot describes the inspected context. It is not an enforcement decision or proof of safety.
`--json` gives the structured contract at `config.driver.executionAuthority`. Without `--url`, the command uses the dev server of this project. It never guesses a port.
With more than one Agent, `--agent` is required.
`agent get` reads from the guarded Agent Dev Loop endpoint of `hubAgent()`.

`agent get`, `agent dev`, and `channels replay` send a private token to this endpoint. The dev server stores the token with user-only permissions outside the served project, and the CLI reads it locally. The discovery request needs no token. It returns Agent names, aliases, trigger names, the server root, and the token server ID, but not the token. Without the token, the endpoint rejects Agent inspection, messages, Capability CLI calls, Workspace commands, and Channel replay, also on a server exposed with `--host`. Run these commands on the dev server's machine.

## Cancel an Agent Invocation

Start the Vite + Nitro dev server, then cancel one pending or running Agent Invocation by its journal id.

```bash [Terminal]
pnpm vitehub agent invocations cancel ainv_0123
pnpm vitehub agent invocations cancel ainv_0123 --json
```

```txt [Output]
ainv_0123 cancel requested, not enforced by run
```

`hubAgent()` adds a guarded `/__vitehub/agent/invocations/dev` endpoint to the dev server. It forwards the request into the Nitro dev environment, where the Agent Definitions and `invocations` journals are the same objects that run the app's Invocations. So the cancel reaches the running Invocation with any store, including `createMemoryAgentInvocationStore()`. The endpoint accepts only local hosts and same-origin requests. Without `--url`, the command uses the dev server of this project from `.vitehub/dev-server.json`, then `VITEHUB_DEV_SERVER_URL`, and fails with `AGENT_INVOCATIONS_NO_DEV_SERVER` when there is none. Use `--timeout` to change the timeout. An explicit `--url` that matches the discovered dev server also uses the guarded endpoint, even when Console invoke access is off.

Nuxt runs Nitro outside the Vite process, and plain Vite has no Nitro. There the endpoint returns `501`, and the command prints the reason and exits with status 1.

| Output | Meaning | Exit status |
| --- | --- | --- |
| `cancel requested` | A run in the Nitro runtime got an abort signal. Its final journal state shows whether it stopped. | 0 |
| `cancel request recorded; execution stop is unconfirmed` | The journal kept the request for a current or future owner. A crashed owner sees it only after execution recovery. | 0 |
| `cancel requested, not enforced by <driver>` | The Driver cannot enforce an abort. Delivery does not confirm that its owner got the request. | 0 |
| `already <status>` | The Invocation already finished. | 0 for `cancelled`; 1 for `completed` or `failed` |
| `not found` | The journal has no Invocation with this id. | 1 |

`--json` prints the `AgentInvocationCancelResult` from `invocations.cancel(id)`.

### Inspect and cancel on a deployed app

Pass the app URL with `--url` to list, show, follow, or cancel Invocations through its [Console](/docs/console). The Console must be on, and `cancel` also needs `invoke: true`, like the Console cancel button. The command does not load the project config, so a local config error cannot stop it.

```bash [Terminal]
export VITEHUB_CONSOLE_PRIVATE_KEY_CI='<private key>'
pnpm vitehub agent invocations list --url https://app.example.com --status running
pnpm vitehub agent invocations get ainv_0123 --url https://app.example.com
pnpm vitehub agent invocations tail ainv_0123 --url https://app.example.com
pnpm vitehub agent invocations cancel ainv_0123 --url https://app.example.com
pnpm vitehub agent invocations undo ainv_0123 --change chg_… --url https://app.example.com
```

`get` prints the changes an Agent made on a person's page through the [page Capability](/docs/agents/capabilities/page), with `--json` in `pageChanges` and `approvals`. `undo <id> --change <change>` asks that page, while it is open, to put one change back. It sends no value: the page restores its own record and keeps a value the person changed after the Agent. It exits 1 when the page could not put the value back.

Each command posts one birpc call to `/_vitehub/rpc` under the app URL, and [signs](/docs/console/signed-requests) it with the key in `VITEHUB_CONSOLE_PRIVATE_KEY_<NAME>`, a private key from `vitehub secret console-key`. The command signs as the key `<NAME>`. Set only one.

`--url` is the app URL, as in every `vitehub` command: `https://app.example.com`, or `http://localhost:3000` for a local production build or a dev server. Remote URLs must use HTTPS, without credentials, a query, or a fragment. The command does not follow redirects. A `401` or a redirect reports a refused signature.

`--url` is the app URL. A Console URL, such as `http://localhost:3000/_vitehub`, fails with the app URL to pass instead. Cancellation uses the guarded dev endpoint when the URL matches this project's dev server. A local production build still uses its Console.

The Console has no status filter, so `list --status` reads pages until it has `--limit` matches (default 50). `tail` asks only for observations after the last one it printed. Cancel outcomes and exit statuses are the same as in development.

## Talk to an Agent during development

Start the dev server, then attach the Agent Dev Loop from another terminal.

```bash [Terminal]
pnpm vitehub agent dev --agent support --url http://localhost:5173
```

Pass a message or `--prompt` for one invocation, or neither for an interactive session.

```bash [Terminal]
pnpm vitehub agent dev "/summary" --agent support
pnpm vitehub agent dev --agent support --prompt "/summary"
pnpm vitehub agent dev --agent support -p "/summary"
```

Use `--input` when the invocation needs event input that would normally come from a Channel, route, webhook, or app transport.
Pass the JSON object inline, or `@<file>` to read it from a file. The file can live anywhere in the app, but colocating it as `server/agents/<agent>/dev.payload.json` keeps local fixtures next to the Agent Definition without making them part of production behavior.
It must contain one JSON object shaped for the selected Agent Trigger.
For non-chat triggers, pass `--trigger` and shape the object for that trigger instead of Agent Invocation Context Values.

```json [server/agents/support/dev.payload.json]
{
  "user": {
    "id": "user_123",
    "name": "Local Developer"
  },
  "session": {
    "id": "local-support"
  },
  "meta": {
    "audience": "technical"
  }
}
```

```bash [Terminal]
pnpm vitehub agent dev --agent support --input @server/agents/support/dev.payload.json
pnpm vitehub agent dev --agent support --input @server/agents/support/dev.payload.json -p "/summary"
pnpm vitehub agent dev --agent support --input '{"user":{"id":"user_123"}}'
pnpm vitehub agent dev --agent support --timeout 180000 -p "/summary"
```

Use `--cli` when a Capability (a feature added to the Agent) declares its own CLI.
Everything after `--` is the Capability CLI command.
The Agent Dev Loop has these commands by default, also for provider-backed Agents. `defineAgent({ cli: { capabilities: false } })` hides them.
During Agent runs, ViteHub shows operation tool calls as command lines, such as `api listCustomers --query '{"status":"active"}'`, not as raw input objects.

```bash [Terminal]
pnpm vitehub agent dev --url http://localhost:3000 --agent support --cli inventory -- items list --json
```

The output shows the payload file path before the Agent Invocation starts.
In interactive mode, type a message or command such as `/summary`.

```txt [Output]
Loaded payload: /Users/acme/app/server/agents/support/dev.payload.json
Connected to support at http://localhost:5173
> /summary
```

Start input with `!` to run a shell command in the Agent's Workspace (its file system).
The Agent must declare a writable Workspace.
ViteHub runs the command in a Workspace Session and commits successful changes to the Workspace Store.

```bash [Terminal]
pnpm vitehub agent dev --agent support "!pnpm test"
pnpm vitehub agent dev --url http://localhost:5173 --timeout 180000 support !pnpm test --filter api
```

Put Agent Dev Loop options before the `!` command. Flags after `!` go to the Workspace command.
In interactive mode, `!` input skips the Agent for that turn.
Use normal messages for the Agent, `!` for Workspace shell work, and `--cli` for Capability commands.

```txt [Output]
Connected to support at http://localhost:5173
> !pnpm test
```

## Synchronize Channel webhooks

Deploy the stage before you register its Channel webhooks. `channels sync` loads the Agent Definitions for the Vite stage, checks that every webhook route is live at the exact public HTTPS origin, and compares the provider state. Telegram is the first supported provider.

The command only reads by default. Use `--json` to get a sanitized plan to review.

```bash [Terminal]
pnpm vitehub channels sync \
  --stage staging \
  --url https://staging.example.com \
  --json
```

Without `--url`, the command uses `vitehub({ publicUrl })` when it is one string. `--stage staging` loads stage env files such as `.env.staging`, and process environment values win. Keep the Telegram bot token and webhook secret in Server Env. The command takes no credential flags and never prints credentials.

To apply the plan, repeat the exact origin in `--confirm-origin`. This works without prompts, so developers, CI, and agents never pick a deployment by accident. The configured `publicUrl` needs no confirmation, but a `--confirm-origin` you add must match it.

```bash [Terminal]
pnpm vitehub channels sync \
  --stage staging \
  --url https://staging.example.com \
  --apply \
  --confirm-origin https://staging.example.com
```

`--agent <name>` or `--channel <id>` narrows an app with many Agents. Switching a Telegram Channel to polling, or setting `webhooks: false`, plans to remove its webhook. Applying that also needs `--allow-delete`, and the current provider URL must belong to the confirmed origin. ViteHub keeps pending updates during registration and removal.

Telegram's `getWebhookInfo` returns the URL and delivery errors, but not the secret token or allowed update list, so the plan marks those as unverifiable. Use `--force` to reapply them when the URL matches but credentials or subscriptions changed. Telegram accepts ports 443, 80, 88, and 8443. The CLI rejects other explicit ports before it applies.

`channels sync` only registers the webhook. The Telegram synchronizer subscribes to message updates, the one inbound event the built-in Channel supports. Admission rules, allowed users, secrets, and other update types stay in the app. An app that needs a custom adapter, certificate, fixed IP, or connection policy must manage the provider itself. An app-owned `adapter` is not synced.

## Export a Channel conversation

When the app has the Channel operations, `vitehub channels list` lists Channels and their retention, `channels threads` lists a Channel's threads, and `channels conversation` reads one thread's messages in order. `vitehub channels status <agent> <channel>` shows sync health and skipped messages of a [Gmail Channel](/docs/agents/gmail#failed-messages). `vitehub channels deliveries <agent> <channel>` lists the newest messages a Channel received, with the run each one reached or [why it started none](/docs/agents/channels#why-a-message-started-no-work).

`conversations export` calls the `conversations.export` [operation](/docs/console/operations) on the dev server, or on the app at `--url` with the credentials of [Run any operation](/docs/cli/inspect#run-any-operation). It needs no webhook secret, only Console access to the `channels` section.

```bash [Terminal]
pnpm vitehub conversations export support telegram telegram:456 > chat.md
pnpm vitehub conversations export support telegram telegram:456 --format json --output ./chat --url https://app.example.com
```

Without `--output`, the text goes to stdout without attachments, and a retention warning goes to stderr. With `--output`, the directory must not exist. It gets the file (`history.json` or `<thread>.md`) and attachments in `media/`. `--media` and `--no-media` override the default. See [See and export a conversation](/docs/agents/channels#see-and-export-a-conversation).

## Download Channel history

`channels history` loads the stage's Agent and Channel configuration and calls the deployed webhook route with its webhook secret. Adapter-backed Channels use the Chat SDK export. A Channel with `history` exports its Collection items, takes repeatable `--query key=value` and optional `--thread`, and pages to the end. `--invocations` joins kept Invocations and recorded deliveries to each item.

The join uses `vitehub.channel.key` annotations first. For older Invocations, a Channel can give `history.invocationItem(invocation)`, which returns a history item or `undefined`, and the exporter calls `history.key()` and optional `history.thread()` on it. The journal keeps observations and run annotations, but not raw webhook input or trusted `input.context`, so recover only identities the kept data supports. A missing item, invalid key, or throwing hook leaves the Invocation unjoined. The exporter scans the journal once per Collection page. It never runs the Channel trigger or changes journal records.

```bash [Terminal]
pnpm vitehub channels history \
  --stage production \
  --url https://app.example.com \
  --agent calories \
  --channel telegram \
  --output ./channel-history
```

`--url` defaults to `vitehub({ publicUrl })` when it is one string. A Telegram direct-message Channel finds its thread when the adapter allows exactly one user. Pass `--thread <provider-thread-id>` for groups and for adapters where one Channel serves many conversations, issues, or tickets. When a Channel declares several webhook registrations, pick the route and its authentication with `--webhook <id>`.

`--webhook-path <path>` exports through another path on the confirmed origin, with the selected registration's authentication. Use it to reach the built-in route on an older deployment that does not serve a declared `webhooks.path` yet.

A custom Channel export holds the items of its history Collection. With `--invocations`, each item has `invocations` with `id`, `status`, `createdAt`, `updatedAt`, `dryRun`, `label`, `deliveries: [{ channel, text }]`, and optional final `text`. Delivery text is the validated reply before app formatting, including dry-run writes. To keep it, you need Invocation content storage or `metadataContent` with `channel.effect.content`.

A Chat SDK export holds only history the adapter or its State Adapter can give. Telegram's Bot API cannot backfill old messages, so it uses the `threadHistory` window: 100 messages kept for seven days by default. For a recovery archive, export before that window ends.

## Replay Channel history

`vitehub channels replay --agent support --channel mailbox --dry-run --label round-one --query folder=inbox` records each run with `triggeredBy: 'round-one'` and `vitehub.channel.key`. Repeat `--query key=value` for several values, as with `--filter`. Labels are not part of the history query. They must be non-empty, at most 512 characters. For a query field named `label`, use `--query label=value`.

Replay uses the development project token when `--url` is omitted or matches this project's dev server. For any other app URL, including a local production build, replay calls `channels.replay` over Console RPC, one page per call. This path needs Console authentication, and the Agent must allow Console invocation. Replay checks saved items through the Channel trigger, without rechecking old provider signatures. Public webhooks still verify signatures. In `vite dev`, replay uses the host's Console journal, so local dry runs need no Invocation setup in the app.
