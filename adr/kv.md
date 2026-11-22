# @vite-hub/kv decisions

Each entry records a decision that the code cannot show. See [README.md](README.md) for the format.

## Named fs-lite stores live beside the default store folder

`fsLiteStoreBase` in `packages/kv/src/config.ts`.

**Context:** fs-lite migrateKeys treats root folders of a base without a layout record as legacy keys.

**Decision:** Named stores use .vitehub/data/kv-stores/<encoded name>.

**Consequences:** Inside .vitehub/data/kv the default store would migrate their folders as keys. Goes away if the legacy migration is deleted.

## Store names encode into one path or key segment

`fsLiteStoreBase`, `redisStorePrefix` in `packages/kv/src/config.ts`.

**Context:** Store names are free text; unstorage normalizeKey splits on : and /.

**Decision:** encodeURIComponent plus . to %2E for folders; encode %:/\? for Redis prefixes; % for an empty name.

**Consequences:** .. escapes the data folder; names collide with other stores' prefixes.

## Redis and Upstash stores always have a non-empty key prefix

`resolveStoreBase` in `packages/kv/src/config.ts`.

**Context:** A Redis database is often shared with sessions and job queues.

**Decision:** Fall back to vitehub:kv:<name> when base is empty.

**Consequences:** clear() deletes and list() exposes other apps' keys.

## KV never selects Redis from REDIS_URL on its own

`inferred store resolution` in `packages/kv/src/config.ts`.

**Context:** The build picks the driver; KV_REDIS_URL_UNUSED tells the developer to set driver redis.

**Decision:** Inference gives database or fs-lite; Redis only with an explicit driver.

**Consequences:** An unrelated REDIS_URL moves store data at runtime.

## errors.ts re-exports kvStoreWithMode for the generated Cloudflare runtime

`kvStoreWithMode re-export` in `packages/kv/src/errors.ts`.

**Context:** vite.ts generates an import of kvStoreWithMode from KV_ERRORS_IMPORT_ID.

**Decision:** Keep the re-export though no source module imports it from errors.ts.

**Consequences:** Deleting it as dead code breaks Cloudflare builds.

## Dev owns Wrangler's remote flag; builds keep user fields

`configureCloudflareKV` in `packages/kv/src/integrations/cloudflare.ts`.

**Context:** Wrangler has experimental_remote and remote.

**Decision:** In dev drop experimental_remote and set remote from store.remote; leave build entries alone.

**Consequences:** Stale experimental_remote sends local dev to the real namespace, or builds overwrite user config.

## KV operations load the Nitro runtime module lazily

`runtime` in `packages/kv/src/operations.ts`.

**Context:** runtime/operations.ts imports @vite-hub/kv, which needs #vitehub/kv/config.

**Decision:** Load runtime/operations.ts with a dynamic import.

**Consequences:** A static import breaks the CLI and inspect outside Nitro.

## Provision declares every Cloudflare store, including stores with a configured id

`createKVCloudflareProvisionStep recordedState` in `packages/kv/src/provision.ts`.

**Context:** Undeclared recorded ids are offered for deletion.

**Decision:** declared includes all Cloudflare stores.

**Consequences:** Filtering on namespaceId offers to delete a namespace in use.

## Cloudflare KV limits are enforced before the binding call and on the local dev store

`cloudflareKVLimits`, `cloudflareKVSetOptions`, `cloudflareExpirationSeconds`, `createCloudflareKVLocalDriver`, `driver.setItems` in `packages/kv/src/runtime/cloudflare-kv-limits.ts`, `packages/kv/src/runtime/cloudflare-kv-local.ts`, `packages/kv/src/runtime/cloudflare-kv.ts`.

**Context:** Provider limits: key and value sizes, 60 s minimum TTL, no bulk put.

**Decision:** Check every entry first, clamp TTL to 60 s, apply the same rules to the local fallback.

**Consequences:** Writes partly succeed and dev differs from production.

## Cloudflare binding resolves from the per-request env

`createCloudflareKVDriver driverOptions` in `packages/kv/src/runtime/cloudflare-kv.ts`.

**Context:** ViteHub workers have no global __env__.

**Decision:** A binding getter returns getActiveCloudflareBinding(name), falling back to the name.

**Consequences:** A plain string binding fails in ViteHub workers.

## Continuation state is taken before await and cleared after teardown

`createCloudflareKVDriver`, `createDenoKVDriver` in `packages/kv/src/runtime/cloudflare-kv.ts`, `packages/kv/src/runtime/deno-kv.ts`.

**Context:** listKeys takes cursor history before the provider await; dispose clears in finally.

