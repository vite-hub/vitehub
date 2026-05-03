import { describe, expect, it } from "vitest"

import { rc } from "../src/index.ts"
import { validateRuntimeConfigShape } from "../src/core/resolve.ts"

import { stringSchema } from "./helpers.ts"

describe("runtime config declarations", () => {
  it("marks timing in helper kinds", () => {
    expect(rc.build.env("PUBLIC_API_BASE", stringSchema())).toMatchObject({
      envName: "PUBLIC_API_BASE",
      kind: "build-env",
    })
    expect(rc.runtime.secret("AUTH_SECRET", stringSchema())).toMatchObject({
      envName: "AUTH_SECRET",
      kind: "runtime-secret",
    })
    expect(rc.cloudflare.binding.d1("DB")).toMatchObject({
      bindingName: "DB",
      bindingType: "d1",
      kind: "cloudflare-binding",
    })
  })

  it("rejects runtime declarations in Vite-only config", () => {
    expect(() => validateRuntimeConfigShape({
      runtime: {
        server: {
          databaseUrl: rc.runtime.env("DATABASE_URL", stringSchema()),
        },
      },
    }, "vite")).toThrow("`runtime.*` is not available")
  })
})
