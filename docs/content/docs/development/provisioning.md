---
title: Provisioning
description: Create missing provider resources and write non-secret provider ids into local provision state.
navigation.order: 33
navigation.group: Build state
icon: i-lucide-cloud-cog
---

Provision is the ViteHub CLI workflow that creates missing provider resources required by app Definitions.
Provision Steps are package-contributed, idempotent, and create-only; they never delete or mutate existing resources.

## Preview the plan

Run a dry run first.
The CLI loads the Vite config, collects Provision Steps from active package integrations, and prints the actions for one provider.

```bash [Terminal]
CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_API_TOKEN=... pnpm vitehub provision run --provider cloudflare --dry-run
VERCEL_TOKEN=... VERCEL_PROJECT_ID=... pnpm vitehub provision run --provider vercel --dry-run
```

Provider steps use read credentials during planning to distinguish existing resources from resources to create. A dry run does not call `apply()` or write Provision State, but a useful plan still needs the provider credentials required to inspect current state.

```txt [Output]
create  d1-database  app-content
exists  r2-bucket    uploads
```

## Apply the plan

The apply command uses the same provider credentials as the plan. Cloudflare and Vercel use different credential sets.

```bash [Terminal]
CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_API_TOKEN=... pnpm vitehub provision run --provider cloudflare
VERCEL_TOKEN=... VERCEL_PROJECT_ID=... VERCEL_TEAM_ID=... pnpm vitehub provision run --provider vercel
```

Vercel Blob provisioning requires `VERCEL_PROJECT_ID` so the provision step can attach `BLOB_READ_WRITE_TOKEN` to the target project. `VERCEL_TEAM_ID` or `VERCEL_ORG_ID` supplies an optional team scope.

After a successful apply, the CLI writes non-secret ids to `.vitehub/provision.json`.
Vite Integrations may read that file as a binding-id source during dev or build.

```json [.vitehub/provision.json]
{
  "cloudflare": {
    "d1": {
      "default": "database-id"
    }
  }
}
```

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
