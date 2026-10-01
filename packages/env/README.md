# @vite-hub/env

<p>
  <a href="https://vitehub.dev"><img alt="ViteHub" src="https://img.shields.io/badge/ViteHub-vitehub.dev-646cff?style=flat-square"></a>
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-ready-3178c6?style=flat-square">
  <img alt="Vite" src="https://img.shields.io/badge/Vite-public%20env-646cff?style=flat-square">
</p>

`@vite-hub/env` declares environment values once, then generates typed public and server-oriented access plus untyped build-time replacements for Vite applications.

Most applications install `vite-hub` and enable Env through the framework preset. Install this owner package directly when a library or focused Vite integration needs Env without the rest of ViteHub.

## Install

```sh
pnpm add @vite-hub/env
pnpm add -D vite
```

## Choose an Env section

| Section      | Read when                 | Visible to client code | Use it for                                                      |
| ------------ | ------------------------- | ---------------------- | --------------------------------------------------------------- |
| `env.public` | Build time                | Yes                    | Browser-safe application configuration.                         |
| `env.define` | Build transform           | Yes, where bundled     | Untyped compile-time replacements such as a release identifier. |
| `env.server` | Request or server runtime | By caller convention   | Host-supplied server configuration and source-only credentials. |

## First result

```ts
// vite.config.ts
import { env, hubEnv } from "@vite-hub/env/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [hubEnv()],
  env: {
    public: {
      appName: env({ default: "ViteHub App", mode: "build" }),
    },
  },
});
```

```ts
// app/env.ts
import { usePublicEnv } from "#vitehub/env/public";

console.log(usePublicEnv().appName); // ViteHub App
```

Run that file through the application's Vite dev or build pipeline. `hubEnv()` generates the stable `#vitehub/env/public` module and its field-level types; it is not a package import that plain Node resolves outside the configured application.

Add `.vitehub/types/**/*.d.ts` to the application's `tsconfig.json` `include` list when TypeScript should see the generated fields.

## Read a server secret

Declare a secret under `env.server`, then read it only from server code:

```ts
// vite.config.ts
import { env, hubEnv } from "@vite-hub/env/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [hubEnv()],
  env: {
    server: {
      airtableToken: env({
        secret: true,
        source: env.source("AIRTABLE_TOKEN"),
      }),
    },
  },
});
```

```ts
// server/sync.ts
import { useServerEnv } from "#vitehub/env/server";

export async function sync(event: unknown) {
  const { airtableToken } = useServerEnv(event);

  await fetch("https://api.airtable.com/v0/app/table", {
    headers: { Authorization: `Bearer ${airtableToken.unseal()}` },
  });
}
```

## Typed server values

Host variables are strings. Declare `env.boolean()`, `env.number()`, or `env.enum()` when server code needs another type. ViteHub parses the value when Server Env resolves and generates the exact type.

```ts
// vite.config.ts
env: {
  server: {
    dryRun: env.boolean({ default: true }), // true, false, 1, or 0
    minConfidence: env.number({ default: 0.6 }), // finite number
    mode: env.enum(["draft", "send"], { default: "draft" }),
  },
}
```

`useServerEnv().dryRun` is a `boolean`, `minConfidence` is a `number`, and `mode` is `"draft" | "send"`. Defaults use the parsed type. `env.enum()` cannot be secret because its allowed values are public metadata. An invalid value throws `ENV_RUNTIME_VALUE_INVALID` with the declaration path; the value is never included. `env.server` does not accept custom `schema` parsers because the generated runtime must serialize the parser.

## Presets

Presets return ordinary `env.server` declarations. Import them from `@vite-hub/env` or `@vite-hub/env/presets`.

| Preset | Declares |
| --- | --- |
| `openWorkflowEnv()` | OpenWorkflow namespace, Postgres URL, schema, and worker concurrency. |
| `typesafeEnv({ provider?, model? })` | TypeSafe Jev `provider`, Secret `apiKey`, and `model`. `"typesafe"` reads `TYPESAFE_API_KEY`; `"vercel"` reads the optional `AI_GATEWAY_API_KEY`. `TYPESAFE_DEFAULT_MODEL` overrides the model. |

