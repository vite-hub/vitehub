import { describe, expect, it } from "vitest"

import { rc } from "../src/index.ts"
import { getCloudflareRuntime } from "../src/runtime/cloudflare.ts"
import { setRuntimeConfigRegistry } from "../src/runtime/server.ts"

import { stringSchema } from "./helpers.ts"

describe("Cloudflare runtime", () => {
  it("resolves request-scoped vars, secrets, and bindings", () => {
    const db = { prepare: () => ({}) }
    setRuntimeConfigRegistry({
      cloudflare: {
        bindings: {
          DB: rc.cloudflare.binding.d1("DB"),
        },
        secrets: {
          apiToken: rc.runtime.secret("API_TOKEN", stringSchema()),
        },
        vars: {
          apiHost: rc.runtime.env("API_HOST", stringSchema()),
        },
      },
    })

    const runtime = getCloudflareRuntime({
      context: {
        cloudflare: {
          env: {
            API_HOST: "https://api.example.com",
            API_TOKEN: "secret",
            DB: db,
          },
        },
      },
    })

    expect(runtime.vars.apiHost).toBe("https://api.example.com")
    expect(runtime.secrets.apiToken).toBe("secret")
    expect(runtime.bindings.DB).toBe(db)
  })

  it("does not reuse bindings across events", () => {
    const firstDb = { id: 1 }
    const secondDb = { id: 2 }
    setRuntimeConfigRegistry({
      cloudflare: {
        bindings: {
          DB: rc.cloudflare.binding.d1("DB"),
        },
      },
    })

    expect(getCloudflareRuntime({ context: { cloudflare: { env: { DB: firstDb } } } }).bindings.DB).toBe(firstDb)
    expect(getCloudflareRuntime({ context: { cloudflare: { env: { DB: secondDb } } } }).bindings.DB).toBe(secondDb)
  })
})
