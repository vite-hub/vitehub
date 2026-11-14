---
title: Agent commands
description: Run Agent Evals, inspect an Agent Definition, talk to an Agent, and list or cancel Agent Invocations locally or on a deployed app.
navigation.title: Agents
navigation.order: 10
navigation.group: Commands
icon: i-lucide-bot
---

The `agent` commands let you test an Agent, see what it can reach, talk to it while you build it, and stop a run that went wrong. `hubAgent()` adds them. [Channel commands](/docs/cli/channels) cover Channels.

## Run Agent Evals

`vitehub agent eval` tests what an Agent does, not only its types. Install the test-only dependencies first.

```bash [Terminal]
pnpm add -D @vite-hub/agent evalite vitest
pnpm vitehub agent eval
pnpm vitehub agent eval server/agents/support.eval.ts --threshold 90
pnpm vitehub agent eval --output .vitehub/evals/support.json --hide-table
pnpm vitehub agent eval --watch
pnpm vitehub agent eval --no-cache
```

A path runs one eval file. `--watch` reruns the affected evals when files change, and `--no-cache` skips cached model output. For slow evals, raise `agent.eval.testTimeout` in the ViteHub options.

## Inspect an Agent Definition

`agent info` prints what one Agent resolves to on the running dev server, without running it.

```bash [Terminal]
pnpm vitehub agent info --agent support
pnpm vitehub agent info --agent support --json
```

The output shows the Driver (the code that runs the Agent), its execution authority, tools, visible Workspace files and Sources, instructions, Invoker Profiles, warnings, and metadata status. `--agent` is required when the app has more than one Agent, and `--url` points at Vite when it is not on `http://localhost:5173`.

**Execution authority** is a snapshot of what the Agent can reach in the inspected context: filesystem, network, environment, credentials, processes, and isolation. `--json` puts it at `config.driver.executionAuthority`. `unknown` means the runtime cannot prove that part, not that it is restricted, and the snapshot is not an enforcement decision or a proof of safety.

::note
`agent info`, `agent dev`, and `channels replay` read a private token that the dev server keeps outside the project with user-only permissions, so run them on the dev server's machine. Without it, the dev server refuses them, also when you expose it with `--host`.
::

## Cancel an Agent Invocation

Start the Vite + Nitro dev server, then cancel one pending or running Agent Invocation by its journal id.

```bash [Terminal]
pnpm vitehub agent invocations cancel ainv_0123
pnpm vitehub agent invocations cancel ainv_0123 --json
```

```txt [Output]
ainv_0123 cancel requested, not enforced by run
```

The cancel reaches the Invocation that the app is running, with any store, `createMemoryAgentInvocationStore()` included. The dev server takes the request only from a local host and the same origin. Use `--server` or `VITEHUB_DEV_SERVER_URL` when Vite is not on `http://localhost:5173`, and `--timeout` to change the timeout. `--json` prints the `AgentInvocationCancelResult` of `invocations.cancel(id)`, and `--url` cancels through the app's Console instead.

| Output | Meaning | Exit status |
| --- | --- | --- |
| `cancel requested` | A running Invocation got an abort signal. Its final journal state shows whether it stopped. | 0 |
| `cancel request recorded; execution stop is unconfirmed` | The journal kept the request for a current or future owner. A crashed owner sees it only after execution recovery. | 0 |
| `cancel requested, not enforced by <driver>` | The Driver cannot enforce an abort, and delivery does not confirm that its owner got the request. | 0 |
| `already <status>` | The Invocation already finished. | 0 for `cancelled`, 1 for `completed` or `failed` |
| `not found` | The journal has no Invocation with this id. | 1 |

::note
Nuxt runs Nitro outside the Vite process, and plain Vite has no Nitro, so there the dev server answers `501`, and the command prints the reason and exits with status 1.
::

## Inspect and cancel on a deployed app

Pass the app URL with `--url` to list, show, follow, or cancel Invocations through the app's [Console](/docs/console), signed as [Call a deployed app](/docs/cli/operations#call-a-deployed-app) describes. The Console must be on, and `cancel` also needs `invoke: true`, as the Console cancel button does. The command does not load the project config, so a local config error cannot stop it.

```bash [Terminal]
export VITEHUB_CONSOLE_PRIVATE_KEY_CI='<private key>'
pnpm vitehub agent invocations list --url https://app.example.com --status running
pnpm vitehub agent invocations show ainv_0123 --url https://app.example.com
pnpm vitehub agent invocations tail ainv_0123 --url https://app.example.com
pnpm vitehub agent invocations cancel ainv_0123 --url https://app.example.com
pnpm vitehub agent invocations undo ainv_0123 --change chg_… --url https://app.example.com
```

`list --status` reads until it has `--limit` matches (default 50), `tail` prints new observations as they come, and `cancel` gives the same outcomes as in development.

`show` prints the changes an Agent made on a person's page through the [page Capability](/docs/agents/capabilities/page), in `pageChanges` and `approvals` with `--json`. `undo <id> --change <change>` asks that page, while it is open, to put one change back. The page restores its own record and keeps any value the person changed after the Agent, and the command exits 1 when the page could not put the value back.

::warning
A Console URL such as `http://localhost:3000/_vitehub`, or a localhost URL with no Console, still works but prints `AGENT_R1053` and stops working in the next minor version. Pass the app URL instead, or `--server` for the dev server.
::

## Talk to an Agent during development

`agent dev` attaches the **Agent Dev Loop** to a running dev server, so you can send an Agent messages from a terminal.

```bash [Terminal]
pnpm vitehub agent dev --agent support --url http://localhost:5173
```

```txt [Output]
Connected to support at http://localhost:5173
> /summary
```

Pass a message, or `--prompt` (`-p`), for one Invocation, or neither for an interactive session where you type messages and commands such as `/summary`.

```bash [Terminal]
pnpm vitehub agent dev "/summary" --agent support
pnpm vitehub agent dev --agent support -p "/summary"
pnpm vitehub agent dev --agent support --timeout 180000 -p "/summary"
```

`--input` passes the event input that a Channel, route, or webhook would send: one JSON object, inline or as `@<file>`, shaped for the Agent Trigger. Pass `--trigger` for a trigger other than chat. A file such as `server/agents/<agent>/dev.payload.json` keeps the fixture next to the Agent without changing production.

```json [server/agents/support/dev.payload.json]
{
  "user": { "id": "user_123", "name": "Local Developer" },
  "session": { "id": "local-support" },
  "meta": { "audience": "technical" }
}
```

```bash [Terminal]
pnpm vitehub agent dev --agent support --input @server/agents/support/dev.payload.json -p "/summary"
```

Start a message with `!` to run a shell command in the Agent's Workspace instead of talking to the Agent. The Agent must declare a writable Workspace, and successful changes are committed to the Workspace Store. Put Agent Dev Loop options before the `!`, because flags after it go to the shell command.

```bash [Terminal]
pnpm vitehub agent dev --agent support "!pnpm test"
pnpm vitehub agent dev --url http://localhost:5173 --timeout 180000 support !pnpm test --filter api
```

`--cli` runs the CLI of a Capability (a feature added to the Agent), with the command after `--`. The Agent Dev Loop has these commands by default, provider-backed Agents included, unless `defineAgent({ cli: { capabilities: false } })` hides them. During Agent runs, operation tool calls also show as command lines, such as `api listCustomers --query '{"status":"active"}'`.

```bash [Terminal]
pnpm vitehub agent dev --url http://localhost:3000 --agent support --cli inventory -- items list --json
```