**Decision:** Take synchronously, restore on error, clear again after dispose.

**Consequences:** Concurrent reads share history; a closed driver leaks continuations.

## clear(prefix) is a text prefix that the driver deletes, listing all keys first

`driver.clear`, `createKVStorage clear` in `packages/kv/src/runtime/cloudflare-kv.ts`, `packages/kv/src/runtime/create-storage.ts`.

**Context:** unstorage clear(base) has mount semantics.

**Decision:** Pass the normalized prefix to driver.clear; Cloudflare lists everything, then deletes.

**Consequences:** Keys missed or wrongly deleted; cursors skip keys during delete.

## Portable continuation tokens

`encodeContinuation`, `decodeContinuation`, `take` in `packages/kv/src/runtime/cursor-history.ts`.

**Context:** Pages can go to another isolate; provider cursors are opaque.

**Decision:** vhc1:<uuid>:<payload>:<tag> holds bounded metadata; only a matching tag decodes as a token.

**Consequences:** Unbounded tokens, misread provider cursors, or broken cross-isolate paging.

## SQL batches of 200 rows, one row per key

`batchRows`, `driver.setItems` in `packages/kv/src/runtime/database.ts`.

**Context:** 4 params x 200 = 800 < 999; ON CONFLICT cannot touch one row twice.

**Decision:** batchRows = 200; keys are deduped before upsert.

**Consequences:** Larger batches fail on old SQLite; duplicate keys fail the statement.

## KV table creation uses an existence probe, then a Postgres advisory lock

`ready` in `packages/kv/src/runtime/database.ts`.

**Context:** Concurrent CREATE TABLE IF NOT EXISTS races on pg_type.

**Decision:** Probe with select 1 limit 0, then create inside a DO block with pg_advisory_xact_lock.

**Consequences:** NOTICE on every boot and failed concurrent first boots.

## Expired-row sweep runs from writes and increment and never fails the write

`sweep`, `incrementItem` in `packages/kv/src/runtime/database.ts`.

**Context:** shared-drivers.test.ts covers the sweep.

**Decision:** Run a best-effort background sweep and skip locked rows on Postgres. A full batch lets the next write sweep again; otherwise wait one minute. Log once per streak of failures, independently of the write's request.

**Consequences:** Rate-limit counters grow without bound, or writes fail on lock timeouts.

## Prefix match uses substr(), not LIKE

`prefixFilter` in `packages/kv/src/runtime/database.ts`.

**Context:** SQLite LIKE ignores case and treats % and _ as wildcards.

**Decision:** substr(key,1,len)=prefix with a character count.

**Consequences:** LIKE makes list and clear match the wrong keys.

## Increment SQL guards casts with a canonical-integer check

`incrementItem` in `packages/kv/src/runtime/database.ts`.

**Context:** query() replaces every ?, so a regex -? would break.

**Decision:** Use case when <integer> then cast, and -{0,1} in the regex.

**Consequences:** Cast errors on non-integers and placeholder corruption.

## The database driver does not close the Database client

`dispose` in `packages/kv/src/runtime/database.ts`.

**Context:** The client comes from the shared @vite-hub/database registry.

**Decision:** dispose only resets pending.

**Consequences:** Closing it breaks the app's Database.

## Deno KV prefix listing scans and filters

`clear` in `packages/kv/src/runtime/deno-kv.ts`.

**Context:** Deno prefixes match whole key parts, not text.

**Decision:** list({prefix: []}) and filter with startsWith.

**Consequences:** A Deno prefix query misses text-prefix matches.

## fs-lite stores each key as one flat encoded file

`fileName` in `packages/kv/src/runtime/fs-lite.ts`.

**Context:** unstorage fs-lite maps : to folders, so a key and its child collide.

**Decision:** key- prefix with % and : encoded.

**Consequences:** Key and child cannot both exist; keys collide with metadata.

## Layout workspace publication is race-safe across initializers

`migrateKeys` in `packages/kv/src/runtime/fs-lite.ts`.

**Context:** Several processes can open one store; fs-key-layout.test.ts tests the race.

**Decision:** Publish with link(), tolerate EEXIST/ENOENT, clean up under the workspace lock.

**Consequences:** Concurrent opens corrupt or lose the layout.

## fs-lite converts a plain unstorage fs-lite folder when it opens a store

`migrateKeys` in `packages/kv/src/runtime/fs-lite.ts`.

**Context:** The `nuxthub` codemod tells users to copy NuxtHub's `.data/kv` into `.vitehub/data/kv` or `.vitehub/data/kv-cloudflare/<binding>` with `cp -R`. That folder uses the plain unstorage fs-lite layout, where `a:b` is the file `a/b`, as ViteHub did before `key-` file names. `nuxthub-contracts.test.ts` covers the copy. Legacy files can have any name and content, but they cannot create hard links.

