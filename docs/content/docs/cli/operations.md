---
title: Operation commands
description: Call any package operation of the app as a vitehub command, on the dev server of the project or on a deployed app with a signed call.
navigation.title: Operations
navigation.order: 12
navigation.group: Operate
icon: i-lucide-square-terminal
---

Most commands in this section are package [operations](/docs/console/operations). This page tells how the CLI turns an operation into a command, how it finds the dev server, and how it calls a deployed app.

## Run any operation

Every package [operation](/docs/console/operations) is also a command: `vitehub <namespace> <command> [positional] [--key value]`. The namespace is the operation section (or its `cli.namespace`), and the command is its verb (or its `cli.command`), so `agents.list` is `vitehub agents list`. `vitehub inspect definitions --kind operation` lists each operation and its command. `vitehub <namespace> <command> --help` shows the input.

```bash [Terminal]
pnpm vitehub agents list
pnpm vitehub agents status --agent support
pnpm vitehub invocations list --limit 10
pnpm vitehub invocations get ainv_123 --json
pnpm vitehub invocations delete ainv_123 --yes
pnpm vitehub invocations list --url https://app.example.com
```

The generated commands need the Console RPC. `vitehub()` installs it. Standalone `hubKV()`, `hubBlob()`, `hubEmail()`, and `hubRateLimit()` install a local development RPC for their storage commands. Other standalone plugins, such as `hubWorkflow()`, `hubSchedule()`, and `hubQueue()`, need a running app with an operation RPC.

Operations that run app code (`workflow.start`, `workflow.resume`, `queue.send`, `task.run`, `schedule.run`, and `schedule.start`) exist only when `console.invoke` is on. It is on in development and off in a production build, so on a deployment these commands answer "Console operation not found" until you set `console: { invoke: true }`. `task.run` is `destructive`: the command asks for `--yes`, and agents and MCP need approval.

The built-in commands are `vitehub agents list|invoke|status`, `vitehub invocations list|get|cancel|undo|delete|workspace|capabilities`, `vitehub blob list`, `vitehub kv list|get|has|set|delete`, `vitehub database tables|rows`, `vitehub definitions list`, `vitehub env get`, `vitehub project info`, `vitehub search query`, `vitehub sections list`, `vitehub agent usage`, `vitehub documents action`, and `vitehub media action`. `vitehub task list|run` come from the task plugin, and `vitehub queue list|send` from the Queue package. A hand-written command of the same name, such as `vitehub blob list`, wins.

| Option | Use it for |
| --- | --- |
| `--json` | Print JSON, also for a failure: `{ "error": { "code", "message", "fix" } }`. |
| `--yes` | Delete or publish without asking. Without it, a terminal asks first, and no terminal fails. A call marked read only (`readOnlyWhen`), such as `content publish --dry-run`, needs no `--yes`. |
| `--url <origin>` | Call a deployed app with the credentials in [Call a deployed app](#call-a-deployed-app). |
| `--input <json>` or `--input @file.json` | Pass the whole input. Flags and positional arguments override it. |
| `--timeout <ms>` | Wait this long for the answer. |

Flags come from the input's JSON Schema:

- A number, whole number, boolean, or string takes its text.
- A list takes repeated flags or commas (`--tags a,b`).
- An object, an unknown value, or a list of objects takes JSON (`--body '{"a":1}'`).
- A nullable value takes the text `null`. A `string | number` input stays a string.
- `url`, `timeout`, `json`, `yes`, and `input` are reserved and cannot be input keys.

A failed command prints `<code>: <message>` and a `Fix:` line on stderr, and exits with `1`. A bad flag value fails with `CLI_R0003` and the usage line. Two operations with the same namespace and command fail the build and the CLI load with `INTERNAL_B0049`. A hand-written command with the same name as a generated one runs instead, as `vitehub content edit` does.

## Find the dev server

Without `--url`, a command calls its own project's dev server, found in `.vitehub/dev-server.json` (`{ url, root }`). The dev server writes this file when it listens and removes it when it closes. Without it, the command uses `VITEHUB_DEV_SERVER_URL`. With neither, it fails with `CLI_R0005`. It never guesses `localhost:5173`, because another project may use that port. The dev RPC names its project in a response header, and the command stops with `INTERNAL_R0025` when it is another project. A Nuxt dev server does not write the file, so pass `--url` or set `VITEHUB_DEV_SERVER_URL`.

A command does not sign its calls to the dev server that it finds. When that dev server takes only [signed calls](/docs/console/signed-requests), as with `console: true`, the command fails with `401`, and its fix names the `--url` to pass. With `--url`, the command signs its calls to the dev server too.

## Call a deployed app

Pass `--url` to call a deployed app through its [Console](/docs/console). The Console must be on.

Each command posts one birpc call to `/_vitehub/rpc` under the app URL, and [signs](/docs/console/signed-requests) it with the key in `VITEHUB_CONSOLE_PRIVATE_KEY_<NAME>`, a private key from `vitehub secret console-key`. The command signs as the key `<NAME>`. Set only one.

`--url` is the app URL, as in every `vitehub` command: `https://app.example.com`, or `http://localhost:3000` for a local production build or a dev server. Remote URLs must use HTTPS, without credentials, a query, or a fragment. The command does not follow redirects. A `401` or a redirect reports a refused signature.
