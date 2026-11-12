---
title: Inspect, operate, and provision
description: List discovered Definitions and Provider Output, call any app operation from the terminal, and preview provider resources before you create them.
navigation.order: 5
navigation.group: Operate
icon: i-lucide-scan-search
---

`inspect` and `provision` are built into the CLI, so every ViteHub app has them.

## Inspect Definitions and Provider Output

`vitehub inspect` prints the summaries the Console shows, without a server or provider call. A Definition is the code that declares one resource, such as a queue or a rate limit. Each active package adds its own kind: `agent`, `auth`, `browser`, `channel`, `collection`, `content`, `database`, `queue`, `rate-limit`, `realtime`, `sandbox`, `schedule`, `workflow`, and `workspace`.

```bash [Terminal]
pnpm vitehub inspect definitions
pnpm vitehub inspect definitions --kind rate-limit
pnpm vitehub inspect definitions --json
```

```txt [Output]
Rate Limits (rate-limit): 1
  checkout  server/api/checkout.post.ts  [require-rate-limit]
    Limit: 10
    Window: 1m
    Enforcement: Strict
    Provider failure: Deny
    Source location: 4:9
```

`--json` prints `{ "definitions": [{ "kind", "label", "definitions": [...] }] }`. Each Definition has `name`, `file` (from the project root), `source`, and `fields`. An unknown `--kind` exits with status 1 and lists the kinds.

`inspect output` lists the Provider Output files (the files a build writes for the host) and shows which exist. Deployment paths use the preset's output directory, such as `.output` or `.vercel/output`. Run a production build first.

```bash [Terminal]
pnpm build
pnpm vitehub inspect output
pnpm vitehub inspect output --json
```

`--json` includes the parsed content of each JSON file. The CLI redacts values under secret keys such as `token`, `secret`, `password`, or `apiKey`, every Worker `vars` value, and URLs with credentials. See [Provider output](/docs/reference/provider-output) for each file's owner and purpose.

`inspect resources` lists the host resource behind each Definition or store: D1 databases, Workers KV namespaces, R2 buckets, Cloudflare Queues, and the Vercel Blob store. Each entry shows the host, the resource kind, the Definition or store, the resource name, the binding, the id if one is known, and where the id came from. Like `inspect output`, it loads the configuration that a production build uses. It reads local files only and never calls a provider API.

```bash [Terminal]
pnpm vitehub inspect resources
pnpm vitehub inspect resources --json
```

```txt [Output]
cloudflare	cloudflare-d1	default
  Name: app-db
  Binding: DB
  Id: database-id
  Source: .vitehub/provision.json
cloudflare	cloudflare-r2-bucket	default
  Name: uploads
  Binding: BLOB
  Source: bound by name
```

| Source | Meaning |
| --- | --- |
| `config` | The Definition or the integration options set the id or the Vercel Blob token. |
| `env` | An env variable set the id. `env` names the variable. |
| `provision-state` | `vitehub provision run` recorded the id in `.vitehub/provision.json`. |
| `provider-output` | Only the generated Wrangler config of the last build names the id. |
| `name` | The host binds the resource by its name and needs no id, as for R2 buckets and Cloudflare Queues. |
| none | No id is known yet. Run `vitehub provision run` or set the id. |

For the Vercel Blob store, the id is `BLOB_STORE_ID`, which Vercel sets for the store connected to the project. Off Vercel, the store is reached through `BLOB_READ_WRITE_TOKEN`, and the CLI reports only whether the token is set, never its value. A configured `token` that overrides the environment is reported as `config`, without a store id or token value. `--json` prints `{ "resources": [...] }` with the same fields and the CLI redaction. D1 over HTTP, PostgreSQL Databases, and Definitions whose `cloudflare` value cannot be read statically are not listed.

Packages contribute inspection through `vitehub.inspect` on their Vite plugin. The owner package defines the summary; the CLI and the Console only render it. A package lists its host resources with `resources()`.

## Run any operation

Every package [operation](/docs/development/operations) is also a command: `vitehub <namespace> <command> [positional] [--key value]`. The namespace is the operation section (or its `cli.namespace`), and the command is its verb (or its `cli.command`), so `agents.list` is `vitehub agents list`. `vitehub inspect definitions --kind operation` lists each operation and its command. `vitehub <namespace> <command> --help` shows the input.

