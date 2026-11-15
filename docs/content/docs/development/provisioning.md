---
title: Provisioning
description: Create the cloud resources your app needs and save their ids in a local file.
navigation.order: 33
navigation.group: Build state
icon: i-lucide-cloud-cog
---

Provision creates the cloud resources your Definitions need before the first
deploy. Each enabled package adds Provision Steps. You can run them many times
with the same result, and they never delete resources. They change an existing
resource only for an `update` action: D1 read replication for a Database that
sets `readReplication`.

| Provider | Resources that Provision can create | Owner package |
| --- | --- | --- |
| Cloudflare | D1 databases | Database |
| Cloudflare | Workers KV namespaces | KV |
| Cloudflare | R2 buckets | Blob |
| Cloudflare | Queues | Queue |
| Vercel | Blob stores, connected to the project | Blob |

`vitehub provision` accepts only `--provider cloudflare` and `--provider vercel`.

## Preview the plan

Run a dry run first. The CLI loads the Vite config, collects Provision Steps
from active packages, and prints the actions for one provider.

```bash [Terminal]
CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_API_TOKEN=... pnpm vitehub provision run --provider cloudflare --dry-run
VERCEL_TOKEN=... VERCEL_PROJECT_ID=... pnpm vitehub provision run --provider vercel --dry-run
```

Planning uses read credentials to tell existing resources from new ones. Each
step reads every page of the provider's list, so an account with many D1
databases, KV namespaces, R2 buckets, or Queues never plans a create for an
existing resource.

A dry run does not call `apply()` or write Provision State. Without
credentials it does not fail. Steps that cannot look up current state skip
their actions, and the CLI prints `provision: plan not checked.` instead of
`no ... resources to create`. Database, KV, Blob, and Queue steps all report a
skipped lookup this way.

Each line shows the status, resource kind, and name. An `update` line also
shows the change.

```txt [Output]
create  cloudflare-d1            app-content
update  cloudflare-d1            app-db      read replication: disabled -> auto
create  cloudflare-kv-namespace  app-cache
exists  cloudflare-r2-bucket     uploads
```

| Status | Meaning |
| --- | --- |
| `create` | The resource does not exist. `provision run` creates it. |
| `update` | The resource exists, but a setting differs. `provision run` changes only that setting. |
| `pending` | The resource exists but needs provider setup, such as a Vercel Blob project connection. |
| `exists` | The resource exists. `provision run` only records its id. |

## Apply the plan

Apply uses the same credentials as the plan. Without them, `provision run` exits with code 1 before it plans. Cloudflare and Vercel need different credentials.

Apply also needs a checked plan. When a step cannot look up its resources, such as Vercel Blob without `VERCEL_PROJECT_ID`, `provision run` applies nothing and exits with code 1. Fix the warning, then run it again. With `--json`, the result has `checked: false`.

```bash [Terminal]
CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_API_TOKEN=... pnpm vitehub provision run --provider cloudflare
VERCEL_TOKEN=... VERCEL_PROJECT_ID=... VERCEL_TEAM_ID=... pnpm vitehub provision run --provider vercel
```

Vercel Blob needs `VERCEL_PROJECT_ID` to connect the store to the project. The
connection adds `BLOB_STORE_ID`, which the driver uses for OIDC on Vercel.
`VERCEL_TEAM_ID` or `VERCEL_ORG_ID` sets an optional team scope.

After a successful apply, the CLI writes non-secret ids to `.vitehub/provision.json`.
Vite Integrations may read that file as a binding-id source during dev or build.
D1 database ids are keyed by Database name under `d1`. Cloudflare KV namespace ids are keyed by KV Store name under `kv`.
R2 buckets are recorded as `<jurisdiction>/<bucket-name>` (using `default` when no jurisdiction is set), keyed by Blob Store name under `r2`. Cloudflare Queue names are keyed by Queue Definition name under `queue`. Builds do not read `r2` or `queue`, because bucket and Queue names come from config and Definitions. `provision status` uses them to find a bucket or Queue that no Definition declares.