**Decision:** On the first open, move the root's files and folders into the layout workspace, then link each one to its `key-` name. Find the layout record only when it is a hard link to the marker inside its workspace.

**Consequences:** Without the conversion, copied NuxtHub keys are unreadable. If the record were found by name only, a legacy key file with the record's name could take over the layout. The conversion and the identity check can go once the codemod writes `key-` files itself.

## fs-lite reads throw the errors that unstorage returns as values

`driver.getItem`, `driver.getItemRaw` in `packages/kv/src/runtime/fs-lite.ts`.

**Context:** unstorage's node-fs `readFile` with `ignoreNotfound` returns every error other than ENOENT and EISDIR instead of throwing it, so the unstorage fs-lite driver resolves an EACCES or EIO as the value. This is still the case in unstorage 2.0.0-beta.0 and on unjs/unstorage main.

**Decision:** Throw a value that is an `Error`.

**Consequences:** Without the check, a read error is stored in the cache or returned to the app as a value. Remove it when unstorage throws these errors.

## fs-lite operations serialize under the layout lock

`synchronized`, `writeExpiry`, `live`, `method wrappers` in `packages/kv/src/runtime/fs-lite.ts`.

**Context:** Value and expiry are separate files.

**Decision:** Every public method runs inside the layout lock.

**Consequences:** Expiry cleanup deletes fresh values or value and expiry go out of sync.

## fs-lite lets unstorage validate a key before touching its path

`hasLiveItem`, `setIfAbsentItem` in `packages/kv/src/runtime/fs-lite.ts`.

**Context:** unstorage fs-lite rejects .. keys; the adapter then joins root and fileName(key).

**Decision:** Call the underlying hasItem first.

**Consequences:** Reordering opens path traversal.

## setIfAbsent claims with link() beside the destination

`setIfAbsentItem` in `packages/kv/src/runtime/fs-lite.ts`.

**Context:** Locks depend on atomic claims.

**Decision:** Write a temp file in root, link() it to the key; only the winner writes expiry.

**Consequences:** Two winners or EXDEV errors.

## Conditional writes serialize values as unstorage setItem does

`serializeValue` in `packages/kv/src/runtime/hosted-storage.ts`.

**Context:** setIfAbsent and deleteIfEquals bypass unstorage's serializer.

**Decision:** Mirror its rules.

**Consequences:** get() after setIfAbsent returns another shape; deleteIfEquals never matches.

## KV's build marks unstorage drivers as side-effect free

`pack treeshake.moduleSideEffects` in `packages/kv/vite.config.ts`.

**Context:** unstorage's root declarations import the options of every driver (unjs/unstorage#721), so a KV declaration file pulls in the optional SDK types of drivers KV does not use.

**Decision:** Return `false` for `unstorage/drivers/*` and leave every other module's `sideEffects` metadata alone.

**Consequences:** Without it, KV's declarations reference optional SDK types that do not resolve in an app without those SDKs. When unstorage ships the fix, bump the catalog, delete the override, and check that the built `.d.ts` files name no optional SDK types.

## Base64 chunks are multiples of 3 bytes

`encodeBase64` in `packages/kv/src/runtime/inspect-value.ts`.

**Context:** Chunks are encoded separately and joined.

**Decision:** 12288-byte chunks.

**Consequences:** A non-multiple of 3 puts = padding inside the output.

## A lock lease counts the full claim round trip

`acquire` in `packages/kv/src/runtime/lock.ts`.

**Context:** A slow reply can arrive after the TTL; lock.test.ts covers it.

**Decision:** If now - started >= ttl, release and do not report acquired.

**Consequences:** Two holders at once.

## The runtime imports @vite-hub/kv so builds can swap in the generated Cloudflare runtime

`kv import`, `resolveId` in `packages/kv/src/runtime/operations.ts`, `packages/kv/src/vite.ts`.

**Context:** resolveId maps @vite-hub/kv to the resolved KV runtime only for build plus Cloudflare.

**Decision:** Use the self-import; swap only in builds.

**Consequences:** A relative import splits storage; swapping in dev drops the fallback.

## Operation errors match by code, not class

`runKVOperation` in `packages/kv/src/runtime/operations.ts`.

**Context:** Several nostics copies can be loaded.

**Decision:** Read code and status structurally.

**Consequences:** instanceof misses errors and the status becomes 500.

## Redis increment uses EXISTS to decide expiry

`redisIncrementScript` in `packages/kv/src/runtime/redis-shared.ts`.

