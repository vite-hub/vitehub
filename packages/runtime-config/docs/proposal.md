# @vitehub/runtime-config v1 Proposal

`@vitehub/runtime-config` is a timing-explicit configuration system for Vite, Nitro, and provider-native runtimes.

The core problem is not missing env validation. Vite, Nitro, Nuxt, Cloudflare, and Vercel all expose values through different mechanisms that look similar but behave differently: `.env`, host env, `process.env`, `import.meta.env`, Vite `define`, Nitro `runtimeConfig`, Cloudflare bindings, build env, runtime env, and request-scoped provider capabilities.

The v1 mental model is:

- `build.*` is read during config/dev/build and frozen into the build.
- `runtime.*` is read after build by a server/runtime provider.
- `runtime.cloudflare.bindings` is provider capability access, not plain env.

## Pain Points

- Vite: `import.meta.env` is often treated as runtime even though client values are bundled; `define` is often misused as runtime config; `.env` is not available in `vite.config.ts` until explicitly loaded.
- Nitro: `runtimeConfig` can blur defaults, runtime overrides, `process.env`, and provider runtime contexts.
- Nuxt: `runtimeConfig` and `app.config` acknowledge build/runtime differences but still make public/private the visible top-level model.
- Cloudflare: vars, secrets, and platform bindings are all exposed through runtime `env`; bindings are live capabilities and request/context scoped.
- Vercel: function env is runtime to the function but deployment-scoped; env changes apply to new deployments rather than old ones.
- Existing env validation packages: they infer types and fail fast well, but usually flatten everything into env variables and do not model Vite/Nitro/Cloudflare timing.

## V1 Scope

In scope:

- Inline `vitehub.runtimeConfig` blocks in `vite.config.ts` and `nitro.config.ts`.
- Vite plugin for `build.public`, `build.define`, generated define entries, diagnostics, virtual build config, and types.
- Nitro module for `runtime.server`, `runtime.public`, generated runtime registry/plugin, public runtime endpoint, diagnostics, and aliases.
- Cloudflare runtime vars, secrets, and bindings resolved from request runtime env.
- Standard Schema-compatible validation with Zod-like fallback support.

Deferred:

- Nuxt adapter.
- Env/provider syncing.
- Automatic refactors of existing env usage.
- Full schema-to-TypeScript emission for every validation library.
- Cloudflare manifest generation and full Pages/Workers local-dev orchestration.

## API Examples

```ts
import { defineConfig } from "vite"
import { rc, runtimeConfigVite } from "@vitehub/runtime-config/vite"

export default defineConfig({
  vitehub: {
    runtimeConfig: {
      build: {
        public: {
          apiBase: rc.build.env("PUBLIC_API_BASE", z.string().url()),
        },
        define: {
          __APP_VERSION__: rc.build.define.pkg("version", z.string()),
        },
      },
    },
  },
  plugins: [runtimeConfigVite()],
})
```

```ts
import { defineNitroConfig } from "nitro/config"
import { rc, runtimeConfigNitro } from "@vitehub/runtime-config/nitro"

export default defineNitroConfig({
  vitehub: {
    runtimeConfig: {
      runtime: {
        server: {
          databaseUrl: rc.runtime.env("DATABASE_URL", z.string().url()),
          authSecret: rc.runtime.secret("AUTH_SECRET", z.string().min(32)),
        },
        public: {
          apiBase: rc.runtime.env("PUBLIC_API_BASE", z.string().url()),
        },
      },
    },
  },
  modules: [runtimeConfigNitro()],
})
```

```ts
runtime: {
  cloudflare: {
    vars: { apiHost: rc.runtime.env("API_HOST", z.string().url()) },
    secrets: { apiToken: rc.runtime.secret("API_TOKEN", z.string().min(1)) },
    bindings: {
      DB: rc.cloudflare.binding.d1("DB"),
      CACHE: rc.cloudflare.binding.kv("CACHE"),
      BUCKET: rc.cloudflare.binding.r2("BUCKET"),
    },
  },
}
```

## Access

```ts
import { buildConfig } from "virtual:vitehub/runtime-config/build"
import { getPublicRuntimeConfig } from "virtual:vitehub/runtime-config/public-runtime"
import { getRuntimeConfig } from "#vitehub/runtime-config/server"
import { getCloudflareRuntime } from "#vitehub/runtime-config/cloudflare"
```

## Open Risks

Generated types are intentionally conservative in the first implementation. Arbitrary inline schemas cannot be safely rehydrated into exact TypeScript without library-specific metadata or explicit type hints, so v1 emits useful module declarations and leaves richer schema-driven type emission as the next design step.