```json [.vitehub/provision.json]
{
  "cloudflare": {
    "d1": {
      "default": "database-id"
    },
    "kv": {
      "default": "namespace-id"
    },
    "r2": {
      "default": "default/bucket-name"
    },
    "queue": {
      "welcome": "queue-name"
    }
  }
}
```

## Check provision status

`provision status` shows the ids saved in `.vitehub/provision.json` for one
provider, and what the current plan would do. It plans like `provision run`,
but never calls `apply()`, creates resources, or writes Provision State.

```bash [Terminal]
CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_API_TOKEN=... pnpm vitehub provision status --provider cloudflare
```

```txt [Output]
recorded cloudflare ids (.vitehub/provision.json):
d1      default database-id
create  cloudflare-d1   app-content
plan: 1 pending action. Run `vitehub provision run --provider cloudflare` to apply.
```

A pending action needs resource creation or provider-side setup. An existing Vercel Blob store remains pending until it is connected to the project in all required environments.
If an existing project connection is missing environments, planning fails with `BLOB_R0020`. Correct the connection in Vercel before rerunning status or provisioning. `provision run` cannot modify an existing connection.
Planning failures exit with code 1 and write the diagnostic to stderr, including with `--json`.
Without provider credentials, the command still shows recorded ids, but it reports the plan as not checked instead of reporting no pending actions.

### Ids that no Definition declares

When you rename or remove a Database Definition, a KV Store, an R2 Blob Store, or a Queue Definition, its id stays in `.vitehub/provision.json` and its resource stays on the host. `provision status` marks that entry as `not declared` and prints a `fix:` line for it. This check reads only local config, so it also works without credentials.

Status also marks an R2 or Queue entry when its key is still declared but its recorded bucket name, jurisdiction, or Queue name differs from current config.

```txt [Output]
recorded cloudflare ids (.vitehub/provision.json):
d1      main     db-main
d1      primary  db-main  not declared
kv      cache    ns-cache not declared
fix: d1 "primary": d1 "main" uses the same id, so keep the resource and only remove the entry from .vitehub/provision.json.
fix: kv "cache": No Definition declares it. If no deployment uses ns-cache, run `wrangler kv namespace delete --namespace-id ns-cache`, then remove the entry from .vitehub/provision.json.
```

ViteHub never deletes the resource or edits the file. Check that no deployment, preview, or other app binds the id before you delete it. An entry that shares its id with a declared entry only needs its line removed from the file. An entry in a category that no active package owns, for example after you remove `hubKV()`, is also marked `not declared`.

Status defers deletion guidance when it cannot verify a current Definition's recorded resource against current config. A renamed Definition may reuse the resource recorded under its old key, even when its new key already has an id from an older Definition. D1 and KV ids cannot be matched to configured resource names locally: compare the provider's resource names and bindings with current Definitions before deleting anything. For R2 and Queues, `vitehub provision run --provider cloudflare` refreshes recorded identities that status can compare with config.

R2 shared-resource checks include the bucket's jurisdiction, and deletion hints include `--jurisdiction` when needed. Older R2 entries containing only a bucket name have an unknown jurisdiction, so status never assumes they share a resource and defers their deletion guidance while any R2 Store remains declared. Check the jurisdiction before following deletion hints when no R2 Stores remain declared.

The plan is also not checked when an applicable Provision Step skips its lookup. For example, Vercel Blob requires both `VERCEL_TOKEN` and `VERCEL_PROJECT_ID`.

## JSON output

Add `--json` when CI or an Agent reads the result. The command writes one JSON
document to stdout. Step messages and warnings stay out of stdout, and warnings
go in the `warnings` array. Output never has credentials. Saved ids are not
secret.

```bash [Terminal]
pnpm vitehub provision run --provider cloudflare --dry-run --json
pnpm vitehub provision status --provider cloudflare --json
```

