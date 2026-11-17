# @vite-hub/env

<p>
  <a href="https://vitehub.dev"><img alt="ViteHub" src="https://comark-ui.onmax.me/badge.svg?label=ViteHub&amp;value=vitehub.dev"></a>
  <img alt="TypeScript" src="https://comark-ui.onmax.me/badge.svg?label=TypeScript&amp;value=ready">
  <img alt="Vite" src="https://comark-ui.onmax.me/badge.svg?label=Vite&amp;value=public+env">
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
  plugins: [hubEnv({
    public: {
      appName: env({ default: "ViteHub App", mode: "build" }),
    },
  })],
});
```

```ts
// app/env.ts
import { usePublicEnv } from "vite-hub/env";

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
  plugins: [hubEnv({
    server: {
      airtableToken: env({
        secret: true,
        source: env.source("AIRTABLE_TOKEN"),
      }),
    },
  })],
});
```

```ts
// server/sync.ts
import type { ViteHubContext } from "@vite-hub/runtime";
import { useServerEnv } from "vite-hub/env";

export async function sync(event: ViteHubContext) {
  const { airtableToken } = useServerEnv(event);

  await fetch("https://api.airtable.com/v0/app/table", {
    headers: { Authorization: `Bearer ${airtableToken.unseal()}` },
  });
}
```

## Set the values on the host

The build writes the host variable names of each `env.server` declaration to `deployment.json`, never the values. `vitehub env diff` shows which names the linked host lacks, and `vitehub env push` sets them from the shell and `.env.<stage>` with the host CLI. See [Check and push host env](https://vitehub.dev/docs/development/cli#check-and-push-host-env).

To keep the values in git, encrypt `.env.<stage>` with [dotenvx](https://dotenvx.com/encryption) and keep the private key out of git. `vitehub env push` decrypts `encrypted:` values with `DOTENV_PRIVATE_KEY_<STAGE>` from the shell or `.env.keys`. See [Encrypted env files](https://vitehub.dev/docs/development/cli#encrypted-env-files).

## Derive secrets from one root secret

`deriveSecret(purpose)` from `@vite-hub/env` derives a 32-byte hex secret from `VITEHUB_SECRET` with HKDF-SHA256, salt `vitehub`. Auth derives its secret the same way. The Vite development server generates and keeps a root secret in `.vitehub/env/secret` when none is set; builds never generate one. `vitehub secret generate` prints a new root secret and `vitehub secret derive <purpose>` prints a derived one. The root secret signs and authenticates; it does not encrypt stored data. See [App secret](https://vitehub.dev/docs/env/app-secret).

## Seal a value

`seal(purpose, value, { ttl })` from `@vite-hub/env` encrypts and signs a JSON value with AES-GCM. It returns a URL-safe string, so you can put it in a link, a cookie, or a hidden field. `unseal(purpose, sealed)` reads it back. Use it for upload tickets, signed links, OAuth state, and other tokens that the client must carry but must not read or change.

```ts
// server/uploads.ts
import { seal, unseal } from "@vite-hub/env";
import * as v from "valibot";

const Upload = v.object({ userId: v.string() });

export async function uploadUrl(userId: string) {
  const ticket = await seal("my-app:upload", { userId }, { ttl: 900 });
  return `/api/uploads/${ticket}`;
}

