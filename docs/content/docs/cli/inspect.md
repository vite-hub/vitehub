---
title: Inspect and provision commands
description: List discovered Definitions, generated Provider Output, and host resources, and preview provider resources before you create them.
navigation.title: Inspect and provision
navigation.order: 13
navigation.group: Operate
icon: i-lucide-scan-search
---

`vitehub inspect` shows what ViteHub found in your code and what it will ask the host for, and `vitehub provision` creates the missing host resources. Both are built into the CLI, so every ViteHub app has them.

## Inspect Definitions and Provider Output

`inspect definitions` prints the summaries the Console shows, with no server. A **Definition** is the code that declares one resource, such as a queue or a rate limit, and each active package adds its kind: `agent`, `auth`, `browser`, `channel`, `collection`, `content`, `database`, `queue`, `rate-limit`, `realtime`, `sandbox`, `schedule`, `workflow`, and `workspace`.

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

`--json` prints `{ "definitions": [{ "kind", "label", "definitions": [...] }] }`, where each Definition has `name`, `file` (from the project root), `source`, and `fields`. An unknown `--kind` exits with status 1 and lists the kinds.

`inspect output` lists the **Provider Output** files, the files a build writes for the host, and shows which exist. Run a production build first, because the paths use the host's output directory, such as `.output` or `.vercel/output`.

```bash [Terminal]
pnpm build
pnpm vitehub inspect output --json
```

`--json` includes the parsed content of each JSON file, with values under secret keys such as `token`, `secret`, `password`, or `apiKey`, every Worker `vars` value, and URLs with credentials redacted. [Provider output](/docs/reference/provider-output) lists each file's owner and purpose.

`inspect resources` lists the host resource behind each Definition or store: D1 databases, Workers KV namespaces, R2 buckets, Cloudflare Queues, and the Vercel Blob store. It reads the production build configuration from local files, never a provider API.

```bash [Terminal]
pnpm vitehub inspect resources
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

Each entry ends with where its id came from. `--json` prints `{ "resources": [...] }` with the same fields and redaction.

| Source | Meaning |
| --- | --- |
| `config` | The Definition or the integration options set the id or the Vercel Blob token. |
| `env` | An env variable set the id, and `env` names it. |
| `provision-state` | `vitehub provision run` recorded the id in `.vitehub/provision.json`. |
| `provider-output` | Only the generated Wrangler config of the last build names the id. |
| `name` | The host binds the resource by name and needs no id, as for R2 buckets and Cloudflare Queues. |
| none | No id is known yet. Run `vitehub provision run` or set the id. |

For the Vercel Blob store, the id is `BLOB_STORE_ID`, which Vercel sets for the store connected to the project. Off Vercel, the CLI reports only whether `BLOB_READ_WRITE_TOKEN` is set, never its value, and a configured `token` shows as `config` with no store id or token. D1 over HTTP, PostgreSQL Databases, and Definitions whose `cloudflare` value cannot be read statically are not listed.

::note
Package authors add summaries through `vitehub.inspect` on the Vite plugin, and host resources with `resources()`.
::

## Preview provisioning

`provision run --dry-run` shows the provider resources it would create, before you create them.

```bash [Terminal]
CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_API_TOKEN=... pnpm vitehub provision run --provider cloudflare --dry-run
VERCEL_TOKEN=... VERCEL_PROJECT_ID=... pnpm vitehub provision run --provider vercel --dry-run
```

Provision never deletes or changes an existing resource, and writes non-secret ids only when a real run applies actions. `vitehub provision status` shows the recorded ids, ids that no Definition declares, and pending plan actions. [Provisioning](/docs/development/provisioning) covers the full flow.