**Context:** INCR of an existing 0 returns 1.

**Decision:** EXPIRE only when the key did not exist.

**Consequences:** A counter at 0 resets its window TTL.

## Redis and Upstash SCAN cursors carry all their state

`PortableCursor`, `driver.listKeys` in `packages/kv/src/runtime/redis-shared.ts`, `packages/kv/src/runtime/upstash-driver.ts`.

**Context:** redis-pagination.test.ts: replaying cursor 0 after deletes skips keys.

**Decision:** The cursor stores the next SCAN cursor plus unreturned keys of the current batch.

**Consequences:** Keys skipped and cross-instance paging broken.

## The Nitro storage driver returns stored text, and bytes for raw reads

`getItem`, `getItemRaw` in `packages/kv/src/runtime/unstorage-driver.ts`.

**Context:** Nitro cache mounts KV.

**Decision:** type text for getItem and bytes for getItemRaw.

**Consequences:** Double-parsed values and corrupted binary data.

## The Upstash adapter disables auto-deserialization and prefixes its own keys

`createUpstashKVDriver` in `packages/kv/src/runtime/upstash-driver.ts`.

**Context:** @upstash/redis would JSON-parse replies.

**Decision:** automaticDeserialization false; added methods use prefixed().

**Consequences:** Text values such as null/123 are lost; keys get double or missing prefixes.

## Read-mode store handles copy methods without this

`kvStoreWithMode` in `packages/kv/src/store-mode.ts`.

**Context:** The read handle is built from detached method references.

**Decision:** Methods must not depend on this.

**Consequences:** Using this breaks kv.store(name, {mode: 'read'}).

## Path-imported internal modules are not package exports

`operationsModule`, `exports.exclude` in `packages/kv/src/vite.ts`, `packages/kv/vite.config.ts`.

**Context:** ownModule() gives file paths for generated code.

**Decision:** Exclude errors, operations and runtime/* from exports.

**Consequences:** Exporting makes them public API; removing the files breaks generated code.

## Nuxt replays Vite hooks with partial configs

`findDatabasePlugin`, `configResolved` in `packages/kv/src/vite.ts`.

**Context:** A host quirk of vite-hub/nuxt.

**Decision:** Optional plugins; keep command from the config hook.

**Consequences:** Crashes, or dev treated as build under Nuxt.

## Only the dev server config module gets .env credentials

`serializeVirtualConfig` in `packages/kv/src/vite.ts`.

**Context:** env is passed only for serve and SSR.

**Decision:** Upstash values are resolved only in the dev module.

**Consequences:** Secrets leak into build output.

## The KV Nitro plugin disposes stores on close

`configureNitroPlugin` in `packages/kv/src/vite.ts`.

**Context:** nitro-plugin.ts hooks close to disposeKVStores.

**Decision:** Register it whenever Redis or inferred stores are used.

**Consequences:** Node does not exit with an open ioredis connection.

## The Cloudflare request-env middleware runs first

`configureNitroCloudflareRequestEnv` in `packages/kv/src/vite.ts`.

**Context:** Bindings come from the per-request env.

**Decision:** handlers.unshift.

**Consequences:** Earlier middleware cannot use KV.

## unstorage's cloudflare:workers import stays external

`isUnstorageCloudflareWorkersImport` in `packages/kv/src/vite.ts`.

**Context:** cloudflare:workers is a workerd built-in.

**Decision:** Mark it external for SSR when the importer is unstorage/dist.

**Consequences:** Builds fail to resolve it.

## KV reads the Database config again at buildStart

`postgresDatabase`, `buildStart` in `packages/kv/src/vite.ts`.

**Context:** Plugin hook order.

**Decision:** Reset runtimeConfig at buildStart.

**Consequences:** Postgres inference is missed and the store picks the wrong driver.

## Prerender gets the KV config as a Nitro virtual module

`prerender:config hook` in `packages/kv/src/vite.ts`.

**Context:** prerender-config.test.ts covers it.

**Decision:** Inject a virtual module with prerender true; skip it for deno-kv.

**Consequences:** The prerender build cannot resolve #vitehub/kv/config or tries Workers/Deno bindings from Node.

## KV throws for every unknown store key

`assertKnownKVStoreKeys` in `packages/kv/src/config.ts`.

**Context:** A config object that a variable or another file builds skips TypeScript's check of unknown keys.

**Decision:** Throw `KV_UNKNOWN_STORE_OPTION` for every key that is not `driver`, `remote`, or an option of the store's driver. An option set to `undefined` counts as omitted.

**Consequences:** A store without `driver` would silently ignore a driver option, such as `binding` of a Cloudflare store.