export async function readTicket(ticket: string) {
  const [error, upload] = await unseal("my-app:upload", ticket, { schema: Upload });
  if (error) return undefined; // ENV_SEAL_EXPIRED, ENV_SEAL_INVALID, ENV_SEAL_SCHEMA_MISMATCH, ENV_SEAL_USED_UP, or ENV_SEAL_WRONG_PURPOSE
  return upload;
}
```

Each purpose gets its own key, derived from `VITEHUB_SECRET` with `deriveSecret()`, so a value sealed for one purpose does not open as another. `ttl` is in seconds; without it, the value does not expire. `schema` takes any Standard Schema and types the value; without it, the value is `unknown`. `unseal()` returns a `Result`; a missing root secret or a bad argument throws. Web Crypto does the work, so the same string opens on Node, Workers, Deno, and Bun.

To rotate `VITEHUB_SECRET`, put the old secret in `VITEHUB_SECRET_PREVIOUS` (one secret, or a comma-separated list). `seal()` uses `VITEHUB_SECRET`, and `unseal()` also tries each old secret, so open links and cookies keep working until they expire. For values that you store, such as provider credentials, pass a separate root secret: `seal("my-app:credentials", value, { secret: env.credentialsKey })`, with the same `secret` for `unseal()`. To rotate it, pass `[newKey, oldKey]`: `seal()` uses the first, and `unseal()` tries each. See [Sign and seal values](https://vitehub.dev/docs/env/seal).

### Single-use values

Pass `uses` and a `db` to make a share link that opens once, or N times, and then is gone. Pass the same `db` to `unseal()`. Each read takes one use with one conditional `UPDATE`, so of two reads of the last use on any instances, one gets the value and the other gets `ENV_SEAL_USED_UP`.

```ts
// server/api/share/[token].get.ts
import { defineEventHandler, getRouterParam, HTTPError } from "h3";
import { unseal } from "vite-hub/env";
import { db } from "vite-hub/database";

// Create the link elsewhere: await seal("my-app:share", { apiKey }, { uses: 1, ttl: 3600, db })
export default defineEventHandler(async (event) => {
  const [error, shared] = await unseal("my-app:share", getRouterParam(event, "token")!, { db });
  if (error) throw new HTTPError({ status: 410, message: error.why }); // ENV_SEAL_USED_UP, ENV_SEAL_EXPIRED, ...
  return shared;
});
```

The token holds the encrypted value. The `vitehub_env_seal_uses` table holds only a random id, the uses left, and the expiry, so a leak of the database does not leak values. `db` is a SQLite, libSQL, or D1 Drizzle database; KV cannot take a use atomically. A value that does not open, has expired, or does not match `schema` keeps its uses. `unseal()` without `db` throws `ENV_SEAL_ARGUMENT_INVALID` for a value sealed with `uses`.

## Protect a machine route

`requireServiceToken(event, name)` from `vite-hub/env` checks that a request carries `Authorization: Bearer <token>` with a token from the server variable `name`. Use it for routes that scripts, CI runners, and webhooks call. It needs no Auth setup.

```ts
// server/api/runs.post.ts
import { defineEventHandler } from "h3";
import { requireServiceToken } from "vite-hub/env";

export default defineEventHandler((event) => {
  requireServiceToken(event, "INGEST_TOKEN");
  return { ok: true };
});
```

It compares in constant time. A wrong or missing token throws a `401` HTTP error with `ENV_SERVICE_TOKEN_INVALID`. When the variable has no token, every request fails with `503` and `ENV_SERVICE_TOKEN_UNSET`. The variable holds one token, or a comma-separated list while you rotate. `checkServiceToken(event, name)` returns the same result as `[error, undefined]`. See [Service tokens](https://vitehub.dev/docs/env/service-tokens).

## Verify a webhook

`verifyWebhook(event, { provider, secret })` from `vite-hub/env` checks the signature of a Stripe, GitHub, or other HMAC-SHA256 webhook in a plain route. `secret` is the name of the server variable with the signing secret. It reads the raw body once, compares in constant time, and returns `[error, body]` with the parsed JSON body.

```ts
// server/api/stripe/webhook.post.ts
import { defineEventHandler, HTTPError } from "h3";
import { verifyWebhook } from "vite-hub/env";