The preset allows a missing API key during Env resolution. The ask Driver requires `TYPESAFE_API_KEY` for the TypeSafe provider and reports `AGENT_R0936` when it is missing. The Vercel provider can use `VERCEL_OIDC_TOKEN` without an API key.

`@vite-hub/agent` reads `typesafeEnv()` from the `typesafe` group for `driver.ask`:

```ts
env: {
  server: {
    typesafe: typesafeEnv(),
  },
},
```

## External runtime values

Use a read-only Env provider when application credentials live outside the host environment. Keep the provider's bootstrap credential in Kubernetes, Cloudflare, or the current host, then load the external values as one operation-scoped snapshot.

```ts
// vite.config.ts
import { env, hubEnv } from "@vite-hub/env/vite"

export default {
  plugins: [hubEnv({
    providers: { credentials: "./server/env/credentials.ts" },
  })],
  env: {
    server: {
      gatewayKey: env({ secret: true }),
      githubToken: env({
        secret: true,
        source: env.provider("credentials", "github/token"),
      }),
    },
  },
}
```

```ts
// server/env/credentials.ts
import { defineEnvProvider } from "@vite-hub/env/provider"
import type { SecretEnv } from "@vite-hub/env/secret"

export default defineEnvProvider<{ gatewayKey: SecretEnv<string> }>({
  async read({ env, keys, signal }) {
    const response = await fetch("https://credentials.internal/env", {
      headers: { authorization: `Bearer ${env.gatewayKey.unseal()}` },
      signal,
    })
    const values = await response.json() as Record<string, string | undefined>
    return Object.fromEntries(keys.map(key => [key, values[key]]))
  },
})
```

```ts
import { loadServerEnv } from "#vitehub/env/server"

const snapshot = await loadServerEnv()
const githubToken = snapshot.githubToken.unseal()
```

Each `loadServerEnv()` call batches requested keys once per provider and returns a fresh frozen snapshot. ViteHub does not cache across loads, so rotation appears on the next load. `useServerEnv()` stays synchronous for host-backed and literal values; provider-backed values require `loadServerEnv()` or `runWithServerEnv()`.

`env.source(["PRIMARY_TOKEN", "FALLBACK_TOKEN"], { skipEmpty: true })` skips empty host values. Without `skipEmpty`, a defined empty string remains a value. Generated built-in Channel sources use `skipEmpty` to preserve their host fallback behavior.

The generated `#vitehub/env/server` module is not blocked from client builds. Keep its imports in server-only entry points, and supply credentials through `env.source(...)` without literals or defaults; static values and defaults can be serialized into the generated module.

`SecretEnv` renders as `<redacted>` in string conversion, JSON, and Node inspection. Call `unseal()` only at the provider boundary that needs the raw value. Redaction is type friction, not complete leak prevention: never return, log, trace, or place an unsealed value in Agent input.

## Structured errors

ViteHub-owned Env resolution failures use the shared `ViteHubError` contract with Env-specific codes. Custom source resolvers keep application-owned errors unchanged, so callers can preserve their own error contract without translating it through ViteHub.

Install the shared runtime package before inspecting structured errors:

```sh
pnpm add @vite-hub/runtime
```

```ts
import { getViteHubErrorShape } from "@vite-hub/runtime";

try {
  await resolveVaultEnv();
} catch (error) {
  if (getViteHubErrorShape(error)?.code === "ENV_SOURCE_FAILED") {
    console.error("Env source failed");
  }
  throw error;
}
```

Each `EnvErrorCode` owns a fixed public message and a bounded details shape. Source details use stable identifiers such as `git:branch`, `package.json`, `env`, or `custom`; raw variable names, package paths, and provider diagnostics stay behind `cause`, which `toJSON()` omits. Cancellation and existing `ViteHubError` instances pass through unchanged. Invalid declaration helper calls and schema results use package-owned `ENV_R####` diagnostics. Build integration defects use `ENV_B####` diagnostics.

## Generated modules

Use `hubEnv()` in Vite to resolve public/build env, generate `#vitehub/env/public` and `#vitehub/env/server`, and keep environment declarations close to the app config. Runtime secrets are read from the host environment at request time and are wrapped in `SecretEnv` until explicitly unsealed.

`hubEnv()` writes generated env runtime modules to `.vitehub/env/` and generated env types to `.vitehub/types/env.d.ts`. Add `.vitehub/types/**/*.d.ts` to your `tsconfig.json` include list when TypeScript should see app-specific Public Env and Server Env fields.

