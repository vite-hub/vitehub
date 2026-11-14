---
title: Operation commands
description: Call any package operation of the app as a vitehub command, on the dev server of the project or on a deployed app with a signed call.
navigation.title: Operations
navigation.order: 12
navigation.group: Operate
icon: i-lucide-square-terminal
---

Every package [operation](/docs/console/operations) of your app is also a `vitehub` command, so a script or an Agent can do from a terminal what the Console does.

## Run any operation

The command is `vitehub <namespace> <command> [positional] [--key value]`. The namespace is the operation's section, or its `cli.namespace`, and the command is its verb, or its `cli.command`, so `agents.list` becomes `vitehub agents list`.

```bash [Terminal]
pnpm vitehub agents status --agent support
pnpm vitehub invocations list --limit 10
pnpm vitehub invocations get ainv_123 --json
pnpm vitehub invocations delete ainv_123 --yes
```

`vitehub inspect definitions --kind operation` lists every operation with its command, and `vitehub <namespace> <command> --help` shows its input. A hand-written command with the same name, such as `vitehub blob list` or `vitehub content edit`, runs instead of the generated one.

| Flag | What it does |
| --- | --- |
| `--json` | Print JSON, also for a failure: `{ "error": { "code", "message", "fix" } }`. |
| `--yes` | Delete or publish without asking. Without it, a terminal asks first and no terminal fails. A call marked read only (`readOnlyWhen`), such as `content publish --dry-run`, needs no `--yes`. |
| `--url <origin>` | Call a deployed app, as [Call a deployed app](#call-a-deployed-app) describes. |
| `--input <json>`, `--input @file.json` | Pass the whole input. Flags and positional arguments override it. |
| `--timeout <ms>` | Wait this long for the answer. |

Other flags come from the input's JSON Schema. A number, boolean, or string takes its text, a list takes repeated flags or commas (`--tags a,b`), an object or unknown value takes JSON (`--body '{"a":1}'`), and a nullable value takes `null`. A `string | number` input stays a string. The flag names above are reserved and cannot be input keys.

A failed command prints `<code>: <message>` and a `Fix:` line on stderr, and exits with `1`. A bad flag value fails with `CLI_R0003` and the usage line, and two operations with the same namespace and command fail the build and the CLI with `INTERNAL_B0049`.

`vitehub()` installs the RPC these commands call. Standalone `hubKV()`, `hubBlob()`, `hubEmail()`, and `hubRateLimit()` install a development RPC for their storage commands, but other standalone plugins, such as `hubWorkflow()`, `hubSchedule()`, and `hubQueue()`, need a running app with an operation RPC.

::note
Operations that run app code (`workflow.start`, `workflow.resume`, `queue.send`, `task.run`, `schedule.run`, and `schedule.start`) exist only when `console.invoke` is on. It is on in development and off in a production build, so on a deployment these commands answer "Console operation not found" until you set `console: { invoke: true }`. `task.run` is `destructive`, so it asks for `--yes`, and Agents and MCP clients need approval.
::

The built-in commands are `vitehub agents list|invoke|status`, `vitehub invocations list|get|cancel|undo|delete|workspace|capabilities`, `vitehub blob list`, `vitehub kv list|get|has|set|delete`, `vitehub database tables|rows`, `vitehub definitions list`, `vitehub env get`, `vitehub project info`, `vitehub search query`, `vitehub sections list`, `vitehub agent usage`, `vitehub documents action`, and `vitehub media action`. The task plugin adds `vitehub task list|run`, and the Queue package adds `vitehub queue list|send`.

## Find the dev server

Without `--url`, a command calls its own project's dev server, which writes its URL to `.vitehub/dev-server.json` while it listens. Without the file, the command uses `VITEHUB_DEV_SERVER_URL`, and with neither it fails with `CLI_R0005`. It never guesses `localhost:5173`, because another project may use that port, and it stops with `INTERNAL_R0025` when the server belongs to another project.

::tip
A Nuxt dev server does not write `.vitehub/dev-server.json`, so pass `--url` or set `VITEHUB_DEV_SERVER_URL`.
::

A command does not sign calls to the dev server it finds. When that server takes only [signed calls](/docs/console/signed-requests), as with `console: true`, the command fails with `401`, and the fix names the `--url` to pass so that it signs.

## Call a deployed app

Pass the app URL with `--url` to call a deployed app through its [Console](/docs/console), which must be on. Set the private key from `vitehub secret console-key` in `VITEHUB_CONSOLE_PRIVATE_KEY_<NAME>`, and the command signs as the key `<NAME>`. Set only one.

```bash [Terminal]
export VITEHUB_CONSOLE_PRIVATE_KEY_CI='<private key>'
pnpm vitehub invocations list --url https://app.example.com
```

`--url` is the app URL in every `vitehub` command: `https://app.example.com`, or `http://localhost:3000` for a local production build or a dev server. The command adds the Console path itself. A remote URL must use HTTPS, with no credentials, query, or fragment. The command does not follow redirects, and a `401` or a redirect reports a refused signature.