export default defineEventHandler(async (event) => {
  const [error, stripeEvent] = await verifyWebhook<{ type: string }>(event, { provider: "stripe", secret: "STRIPE_WEBHOOK_SECRET" });
  if (error) throw new HTTPError({ status: 400, message: error.message });
  return { received: stripeEvent.type };
});
```

`provider` is `"stripe"` (`Stripe-Signature`, at most `toleranceSeconds` old, default 300), `"github"` (`X-Hub-Signature-256`), or `"hmac"` with a `header` and optional `prefix`, `encoding`, and `secretEncoding`. The codes are `ENV_WEBHOOK_SIGNATURE_INVALID`, `ENV_WEBHOOK_SECRET_UNSET`, and `ENV_WEBHOOK_BODY_INVALID`. The variable holds one secret, or a comma-separated list while you rotate. See [Verify webhooks](https://vitehub.dev/docs/env/webhooks).

`signWebhook(body, { provider, secret })` signs an outgoing body and returns the headers to send with it. `provider` is `"github"` (`x-hub-signature-256: sha256=<hex>`) or `"stripe"` (`stripe-signature: t=<unix>,v1=<hex>`). Here `secret` is the secret itself, not a variable name. Send the exact body that you signed, so `verifyWebhook()` and other standard receivers accept it.

## Typed server values

Host variables are strings. Declare `env.boolean()`, `env.number()`, `env.enum()`, `env.list()`, or `env.json()` when server code needs another type. ViteHub parses the value when Server Env resolves and generates the exact type.

```ts fragment
// vite.config.ts
env: {
  server: {
    dryRun: env.boolean({ default: true }), // true, false, 1, or 0
    minConfidence: env.number({ default: 0.6 }), // finite number
    mode: env.enum(["draft", "send"], { default: "draft" }),
  },
}
```

`useServerEnv().dryRun` is a `boolean`, `minConfidence` is a `number`, and `mode` is `"draft" | "send"`. Defaults use the parsed type. `env.enum()` cannot be secret because its allowed values are public metadata. An invalid value throws `ENV_RUNTIME_VALUE_INVALID` with the declaration path; the value is never included.

`env.list()` reads items separated by commas or line breaks: it trims each item and drops empty items. `env.list(env.number())` parses each item with the item helper. `env.json()` reads JSON text, and `env.json(env.schemaFrom("./server/env.schema.ts", "settings"))` checks it with a Standard Schema from a module:

```ts fragment
// vite.config.ts
env: {
  server: {
    adminEmails: env.list({ default: [] }), // string[]
    ports: env.list(env.number()), // number[]
    settings: env.json(env.schemaFrom("./server/env.schema.ts", "settings")), // schema output
  },
}
```

Put `default`, `secret`, `source`, and `optional` on the list, not on the item helper. Text that is not JSON fails with `ENV_RUNTIME_VALUE_INVALID`. See [Lists and JSON values](https://vitehub.dev/docs/env/configure#lists-and-json-values).

For a pattern, a custom refinement, or a transform, export a Standard Schema from a module and point the declaration at it. The server build imports the module and runs the schema on the raw value:

```ts fragment
// server/env.schema.ts
export const apiUrl = z.url().refine(url => url.startsWith("https://"))

// vite.config.ts
env: {
  server: {
    apiUrl: env({ schema: env.schemaFrom("./server/env.schema.ts", "apiUrl") }),
  },
}
```

The generated type is the schema output type. A secret keeps its `SecretEnv` wrapper, and its errors omit the schema messages. Read [Validate Server Env with your own schema](https://vitehub.dev/docs/env/configure#validate-server-env-with-your-own-schema).

## `.env.example` schemas

Opt in with `envSchema()` when a committed `.env.example` should own variable names, types, requiredness, sensitivity, and defaults:

```ts
import { envSchema, hubEnv } from "@vite-hub/env/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [hubEnv(envSchema(new URL("./.env.example", import.meta.url)))],
});
```

```dotenv
# @public
VITEHUB_PUBLIC_APP_NAME=Acme

# @type=number(min=1, max=10, isInt=true) @public
VITEHUB_RETRIES=3

