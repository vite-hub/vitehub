# @vite-hub/env

<p>
  <a href="https://vitehub.dev"><img alt="ViteHub" src="https://img.shields.io/badge/ViteHub-vitehub.dev-646cff?style=flat-square"></a>
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-ready-3178c6?style=flat-square">
  <img alt="Vite" src="https://img.shields.io/badge/Vite-public%20env-646cff?style=flat-square">
</p>

`@vite-hub/env` declares environment values once, then generates typed public, build-time, and server-oriented access for Vite applications.

Most applications install `vite-hub` and enable Env through the framework preset. Install this owner package directly when a library or focused Vite integration needs Env without the rest of ViteHub.

## Install

```sh
pnpm add @vite-hub/env
```

## Choose an Env section

| Section      | Read when                 | Visible to client code | Use it for                                                       |
| ------------ | ------------------------- | ---------------------- | ---------------------------------------------------------------- |
| `env.public` | Build time                | Yes                    | Browser-safe application configuration.                          |
| `env.define` | Build transform           | Yes, where bundled     | Compile-time replacements such as a release identifier.          |
| `env.server` | Request or server runtime | By caller convention   | Host-supplied server configuration and source-only credentials.  |

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

The generated `#vitehub/env/server` module is not blocked from client builds. Keep its imports in server-only entry points, and supply credentials through `env.source(...)` without literals or defaults; static values and defaults can be serialized into the generated module.

`SecretEnv` renders as `<redacted>` in string conversion, JSON, and Node inspection. Call `unseal()` only at the provider boundary that needs the raw value. Redaction is type friction, not complete leak prevention: never return, log, trace, or place an unsealed value in Agent input.

## Structured errors

ViteHub-owned Env resolution failures use the shared `ViteHubError` contract with Env-specific codes. Custom source resolvers keep application-owned errors unchanged, so callers can preserve their own error contract without translating it through ViteHub.

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

Each `EnvErrorCode` owns a fixed public message and a bounded details shape. Source details use stable identifiers such as `git:branch`, `package.json`, `env`, or `custom`; raw variable names, package paths, and provider diagnostics stay behind `cause`, which `toJSON()` omits. Cancellation and existing `ViteHubError` instances pass through unchanged. Invalid `env()` calls remain `TypeError`, and `parseSchema()` keeps the schema library's ordinary error boundary.

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
