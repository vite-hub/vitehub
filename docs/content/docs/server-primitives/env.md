---
title: Env
description: Declare public, build-time, server runtime, and secret values behind typed ViteHub accessors.
navigation.order: 2
icon: i-lucide-key-round
---

Env models environment values without mixing browser-safe config, build replacements, and server-only Runtime Env. ViteHub owns Env Declarations, generated Public Env and Server Env access, diagnostics, and Secret Env redaction.

Env does not store secrets for a host. The host still supplies variables, and server code performs Secret Unseal only at the boundary that needs the raw value.

## Configure Env

Add `hubEnv()` and declare values in the Vite config. `env.public` becomes browser-safe Public Env, `env.define` becomes Vite replacements, and `env.server` becomes Server Env for server runtime code.

```ts [vite.config.ts]
import { env, hubEnv } from '@vite-hub/env/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [hubEnv()],
  env: {
    public: {
      appName: env({ default: 'Acme' }),
    },
    define: {
      __BUILD_TARGET__: env({ default: 'preview' }),
    },
    server: {
      github: {
        token: env({ secret: true, source: env.source('GITHUB_TOKEN') }),
      },
    },
  },
})
```

## Use it at runtime

Use Public Env from browser-safe code. The import path stays stable even though ViteHub generates the backing module.

```ts [src/config.ts]
import { usePublicEnv } from '#vitehub/env/public'

export const appName = usePublicEnv().appName
```

Use Server Env from server-only code. Secret Env values redact by default and require `unseal()` before a third-party SDK or request can receive the underlying string.

```ts [server/github.ts]
import { useServerEnv } from '#vitehub/env/server'

export async function listIssues() {
  const { github } = useServerEnv()

  return fetch('https://api.github.com/issues', {
    headers: {
      authorization: `Bearer ${github.token.unseal()}`,
    },
  })
}
```

## Provider output

`hubEnv()` writes generated env modules under `.vitehub/env/` and ambient types under `.vitehub/types/`. App code should import `#vitehub/env/public` and `#vitehub/env/server`, not generated file paths or integration virtual modules.

Add the generated type directory to `tsconfig.json` when the app wants field-level types for generated Env access.

```json [tsconfig.json]
{
  "include": [
    "src/**/*.ts",
    "server/**/*.ts",
    ".vitehub/types/**/*.d.ts"
  ]
}
```

## Connect it to Agents

Agent callbacks and Capability callbacks should read app-owned Runtime Env through Server Env. Do not pass secrets through Agent Invocation metadata or model-facing instructions.

Env is usually not an agent-facing Capability. Other Capabilities consume Server Env when they need credentials, provider tokens, or app-owned configuration.

## Production boundaries

Public Env and Vite define values are visible to built client code. Put secrets only in Server Env with `secret: true`.

Secret Env provides type friction and default redaction, but it is not a complete leak-prevention system. Unseal secrets as late as possible and avoid returning them in responses, logs, traces, or Agent output.

## Next steps

- Learn the server primitive model in [Server primitives for any host](/docs/concepts/server-primitives-for-any-host).
- Use Env with [Auth](/docs/server-primitives/auth) when Auth runtime options need secrets.
- Expose agent abilities through [Official capabilities](/docs/capabilities/official-capabilities) without making secrets model-facing.