# @example="get-this-from-your-secret-manager"
VITEHUB_API_TOKEN=
```

This uses the restricted `env-spec-v1` profile shared with the [Nuxt module](https://nuxt-safe-runtime-config.onmax.me). Its [@env-spec syntax](https://varlock.dev/env-spec/reference/) parser reads static metadata. It does not run Varlock, load developer `.env` files, or evaluate expansions and functions.

A nonempty assignment is a real default. `KEY=` has no default; `KEY=""` is an explicit empty string. Put documentation samples in `@example`, which never supplies a value. Review existing example assignments before opting in. All fields default to required and sensitive; the default type is always string, so `CODE=00123` preserves its zeroes.

Only `VITEHUB_PUBLIC_` names enter Public Env. Mark them `@public` or `@sensitive=false`; a sensitive public field is rejected. `@public` alone does not expose an unprefixed or private field. Private fields become runtime Server Env and do not require deployment secrets during prepare or build. For the example above, server code reads `useServerEnv().apiToken`, and the token is a `SecretEnv<string>`.

`envSchema(file, { prefix: "APP_", paths: { APP_DATABASE_URL: "database.url" } })` changes the prefix and maps exact schema keys to explicit output paths. The default mapping strips `VITEHUB_` and uses camel case, without guessing groups. With an empty prefix, `PUBLIC_` marks public fields. Public output paths stay flat. Every declaration reads its original schema key exactly; canonical aliases do not override it.

Supported types are string with `minLength`/`maxLength`, number with `min`/`max`/`isInt`, boolean, string enum, absolute URL, JSON arrays, and object shapes. URLs remain strings. Sensitive enums are rejected because their choices appear in metadata. Empty host inputs count as missing for every field type: they use the default when present, otherwise required fields fail and optional fields return `undefined`. Explicit empty schema defaults remain valid where the schema permits them. Invalid nonempty inputs fail, even when a default exists. Generated declarations describe the validated accessors; raw `process.env` types stay unchanged.

The [runnable schema lab](./examples/schema-lab/README.md) builds a browser bundle and Node server from one contract. Its production test restarts the same artifact with different server values, checks startup failures and consumer types, and scans browser output for synthetic credentials. Public Env remains fixed at build time.

## Presets

Presets return ordinary `env.server` declarations. Import them from `@vite-hub/env`.

| Preset | Declares |
| --- | --- |
| `openWorkflowEnv()` | OpenWorkflow namespace, Postgres URL, schema, and worker concurrency. |
| `typesafeEnv({ model? })` | The Server Env of the `typesafe()` AI gateway from `vite-hub/gateways`: Secret `apiKey` (`TYPESAFE_API_KEY`) and `model` (`TYPESAFE_DEFAULT_MODEL`, default `jev-latest`). |

The preset allows a missing API key during Env resolution; Jev reports `GATEWAYS_R0002` when a request needs it. `defineAgent({ driver: { ask } })` uses `typesafe()` when it gets no other gateway, and it reads this group:

```ts fragment
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
    server: {
      gatewayKey: env({ secret: true }),
      githubToken: env({
        secret: true,
        source: env.provider("credentials", "github/token"),
      }),
    },
  })],
}
```

```ts
// server/env/credentials.ts
import { defineEnvProvider } from "@vite-hub/env"
import type { SecretEnv } from "@vite-hub/env"

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
import { loadServerEnv } from "vite-hub/env"

const snapshot = await loadServerEnv()
const githubToken = snapshot.githubToken.unseal()
```

Each `loadServerEnv()` call batches requested keys once per provider and returns a fresh frozen snapshot. ViteHub does not cache across loads, so rotation appears on the next load. `useServerEnv()` stays synchronous for host-backed and literal values; provider-backed values require `loadServerEnv()` or `runWithServerEnv()`.

`env.source(["PRIMARY_TOKEN", "FALLBACK_TOKEN"])` reads the first variable that is set and not empty. An empty variable, such as `PRIMARY_TOKEN=`, counts as missing for every source. It does not shadow a later name, and it does not satisfy a required value or a secret.

The Server Env helpers of `@vite-hub/env` are not blocked from client builds. Keep their imports in server-only entry points, and supply credentials through `env.source(...)` without literals or defaults; static values and defaults can be serialized into the generated module.

`SecretEnv` renders as `<redacted>` in string conversion, JSON, and Node inspection. Call `unseal()` only at the provider boundary that needs the raw value. Redaction is type friction, not complete leak prevention: never return, log, trace, or place an unsealed value in Agent input.

## Structured errors

ViteHub-owned Env resolution failures use the shared `ViteHubError` contract with Env-specific codes. Custom source resolvers keep application-owned errors unchanged, so callers can preserve their own error contract without translating it through ViteHub.

Install the shared runtime package before inspecting structured errors:

```sh
pnpm add @vite-hub/runtime
```

```ts fragment
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