```bash [Terminal]
pnpm vitehub agents list
pnpm vitehub agents status --agent support
pnpm vitehub invocations list --limit 10
pnpm vitehub invocations get ainv_123 --json
pnpm vitehub invocations delete ainv_123 --yes
pnpm vitehub invocations list --url https://app.example.com
```

The generated commands need the Console RPC. `vitehub()` installs it. Standalone `hubKv()`, `hubBlob()`, `hubEmail()`, and `hubRateLimit()` install a local development RPC for their storage commands. Other standalone plugins, such as `hubWorkflow()`, `hubSchedule()`, and `hubQueue()`, need a running app with an operation RPC.

Operations that run app code (`workflow.start`, `workflow.resume`, `queue.send`, `task.run`, `schedule.run`, and `schedule.start`) exist only when `console.invoke` is on. It is on in development and off in a production build, so on a deployment these commands answer "Console operation not found" until you set `console: { invoke: true }`. `task.run` is `destructive`: the command asks for `--yes`, and agents and MCP need approval.

The built-in commands are `vitehub agents list|invoke|status`, `vitehub invocations list|get|cancel|delete|workspace|capabilities`, `vitehub blob list`, `vitehub kv list|get|has|set|delete`, `vitehub database tables|rows`, `vitehub definitions list`, `vitehub env get`, `vitehub project info`, `vitehub search query`, `vitehub sections list`, `vitehub agent usage`, `vitehub documents action`, and `vitehub media action`. `vitehub task list|run` come from the task plugin, and `vitehub queue list|send` from the Queue package. A hand-written command of the same name, such as `vitehub blob list`, wins.

| Option | Use it for |
| --- | --- |
| `--json` | Print JSON, also for a failure: `{ "error": { "code", "message", "fix" } }`. |
| `--yes` | Delete or publish without asking. Without it, a terminal asks first, and no terminal fails. A call marked read only (`readOnlyWhen`), such as `content publish --dry-run`, needs no `--yes`. |
| `--url <origin>` | Call a deployed app with the credentials in the table below. |
| `--input <json>` or `--input @file.json` | Pass the whole input. Flags and positional arguments override it. |
| `--timeout <ms>` | Wait this long for the answer. |

Flags come from the input's JSON Schema:

- A number, whole number, boolean, or string takes its text.
- A list takes repeated flags or commas (`--tags a,b`).
- An object, an unknown value, or a list of objects takes JSON (`--body '{"a":1}'`).
- A nullable value takes the text `null`. A `string | number` input stays a string.
- `url`, `timeout`, `json`, `yes`, and `input` are reserved and cannot be input keys.

Without `--url`, a command calls its own project's dev server, found in `.vitehub/dev-server.json` (`{ url, root }`). The dev server writes this file when it listens and removes it when it closes. Without it, the command uses `VITEHUB_DEV_SERVER_URL`. With neither, it fails with `CLI_R0005`. It never guesses `localhost:5173`, because another project may use that port. The dev RPC names its project in a response header, and the command stops with `INTERNAL_R0025` when it is another project. A Nuxt dev server does not write the file, so pass `--url` or set `VITEHUB_DEV_SERVER_URL`.

A command does not sign its calls to the dev server that it finds. When that dev server takes only [signed calls](/docs/development/console#sign-console-requests), as with `console: true`, the command fails with `401`, and its fix names the `--url` to pass. With `--url`, the command signs its calls to the dev server too.

A failed command prints `<code>: <message>` and a `Fix:` line on stderr, and exits with `1`. A bad flag value fails with `CLI_R0003` and the usage line. Two operations with the same namespace and command fail the build and the CLI load with `INTERNAL_B0049`. A hand-written command with the same name as a generated one runs instead, as `vitehub content edit` does.

## Preview provisioning

Use `--dry-run` before you create provider resources.
Provision never deletes or changes existing resources. It writes non-secret ids only when a real run applies actions.

```bash [Terminal]
CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_API_TOKEN=... pnpm vitehub provision run --provider cloudflare --dry-run
VERCEL_TOKEN=... VERCEL_PROJECT_ID=... pnpm vitehub provision run --provider vercel --dry-run
```