For hosts that do not consume Vite plugin aliases directly, compose the generated modules explicitly:

```ts
import { createEnvImportAliases, createEnvTypeScriptPaths, hubEnv } from "@vite-hub/env/vite";

export default {
  nitro: {
    alias: createEnvImportAliases(),
  },
  typescript: {
    tsConfig: {
      compilerOptions: {
        paths: createEnvTypeScriptPaths({ relativeTo: ".nuxt" }),
      },
    },
  },
  vite: {
    plugins: [hubEnv()],
  },
};
```

Public Env and `env.define` values are compiled into client bundles. Never put credentials in either section. The host still owns secret storage and injection; Env owns declarations, resolution, generated accessors, validation, and default redaction.

Read the complete [Env guide](https://vitehub.dev/docs/server-primitives/env), the [host support matrix](https://vitehub.dev/docs/frameworks-hosts/support-matrix), and the project's [pre-1.0 security policy](https://github.com/vite-hub/vitehub/blob/main/SECURITY.md).

### Declaration inventory

`describeServerEnv()` from `#vitehub/env/server` returns declaration metadata without reading host values or calling providers. It includes the declaration path, source kind, provider alias, secret and required flags, default presence, and the parsed value type. Values, defaults, host variable names and provider storage keys are omitted. Use `inspectServerEnv()` only when a status check that loads providers is intended. Its entries add the provider alias, required flag, and `available`, `defaulted`, `missing`, `invalid`, or `error` status, and never include values. `isBlockingServerEnvEntry(entry)` from `@vite-hub/env` returns `true` when the entry makes `loadServerEnv()` fail.

`hubEnv()` contributes two CLI commands:

```bash
vitehub env inspect [--stage <name>] [--json]
vitehub env check [--stage <name>] [--json]
```

Both commands load the Vite config in the selected stage mode, including `.env.<stage>` files, with process environment values taking precedence. They list each declared variable with status, source, required, and secret flags. Values are never printed. `env check` exits with `1` when `loadServerEnv()` would fail.

### Managed credentials

`createEnvBridge` from `@vite-hub/env/bridge` adapts a secret store to Env with credential-scoped permissions and durable activity. `createDatabaseEnvStore` from `@vite-hub/env/database` supplies encrypted storage, grants, and activity using a ViteHub SQLite/Drizzle database. Use `await store.revisionCondition(key, revision)` to build a SQL predicate that updates related metadata only while that secret revision is current. A `null` revision requires the secret to be absent. Keep its 32-byte encryption key in host configuration and back it up separately from the database.

`@vite-hub/env/seal` exports the AES-GCM helpers that the database store uses: `importSealKey`, `seal`, `unseal`, and `sealKeyId`. Other owner packages use them to store sealed values in the same format.

A bridge implements the existing `read()` provider contract. Its `replace()` operation requires the last inspected revision (or `null` to create), preventing lost updates. Existing snapshots remain unchanged; the next load resolves the replacement. A custom store returns its own activation requirement: next resolution, restart, or deployment.

`inspect`, `preview`, `replace`, and `use` are separate permissions. Only a trusted administrator can modify grants or inspect activity. A verified agent token can supply a narrower permission ceiling. Context must come from authenticated server code, never an HTTP body. `loadServerEnv(undefined, { access })` forwards trusted actor and invocation attribution to providers.

`bridge.use(context, key, operation, callback)` runs a trusted operation with a `SecretEnv` and records its outcome. The callback also receives `{ revision }` for the secret read when the store supplies a revision. Use that revision to fence related writes; a later inspection can refer to a replacement token. Ordinary provider reads record `resolve`, which does not claim to observe later use of copied plaintext. Activity is persisted before release or mutation and after completion. An interrupted operation can retain a `started` record; a remote store and the activity database do not share a transaction. Failed audit persistence blocks release. The optional `emit` callback exports persisted events to evlog or another sink; exporter failures do not erase durable activity.

Database previews are opt-in. Short and structured values have no preview. Previews remain protected metadata and are excluded from activity. The database adapter uses AES-256-GCM with per-write IVs and authenticates the namespace, key, and revision. Host administration and database backup security remain application responsibilities.