Use `hubEnv()` in Vite to resolve public/build env, generate the Public Env and Server Env that `usePublicEnv()` and `useServerEnv()` read, and keep environment declarations close to the app config. Runtime secrets are read from the host environment at request time and are wrapped in `SecretEnv` until explicitly unsealed.

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

To type code without running Vite, such as in a test or a docs check, pass the same `env` options to `createEnvTypes()`. It returns the contents of `.vitehub/types/env.d.ts`:

```ts
import { mkdirSync, writeFileSync } from "node:fs";
import { createEnvTypes, env } from "@vite-hub/env/vite";

mkdirSync(".vitehub/types", { recursive: true });
writeFileSync(".vitehub/types/env.d.ts", createEnvTypes({
  server: { githubToken: env({ secret: true, source: env.source("GITHUB_TOKEN") }) },
}));
```

Public Env and `env.define` values are compiled into client bundles. Never put credentials in either section. The host still owns secret storage and injection; Env owns declarations, resolution, generated accessors, validation, and default redaction.

Read the complete [Env guide](https://vitehub.dev/docs/env), the [host support matrix](https://vitehub.dev/docs/frameworks-hosts/support-matrix), and the project's [pre-1.0 security policy](https://github.com/vite-hub/vitehub/blob/main/SECURITY.md).

### Declaration inventory

`describeServerEnv()` from `@vite-hub/env` returns declaration metadata without reading host values or calling providers. It includes the declaration path, the `names` an env declaration reads in read order (the canonical name first unless `canonical: false` or `prefix: false` turns it off, then the `env.source()` names or the unprefixed path name), source kind, provider alias, secret and required flags, default presence, and the parsed value type. Values, defaults and provider storage keys are omitted. Use `inspectServerEnv()` only when a status check that loads providers is intended. Its entries add the provider alias, required flag, `names`, the `name` that supplied an env value, and `available`, `defaulted`, `missing`, `invalid`, or `error` status, and never include values. Env entries also report `via: "canonical" | "conventional"` and `conflict: true` when the canonical and a conventional name hold different values. `isBlockingServerEnvEntry(entry)` from `@vite-hub/env` returns `true` when the entry makes `loadServerEnv()` fail.

`hubEnv()` contributes two CLI commands:

```bash
vitehub env inspect [--stage <name>] [--json]
vitehub env check [--stage <name>] [--json]
```

Both commands load the Vite config in the selected stage mode, including `.env.<stage>` files, with process environment values taking precedence. They list each declared variable with status, source, required, and secret flags. `--json` also lists the host variable `names` of each env declaration. Values are never printed. `env check` exits with `1` when `loadServerEnv()` would fail.

`hubEnv()` also contributes the `env.inspect` operation. It asks the running app, not a local stage, so the CLI and the Console can check that a deployed app has its env. It answers on the signed `POST /_vitehub/rpc` endpoint like every other operation, and needs the `env` Console section (`env:read` is enough).

```bash
vitehub env status --url https://my-app.example.com
```

The result has `ok`, the `host` that the app runs on when it is known, and one entry per declaration: `path`, `names`, `name` (the host variable that supplied the value), `source`, `provider`, `required`, `secret`, `status`, and `blocking`. The status is `available`, `defaulted`, `missing`, `invalid`, or `error`, as in `inspectServerEnv()`. The result never holds a value, a preview, or a length.

### Managed credentials

`createEnvBridge` from `@vite-hub/env/bridge` adapts a secret store to Env with credential-scoped permissions and durable activity. `createDatabaseEnvStore` from `@vite-hub/env/database` supplies encrypted storage, grants, and activity using a ViteHub SQLite/Drizzle database. Use `await store.revisionCondition(key, revision)` to build a SQL predicate that updates related metadata only while that secret revision is current. A `null` revision requires the secret to be absent. Keep its 32-byte encryption keys in host configuration and back them up separately from the database.

`encryptionKeys` is a keyring: the current key first, then previous keys. Each value is stored as `v2:<keyId>:<iv>:<ciphertext>`, where `keyId` is `sealKeyId()` of the key that sealed it. A read picks the key by its id. A value from an older store, `<iv>:<ciphertext>` without a key id, reads with the current key, then each previous key. The AES-GCM additional data binds each value to its namespace, key, and revision, so a value moved to another row does not decrypt.

To rotate the key:

1. Pass `encryptionKeys: [newKey, oldKey]`. New writes use `newKey`.
2. Call `await store.rotate()`. It re-encrypts each value that another key sealed and returns `{ rotated, skipped }`. Revisions stay the same, so `revisionCondition()` and `expectedRevision` stay valid. A value that a write replaces during the rotation keeps the new write.
3. Pass `encryptionKeys: [newKey]`.

`@vite-hub/env/seal` exports the AES-GCM helpers that the database store uses: `importSealKey`, `sealWithKey`, `unsealWithKey`, and `sealKeyId`. Other owner packages use them to store sealed values in the same format. To seal an app value with a key derived from `VITEHUB_SECRET`, use [`seal()` and `unseal()`](#seal-a-value).

A bridge implements the existing `read()` provider contract. Its `replace()` operation requires the last inspected revision (or `null` to create), preventing lost updates. Existing snapshots remain unchanged; the next load resolves the replacement. A custom store returns its own activation requirement: next resolution, restart, or deployment.

`inspect`, `preview`, `replace`, and `use` are separate permissions. Only a trusted administrator can modify grants or inspect activity. A verified agent token can supply a narrower permission ceiling.

Env creates every `EnvAccessContext`. Each producer gets only the identity that it can prove:

- `createEnvBridge({ runtimeActor })`: the runtime reads with its own fixed actor, on that bridge only. `runtimeAttribution` can add trace and invocation IDs.
- `createEnvAuthenticator()`: the authenticated user, or the Agent of a verified Agent token. It creates an administrator context only when the application's `isAdmin` policy returns `true`.
- The ViteHub Agent runtime: `agent:<name>` for the Agent Definition that runs, through Connections.

The bridge rejects any context that Env did not create, including a literal such as `{ actor }`, a spread copy, or a JSON copy, with `ENV_BRIDGE_UNTRUSTED`. TypeScript also rejects a context that application code builds. Use `EnvAccessContext` as a type, and pass the value that Env gave you. `loadServerEnv(undefined, { access })` forwards that context to providers.

Migration: replace `runtimeContext: () => ({ actor })` with `runtimeActor: actor`. Get request contexts from `createEnvAuthenticator()`. A custom `authenticate` must return the context from `createEnvAuthenticator()`.

`bridge.use(context, key, operation, callback)` runs a trusted operation with a `SecretEnv` and records its outcome. The callback also receives `{ revision }` for the secret read when the store supplies a revision. Use that revision to fence related writes; a later inspection can refer to a replacement token. Ordinary provider reads record `resolve`, which does not claim to observe later use of copied plaintext. Activity is persisted before release or mutation and after completion. An interrupted operation can retain a `started` record; a remote store and the activity database do not share a transaction. Failed audit persistence blocks release. The optional `emit` callback exports persisted events to evlog or another sink; exporter failures do not erase durable activity.

Database previews are opt-in. Short and structured values have no preview. Previews remain protected metadata and are excluded from activity. The database adapter uses AES-256-GCM with per-write IVs and authenticates the namespace, key, and revision. Host administration and database backup security remain application responsibilities.

The Agent integration verifies the exact identity object registered during Agent Definition resolution. A name, a copied identity, or an authenticated Agent token cannot establish Agent runtime authority. The optional Agent peer is used only by this integration; the Env bridge and HTTP authenticator do not load it.

JSON types support nested constraints, for example `@type=array(string)` and `@type=object(enabled=boolean, retries=number(min=0))`. Defaults use quoted JSON such as `VITEHUB_TAGS='["one"]'`. Runtime JSON members must already match their types. Object shapes require every declared property and reject additional properties. Bare `array` and `object` accept JSON without a fixed shape. Sensitive declarations reject nested enums because enum choices are public metadata. Existing code-first declarations remain supported.
