# NuxtHub migration lab

This lab follows [the migration guide](../../docs/content/docs/getting-started/migrate-from-nuxthub.md)
with Nuxt 4.5.2, NuxtHub 0.10.4, and packages built from this checkout. It creates
four applications under `~/.t3/worktrees/<checkout-name>-consumers/projects`.
Consumers stay outside the checkout so Node cannot find missing dependencies in
the repository's `node_modules`. Builds run in sequence. Node output
runs on `127.0.0.1:4531` for HTTP assertions, then stops. Each run checks a unique
process token and fails if that process exits during verification.

`legacy-node` runs NuxtHub's migration runner and writes a database row, nested
KV keys, a JSON-looking string, and a Blob with custom metadata. `fresh-node`
follows the guide's generate and migrate commands on an empty database without
a direct `drizzle-kit` dependency and checks the generated `blob.serve` route.
`existing-node` copies the
stopped legacy database and KV store, adopts the schema with a no-op baseline,
adds an email column, and imports the Blob through the public API. It checks
the old data after a restart, including Blob bytes, metadata, listings, and HTTP
200/404 responses. `existing-d1` seeds a synthetic old schema and NuxtHub history,
then runs the baseline and later schema change through Wrangler's local D1
runner. It checks generated D1, KV, and R2 resource identities, migration
filenames, and history counts. It does not run a legacy NuxtHub D1 application.
It also loads the built Worker in Miniflare and reads the migrated row through
HTTP, then checks KV and R2 bindings through application routes. This check uses
port `4532` and disposes the Worker afterward.
The KV comparison uses NuxtHub's read results, including its parsing of
JSON-looking strings.

Install and build the workspace first:

```sh
HEAVY_WAIT=0 heavy corepack pnpm install --offline --frozen-lockfile --ignore-scripts
HEAVY_WAIT=0 heavy corepack pnpm exec vp run -t vite-hub#build
```

Pack the local packages and install the isolated applications:

```sh
HEAVY_WAIT=0 heavy node labs/nuxthub-migration/lab.mjs setup
```

Then run the scenarios in order:

```sh
HEAVY_WAIT=0 heavy node labs/nuxthub-migration/lab.mjs legacy
HEAVY_WAIT=0 heavy node labs/nuxthub-migration/lab.mjs fresh
HEAVY_WAIT=0 heavy node labs/nuxthub-migration/lab.mjs existing
HEAVY_WAIT=0 heavy node labs/nuxthub-migration/lab.mjs d1
ss -ltn 'sport = :4531'
ss -ltn 'sport = :4532'
```

The offline install requires the pinned dependencies and their registry metadata
in the pnpm cache. `VITEHUB_NUXTHUB_PACKAGE` can select a local NuxtHub tarball.
`VITEHUB_MIGRATION_LAB_DIR` can select another generated directory outside this
checkout. Logs, tarballs, generated SQL, metadata, and databases stay there.
Remove that generated directory before starting a new complete run. The lab uses no
production resources. Local D1 checks do not prove a deployed Cloudflare Worker
or remote credentials. NuxtHub 0.10.11 was checked separately in source; this
lab's runtime baseline is 0.10.4.

## Verified run

All four scenarios passed on 2026-10-25 with Nuxt 4.5.2, NuxtHub 0.10.4,
Drizzle ORM 0.45.3, Drizzle Kit 0.31.11, Wrangler 4.147.0, and locally packed
ViteHub 0.0.4 packages. The consumers used the source fixes from this lab
without pnpm patches. Node verified data after a process restart. D1 verified
the migrated row through the built Worker in Miniflare, plus KV and R2 reads.

Keep migration-history adoption explicit. A general `vitehub migrate` codemod
would not resolve schema equivalence, resource identity, or Blob metadata
transfer. This lab does not add a codemod.
