# @vitehub/env v1 Proposal

`@vitehub/env` is a Vite and Nitro environment contract that keeps timing explicit without adding another required config file.

The primary problem is not missing env validation. Modern apps mix `.env` files, host env, `process.env`, `import.meta.env`, Vite `define`, Nitro runtime values, and provider runtime contexts under similar names. This package keeps the model narrow:

- `env.public` in Vite is build-time public config and is frozen into the client build.
- `env.define` in Vite is compile-time replacement for constants and dead-code elimination.
- `env` in Nitro is flat private runtime config read after build.

## API

```ts
import { envVariable, envSource } from "@vitehub/env"
```

Runtime env variables default to required strings:

```ts
databaseUrl: envVariable("DATABASE_URL")
apiBase: envVariable("PUBLIC_API_BASE", { optional: true })
token: envVariable("API_TOKEN", { secret: true })
```

Build-time values opt into `mode: "build"` and can use env, package, git, or custom sources:

```ts
version: envVariable({
  mode: "build",
  source: envSource.packageJson("version"),
  schema: z.string(),
})

commit: envVariable({
  mode: "build",
  source: envSource.gitCommit({ short: true }),
  schema: z.string(),
})

isPreview: envVariable({
  mode: "build",
  source: () => process.env.VERCEL_ENV === "preview",
  schema: z.boolean(),
})
```

## Vite

```ts
export default defineConfig({
  env: {
    public: {
      appName: envVariable("PUBLIC_APP_NAME", {
        mode: "build",
        schema: z.string(),
      }),
    },
    define: {
      __APP_VERSION__: envVariable({
        mode: "build",
        source: envSource.packageJson("version"),
        schema: z.string(),
      }),
      __GIT_COMMIT__: envVariable({
        mode: "build",
        source: envSource.gitCommit({ short: true }),
        schema: z.string(),
      }),
    },
  },
  plugins: [envVite()],
})
```

```ts
import { useSafeBuildConfig } from "virtual:@vitehub/env/build"

const config = useSafeBuildConfig()
config.public.appName
```

## Nitro

```ts
export default defineNitroConfig({
  env: {
    databaseUrl: envVariable("DATABASE_URL", { secret: true }),
    apiBase: envVariable("PUBLIC_API_BASE", { optional: true }),
  },
  modules: ["@vitehub/env/nitro"],
})
```

```ts
import { useSafeRuntimeConfig } from "#vitehub/env/server"

export default defineEventHandler((event) => {
  const config = useSafeRuntimeConfig(event)
  return config.apiBase
})
```

Nitro public runtime config is intentionally out of scope for v1. Apps that need public runtime data should expose an explicit endpoint.

When the Nitro module runs under a Cloudflare preset/config, required `secret: true` declarations are also added to `cloudflare.wrangler.secrets.required`.

## Sources

Built-in source labels appear in diagnostics:

- `env:DATABASE_URL`
- `package.json:version`
- `git:branch`
- `git:commit`
- `custom`

Custom resolver callbacks are build-mode only in v1. Nitro runtime declarations are serialized into generated runtime files, so runtime values use env sources only until a safe callback registration model exists.
