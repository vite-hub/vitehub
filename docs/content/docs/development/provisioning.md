---
title: Provisioning
description: Create missing provider resources and write non-secret provider ids into local provision state.
navigation.order: 33
navigation.group: Build state
icon: i-lucide-cloud-cog
---

Use Provision to create the provider resources that your Definitions need before
the first deploy. Each enabled package contributes Provision Steps. The steps are
idempotent and create-only: they never delete or change existing resources.

| Provider | Resources that Provision can create | Owner package |
| --- | --- | --- |
| Cloudflare | D1 databases | Database |
| Cloudflare | Workers KV namespaces | KV |
| Cloudflare | R2 buckets | Blob |
| Cloudflare | Queues | Queue |
| Vercel | Blob stores, connected to the project | Blob |

`vitehub provision` accepts `--provider cloudflare` and `--provider vercel`
only.

## Preview the plan

Run a dry run first.
The CLI loads the Vite config, collects Provision Steps from active package integrations, and prints the actions for one provider.

```bash [Terminal]
CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_API_TOKEN=... pnpm vitehub provision run --provider cloudflare --dry-run
VERCEL_TOKEN=... VERCEL_PROJECT_ID=... pnpm vitehub provision run --provider vercel --dry-run
```

Provider steps use read credentials during planning to distinguish existing resources from resources to create. A dry run does not call `apply()` or write Provision State. A dry run without credentials does not fail. Steps that cannot look up current state skip their actions, and the CLI prints `provision: plan not checked.` instead of `no ... resources to create`. Database, KV, Blob, and Queue steps all report a skipped lookup this way.

Each line shows the action status, the resource kind, and the resource name.

```txt [Output]
create  cloudflare-d1            app-content
create  cloudflare-kv-namespace  app-cache
exists  cloudflare-r2-bucket     uploads
```

## Apply the plan

The apply command uses the same provider credentials as the plan. Without them, `provision run` exits with code 1 before it plans. Cloudflare and Vercel use different credential sets.

```bash [Terminal]
CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_API_TOKEN=... pnpm vitehub provision run --provider cloudflare
VERCEL_TOKEN=... VERCEL_PROJECT_ID=... VERCEL_TEAM_ID=... pnpm vitehub provision run --provider vercel
```

Vercel Blob provisioning requires `VERCEL_PROJECT_ID` so the provision step can attach `BLOB_READ_WRITE_TOKEN` to the target project. `VERCEL_TEAM_ID` or `VERCEL_ORG_ID` supplies an optional team scope.

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

`provision status` shows the ids recorded in `.vitehub/provision.json` for one provider and the actions that the current plan would apply.
It runs the same plan phase as `provision run`, but it never calls `apply()`, creates resources, or writes Provision State.

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

```txt [Output]
recorded cloudflare ids (.vitehub/provision.json):
d1      main     db-main
d1      primary  db-main  not declared
kv      cache    ns-cache not declared
fix: d1 "primary": d1 "main" uses the same id, so keep the resource and only remove the entry from .vitehub/provision.json.
fix: kv "cache": No Definition declares it. If no deployment uses ns-cache, run `wrangler kv namespace delete --namespace-id ns-cache`, then remove the entry from .vitehub/provision.json.
```

ViteHub never deletes the resource or edits the file. Check that no deployment, preview, or other app binds the id before you delete it. An entry that shares its id with a declared entry only needs its line removed from the file. An entry in a category that no active package owns, for example after you remove `hubKv()`, is also marked `not declared`.

If a current Definition has no recorded id, status defers deletion guidance for that Provision Step. Verify its resource id before deleting anything. For automatically provisioned resources, run `vitehub provision run --provider cloudflare` to record the current resources, then check status again. A renamed Definition may reuse the resource recorded under its old key.

R2 shared-resource checks include the bucket's jurisdiction, and deletion hints include `--jurisdiction` when needed. Older R2 entries containing only a bucket name have an unknown jurisdiction, so status never assumes they share a resource; check the jurisdiction before following their deletion hints.

The plan is also not checked when an applicable Provision Step skips its lookup. For example, Vercel Blob requires both `VERCEL_TOKEN` and `VERCEL_PROJECT_ID`.

## JSON output

Add `--json` to `provision run` or `provision status` when CI or an Agent reads the result.
The command writes one JSON document to stdout. Step messages and warnings stay out of stdout; warnings are included in the `warnings` array.
Output never contains provider credentials. Recorded ids are non-secret.

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
`provision run --json` returns `mode` (`dry-run` or `apply`), the planned `actions`, the `ids` written by this run, `stateFile` (`null` when nothing was written), and `warnings`.
An action may include `pending` to report required provider-side setup independently of resource existence. Without this field, an action is pending when `exists` is `false`. Vercel Blob includes the field because an existing store may still need a project connection.
Both commands exit with code `0` when the plan phase succeeds, also when actions are pending.
For `provision status --json`, require `plan.checked === true` before checking `plan.pending === 0` to gate a CI step. An unchecked plan can have zero pending actions because resource lookups were skipped.

## Resources without provisioning

Provision creates only resources that a provider requires before first use. These providers need no ViteHub Provision Step:

| Provider resource | Provisioning | Source |
| --- | --- | --- |
| Vercel Queues topics and consumer groups | None. A topic exists when a message is sent to it. Push consumers come from the deployed function configuration. | [Vercel Queues concepts](https://vercel.com/docs/queues/concepts) |
| Netlify Blobs stores | None. A store is created on first write and needs no site setting. | [Netlify Blobs](https://docs.netlify.com/build/data-and-storage/netlify-blobs/) |
| Node and self-hosted drivers, such as KV `fs-lite` and Blob `fs` | None. They use the local filesystem. | [Node and self-hosted](/docs/frameworks-hosts/node-self-hosted) |

Deno KV on Deno Deploy needs a KV database that is created and assigned to the app before `Deno.openKv()` can use it. ViteHub does not provision it: the Deno Deploy API can create a database instance, but it has no lookup for an idempotent plan, and assignment creates a new app revision. Create and assign the database in the Deno Deploy dashboard. Read [Deno KV on Deno Deploy](https://docs.deno.com/deploy/reference/deno_kv/).

## Resource ownership

| Owner | Responsibility |
| --- | --- |
| ViteHub CLI | Loads Vite config, collects Provision Steps, validates provider credentials, and writes Provision State. |
| Primitive package | Plans and applies resources for the primitive it owns. |
| Provider | Owns cloud resources, credentials, and existing-resource lookup behavior. |
| Vite Integration | Reads Provision State when generated Provider Output needs resource ids. |

## Production boundary

Provision is not a build step.
Builds may read Provision State, but they must not create provider resources.

::warning
Do not commit `.vitehub/provision.json` unless a project deliberately decides that non-secret provider ids belong in source control. The root repository ignores `.vitehub/**` by default.
::

## Next steps

- Use [Provider output](/docs/reference/provider-output) to understand generated host artifacts.
- Use [Cloudflare](/docs/frameworks-hosts/cloudflare) or [Vercel](/docs/frameworks-hosts/vercel) for host boundaries.
- Use [Troubleshooting](/docs/development/troubleshooting) for credential and output failures.