```json [provision status --json]
{
  "plan": {
    "actions": [{ "exists": false, "kind": "cloudflare-d1", "name": "app-content", "step": "database:cloudflare-d1" }],
    "checked": true,
    "pending": 1
  },
  "provider": "cloudflare",
  "recorded": { "d1": { "default": "database-id" } },
  "schemaVersion": 1,
  "stateFile": ".vitehub/provision.json",
  "undeclared": [],
  "warnings": []
}
```

`undeclared` lists each recorded id that no Definition declares, as `{ category, key, id, fix }`.
`provision run --json` returns `mode` (`dry-run` or `apply`), the planned
`actions`, the `ids` this run wrote, `stateFile` (`null` when nothing was
written), and `warnings`.

An action can have `pending` to report needed provider setup apart from
existence. Without it, an action is pending when `exists` is `false`. Vercel
Blob sets it, because an existing store can still need a project connection.
An `update` action changes an existing resource. It has `exists: true` and
`pending: true`, and `update` describes the change, for example
`"read replication: disabled -> auto"`.

Both commands exit with code `0` when planning succeeds, also with pending
actions.

::warning
To gate CI on `provision status --json`, require `plan.checked === true` before
you check `plan.pending === 0`. An unchecked plan can show zero pending actions
because lookups were skipped.
::

## Preview deployments share data

Provision creates one resource per name. A preview deployment bound to the same
resource reads and writes the same rows, keys, objects, and messages as
production.

