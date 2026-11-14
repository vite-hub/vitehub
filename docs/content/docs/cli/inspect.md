---
title: Inspect and provision commands
description: List discovered Definitions, generated Provider Output, and host resources, and preview provider resources before you create them.
navigation.title: Inspect and provision
navigation.order: 13
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

`inspect output` lists the Provider Output files (the files a build writes for the host) and shows which exist. Deployment paths use the host's output directory, such as `.output` or `.vercel/output`. Run a production build first.

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

## Preview provisioning

Use `--dry-run` before you create provider resources.
Provision never deletes or changes existing resources. It writes non-secret ids only when a real run applies actions.

```bash [Terminal]
CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_API_TOKEN=... pnpm vitehub provision run --provider cloudflare --dry-run
VERCEL_TOKEN=... VERCEL_PROJECT_ID=... pnpm vitehub provision run --provider vercel --dry-run
```

