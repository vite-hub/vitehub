import { describe, expect, it } from "vitest"

import { defineAuth } from "../src/index.ts"

describe("defineAuth", () => {
  it("creates an Auth Definition with ViteHub placement metadata", () => {
    const authorize = ({ user }: { user: Record<string, unknown> }) => user.isAdmin === true
    expect(defineAuth({
      appName: "ViteHub",
      access: {
        routes: [
          "/app",
          { authorize, method: "POST", route: "/app/actions" },
        ],
        signIn: {
          callbackURL: "/app",
          errorCallbackURL: "/login?error=auth",
          provider: "github",
        },
      },
      basePath: "/auth",
      database: { dedicated: true, name: "auth" },
      route: false,
      runtime: () => ({ secret: "runtime-secret" }),
      secondaryStorage: { store: "auth" },
    })).toEqual({
      options: {
        appName: "ViteHub",
        access: {
          routes: [
            "/app",
            { authorize, method: "POST", route: "/app/actions" },
          ],
          signIn: {
            callbackURL: "/app",
            errorCallbackURL: "/login?error=auth",
            provider: "github",
          },
        },
        basePath: "/auth",
        database: { dedicated: true, name: "auth" },
        route: false,
        runtime: expect.any(Function),
        secondaryStorage: { store: "auth" },
      },
    })
  })

  it("defaults database placement when the definition does not specify one", () => {
    expect(defineAuth({ appName: "ViteHub" })).toEqual({
      options: { appName: "ViteHub" },
    })
  })

  it("accepts a request-scoped Auth Definition callback", () => {
    const definition = defineAuth(({ requestOrigin }) => ({
      appName: "ViteHub",
      baseURL: requestOrigin,
      secret: "runtime-secret",
    }))

    expect(definition).toEqual({
      options: expect.any(Function),
    })
  })

  it("rejects runtime-only Better Auth fields", () => {
    expect(() => defineAuth({ baseURL: "https://example.com" } as never)).toThrow(/resolved at runtime/)
    expect(() => defineAuth({ secret: "secret" } as never)).toThrow(/resolved at runtime/)
    expect(() => defineAuth({ secrets: [{ value: "secret", version: 1 }] } as never)).toThrow(/resolved at runtime/)
  })

  it("rejects unsupported route, database, and secondary storage shapes", () => {
    expect(() => defineAuth({ route: true } as never)).toThrow(/route can only be `false`/)
    expect(() => defineAuth({ basePath: "api/auth" } as never)).toThrow(/basePath must start/)
    expect(() => defineAuth({ database: false } as never)).toThrow(/database must be `true`/)
    expect(() => defineAuth({ database: { dedicated: true } } as never)).toThrow(/database.name/)
    expect(() => defineAuth({ database: { name: "auth", url: "file:auth.db" } } as never)).toThrow(/database does not support/)
    expect(() => defineAuth({ secondaryStorage: false } as never)).toThrow(/secondaryStorage must be `true`/)
    expect(() => defineAuth({ secondaryStorage: {} } as never)).toThrow(/secondaryStorage.store/)
    expect(() => defineAuth({ secondaryStorage: { driver: "kv" } } as never)).toThrow(/secondaryStorage does not support/)
    expect(() => defineAuth({ runtime: "secret" } as never)).toThrow(/runtime must be an object or a function/)
  })

  it("rejects unsupported access config", () => {
    expect(() => defineAuth({ access: false } as never)).toThrow(/access must be an object/)
    expect(() => defineAuth({ access: { signIn: false } } as never)).toThrow(/access\.signIn must be an object/)
    expect(() => defineAuth({ access: { signIn: { provider: "" } } } as never)).toThrow(/access\.signIn\.provider/)
    expect(() => defineAuth({ access: { signIn: { provider: "github", requestSignUp: "yes" } } } as never)).toThrow(/requestSignUp/)
    expect(() => defineAuth({ access: { signIn: { provider: "github", scopes: ["read:org", 1] } } } as never)).toThrow(/scopes/)
    expect(() => defineAuth({ access: { routes: "/app" } } as never)).toThrow(/access\.routes must be an array/)
    expect(() => defineAuth({ access: { routes: ["app"] } } as never)).toThrow(/access\.routes\[0\] must start/)
    expect(() => defineAuth({ access: { routes: [{ route: "/app", role: "admin" }] } } as never)).toThrow(/does not support/)
    expect(() => defineAuth({ access: { routes: [{ authorize: true, route: "/app" }] } } as never)).toThrow(/authorize must be a function/)
    expect(() => defineAuth({ access: { routes: [{ method: "", route: "/app" }] } } as never)).toThrow(/access\.routes\[0\]\.method/)
    expect(() => defineAuth({ access: { routes: [{}] } } as never)).toThrow(/access\.routes\[0\]\.route/)
  })
})