| Host | What a preview uses by default | Source |
| --- | --- | --- |
| Cloudflare Version URLs | The production resources of that Worker version: the same D1 databases, KV namespaces, R2 buckets, and Queues. | [Compare workflows](https://developers.cloudflare.com/workers/previews/compare-workflows/) |
| Cloudflare Previews | Only the bindings in the `previews` block of the Wrangler config. ViteHub does not write that block. Two Previews bound to the same D1 `database_id`, KV `id`, R2 `bucket_name`, or queue name share its data. | [Previews configuration](https://developers.cloudflare.com/workers/previews/configuration/), [Resources and isolation](https://developers.cloudflare.com/workers/previews/resources/) |
| Vercel preview deployments | The Blob store connected to the project in the Preview environment. `vitehub provision run --provider vercel` connects its store to Production, Preview, and Development. | [Connecting a store to your projects](https://vercel.com/docs/vercel-blob#connecting-a-store-to-your-projects) |

How you isolate a preview depends on how you deploy it.

**Cloudflare Previews.** Previews never read ViteHub's top-level bindings, so
ViteHub config or env does not move them. Declare preview resources yourself in
the `previews` block of the project Wrangler config: `previews.d1_databases`,
`previews.kv_namespaces`, `previews.r2_buckets`, and
`previews.queues.producers`, with the production binding names. Cloudflare does
not accept Queue consumers in `previews`. Point them at staging or test
resources, never production ids. After a build, check that the generated
config still has the block with `vitehub inspect output --json`.

For D1, apply migrations before you deploy the Preview:

1. Create `wrangler.preview-migrations.jsonc` with a top-level `d1_databases`
   entry. Its `database_name` and `database_id` match the Preview binding.
2. Name the binding `PREVIEW_DB`. Set `migrations_dir` to the Definition's
   migration directory, relative to this file. Copy `migrations_table` if set.
3. Run `pnpm exec wrangler d1 migrations apply PREVIEW_DB --remote --config wrangler.preview-migrations.jsonc`.

ViteHub stages migrations for its own top-level binding, so this separate config
targets the Preview database. Read
[Cloudflare's D1 migration procedure](https://developers.cloudflare.com/workers/previews/resources/#d1-migrations).

**A separate preview Worker.** Here the Worker uses ViteHub's top-level
bindings. Give that build its own resource names through env, and provision
them in the same job:

| Resource | Set a preview name or id with |
| --- | --- |
| D1 | `cloudflare.databaseName` as an Env declaration, for example `env({ source: env.source('D1_DATABASE_NAME') })` |
| Workers KV | `KV_NAMESPACE_ID`, or a separate `namespaceName` with both `namespaceId` and `KV_NAMESPACE_ID` unset |
| R2 | `BLOB_BUCKET_NAME` |
| Cloudflare Queues | `queue.namePrefix` |

For D1, leave `cloudflare.databaseId` unset to use the provisioned id, or set
it to the preview id directly or with an Env declaration. A set
`cloudflare.databaseId` wins over provision state. Changing only
`cloudflare.databaseName` does not override it.

The env values are fallbacks. A store's `namespaceId` wins over
`KV_NAMESPACE_ID`, and its `bucketName` wins over `BLOB_BUCKET_NAME`. Leave
those fields unset to use the fallbacks, or set them to preview resources.

The [live smoke workflow](https://github.com/vite-hub/vitehub/blob/main/.github/workflows/live-smoke.yml)
does this. Each run sets `VITEHUB_CLOUDFLARE_WORKER_NAME`, `BLOB_BUCKET_NAME`,
and `VITEHUB_KV_NAMESPACE_NAME` to scratch names, then provisions and builds its
own Worker.

A Version URL of the production Worker uses that version's bindings. Do not use
it to test writes.

**Vercel preview deployments.** In the Vercel dashboard, connect one store to
the project in Production and another in Preview.

::warning
`.vitehub/provision.json` keys D1 and KV ids by Definition or store name, not by
stage. A preview provision run in the same checkout replaces the production
ids. Run it in its own CI job or checkout, and check the ids with
`vitehub provision status` before you deploy.
::

`provision run --provider vercel` expects one store connected in all three
environments. After you split stores by environment, planning fails with
`BLOB_R0020`. Manage the connections in the Vercel dashboard, and do not run
Vercel provisioning for that project.

## Resources without provisioning

Provision creates only resources a provider needs before first use. These need
no Provision Step:

| Provider resource | Provisioning | Source |
| --- | --- | --- |
| Vercel Queues topics and consumer groups | None. A topic exists once a message is sent to it. Push consumers come from the deployed function configuration. | [Vercel Queues concepts](https://vercel.com/docs/queues/concepts) |
| Netlify Blobs stores | None. A store is created on first write and needs no site setting. | [Netlify Blobs](https://docs.netlify.com/build/data-and-storage/netlify-blobs/) |
| Node and self-hosted drivers, such as KV `fs-lite` and Blob `fs` | None. They use the local filesystem. | [Node and self-hosted](/docs/frameworks-hosts/node-self-hosted) |

Deno KV on Deno Deploy needs a KV database created and assigned to the app
before `Deno.openKv()` works. ViteHub does not provision it. The Deno Deploy API
can create one, but has no lookup for a repeatable plan, and assignment creates
a new app revision. Create and assign it in the Deno Deploy dashboard. Read
[Deno KV on Deno Deploy](https://docs.deno.com/deploy/reference/deno_kv/).

## Resource ownership

| Owner | Responsibility |
| --- | --- |
| ViteHub CLI | Loads Vite config, collects Provision Steps, validates provider credentials, and writes Provision State. |
| Primitive package | Plans and applies resources for the primitive it owns. |
| Provider | Owns cloud resources, credentials, and resource lookup. |
| Vite integration | Reads Provision State when Provider Output needs resource ids. |

## Production boundary

Provision is not a build step. Builds can read Provision State, but must not
create resources.

::warning
Do not commit `.vitehub/provision.json` unless your project decides that
non-secret provider ids belong in source control. The root repository ignores
`.vitehub/**` by default.
::

## Next steps

- [Provider output](/docs/reference/provider-output): generated host files.
- [Cloudflare](/docs/frameworks-hosts/cloudflare) or [Vercel](/docs/frameworks-hosts/vercel): host details.
- [Troubleshooting](/docs/development/troubleshooting): credential and output failures.
