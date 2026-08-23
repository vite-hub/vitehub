# Server Primitives

Use this for application-owned storage, scheduling, environment, messaging, execution, or infrastructure behavior that does not need model judgment.

## Choose the primitive

When the primitive is known, open only its raw docs page, such as `https://vitehub.dev/raw/docs/server-primitives/kv.md`. Use the [Server Primitives index](https://vitehub.dev/raw/docs/server-primitives.md) only when choosing between primitives. Confirm the selected primitive's Vite Integration, optional Definition, Runtime Helper, local driver, and host support.

Common composition:

```text
vite.config.ts           provider and integration
server/<definitions>/    named discovered configuration when required
application server code stable Runtime Helper calls
.vitehub/                generated registry and diagnostics
provider output          deployment artifact when applicable
```

With the current facade, register `vitehub()` from `vite-hub` and import application APIs from feature subpaths such as `vite-hub/kv`, `vite-hub/blob`, or `vite-hub/rate-limit`. Validate those paths against installed exports before coding.

For Database runtime access, import `useDatabase` from `vite-hub/database/drizzle` and call it with the discovered database name. Use `useDatabase("default")` for a Default Database. Query through the returned `db` and `schema`; do not import a Database Definition into application code or use the direct `db`, `schema`, or `databases` exports.

For a read-only Collection backed by one database table, import `defineCollection` and `table` from `vite-hub/source`, then pass the `db` and `schema` table returned by `useDatabase` to `source: table(...)`. Declare non-null order columns with a unique final tie-breaker and put validated domain filtering in `where`; do not hand-write cursor predicates, ordering, or limits in application loaders. Keep the loader form of `defineCollection` as the escape hatch for SDKs, external APIs, joins, and other origins the table source cannot represent. Every module under `server/collections` is a public read model and must export a Collection with the same name as its filename. ViteHub generates its `/api/<name>` GET route, so do not add a matching `server/api` handler. Keep private definitions outside that directory, and restart Nuxt after adding, removing, or renaming a Collection module.

## Authority

Runtime Helpers called by application code keep authority in the application. If an Agent needs the same behavior, grant the narrow Capability documented for that feature; do not make every application primitive an Agent tool.

## Provider boundary

Keep provider selection in Vite config or the source-local handle's static policy. Application code should keep consuming the same handle when moving from a local driver to a hosted provider.

Rate Limit is an atomic consume primitive, not generic KV sugar. Use a Rate Limit Driver with matching guarantees, keep identity derivation in the caller or Agent Capability, and treat the memory driver as local or single-process only. Cloudflare native enforcement is best-effort and supports only the periods documented by the installed package. There is no generic KV adapter; do not model `get()` followed by `set()` as atomic enforcement.

Automatic Rate Limit memory selection belongs to Vite development and serve commands. For a production build, require inferred Cloudflare hosting or select the production provider explicitly; never let an unknown host silently become per-instance memory.

Before deploying Rate Limits, inspect `.vitehub/rate-limit/manifest.json` for the sorted stable IDs, resolved provider, enforcement level, counter scope, rejected-attempt behavior, and supported windows. Treat the manifest as generated inspection state, not an application import.

## Proof

Register the integration, execute the Runtime Helper, and observe the expected provider effect. For persistence, restart the process and read the value again. For a hosted target, also inspect the documented Provider Output.
