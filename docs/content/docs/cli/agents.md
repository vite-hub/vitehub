---
title: Agent commands
description: Run Agent Evals, inspect an Agent Definition, talk to an Agent, and list or cancel Agent Invocations locally or on a deployed app.
navigation.title: Agents
navigation.order: 10
navigation.group: Commands
icon: i-lucide-bot
---

The Agent package adds the `agent` namespace when `hubAgent()` is active. Channel commands are in [Channel commands](/docs/cli/channels).

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
pnpm vitehub agent info --agent support
pnpm vitehub agent info --agent support --json
```

The output shows the Driver (the code that runs the Agent), its execution authority, tools, visible Workspace files and Sources, instructions, Invoker Profiles, warnings, and metadata status.
Execution authority is a snapshot of what the Agent can reach: filesystem, network, environment, credentials, processes, and isolation. `unknown` means the runtime or provider cannot prove that part during inspection. It does not mean restricted or denied. The snapshot describes the inspected context. It is not an enforcement decision or proof of safety.
`--json` gives the structured contract at `config.driver.executionAuthority`. Use `--url` when Vite is not on `http://localhost:5173`.
With more than one Agent, `--agent` is required.
`agent info` reads from the guarded Agent Dev Loop endpoint of `hubAgent()`.

`agent info`, `agent dev`, and `channels replay` send a private token to this endpoint. The dev server stores the token with user-only permissions outside the served project, and the CLI reads it locally. The discovery request needs no token. It returns Agent names, aliases, trigger names, the server root, and the token server ID, but not the token. Without the token, the endpoint rejects Agent inspection, messages, Capability CLI calls, Workspace commands, and Channel replay, also on a server exposed with `--host`. Run these commands on the dev server's machine.

## Cancel an Agent Invocation

Start the Vite + Nitro dev server, then cancel one pending or running Agent Invocation by its journal id.

```bash [Terminal]
pnpm vitehub agent invocations cancel ainv_0123
pnpm vitehub agent invocations cancel ainv_0123 --json
```

```txt [Output]
ainv_0123 cancel requested, not enforced by run
```

`hubAgent()` adds a guarded `/__vitehub/agent/invocations/dev` endpoint to the dev server. It forwards the request into the Nitro dev environment, where the Agent Definitions and `invocations` journals are the same objects that run the app's Invocations. So the cancel reaches the running Invocation with any store, including `createMemoryAgentInvocationStore()`. The endpoint accepts only local hosts and same-origin requests. Use `--server` or `VITEHUB_DEV_SERVER_URL` when Vite is not on `http://localhost:5173`, and `--timeout` to change the timeout. With `--url`, the command cancels through the app's Console instead.

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
pnpm vitehub agent invocations show ainv_0123 --url https://app.example.com
pnpm vitehub agent invocations tail ainv_0123 --url https://app.example.com
pnpm vitehub agent invocations cancel ainv_0123 --url https://app.example.com
pnpm vitehub agent invocations undo ainv_0123 --change chg_… --url https://app.example.com
```

`show` prints the changes an Agent made on a person's page through the [page Capability](/docs/agents/capabilities/page), with `--json` in `pageChanges` and `approvals`. `undo <id> --change <change>` asks that page, while it is open, to put one change back. It sends no value: the page restores its own record and keeps a value the person changed after the Agent. It exits 1 when the page could not put the value back.

The command signs its calls as [Call a deployed app](/docs/cli/operations#call-a-deployed-app) describes: one birpc call per command, signed with the key in `VITEHUB_CONSOLE_PRIVATE_KEY_<NAME>`.

Two old forms still work until the next minor version, and print `AGENT_R1053`: a Console URL, such as `http://localhost:3000/_vitehub`, and a localhost URL with no Console, which the command reads as a local invocation endpoint, or as the dev server for `cancel`. Pass the app URL instead, or `--server` for the dev server.

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

