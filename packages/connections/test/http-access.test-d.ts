import { describe, expectTypeOf, it } from "vitest"

import { createConnectionsHandler } from "../src/http.ts"
import { checkConnectionsAccess, connectionsRuntimeFor } from "../src/internal/http-access.ts"
import { connectionsRoutes } from "../src/internal/http-routes.ts"

import type { ConnectionsAccessPolicy } from "../src/http.ts"
import type { ConnectionsAccess } from "../src/internal/http-access.ts"
import type { ConnectionsRuntime } from "../src/runtime.ts"

declare const request: Request
declare const runtime: () => ConnectionsRuntime

describe("Connections route access types", () => {
  it("requires an access policy", () => {
    // @ts-expect-error The handler has no default policy.
    createConnectionsHandler()
    // @ts-expect-error The handler has no default policy.
    createConnectionsHandler({ basePath: "/_vitehub/connections" })
    // @ts-expect-error Only "development" is a named policy.
    createConnectionsHandler({ actor: "production" })
    // @ts-expect-error A policy returns the actor id, not a boolean.
    createConnectionsHandler({ actor: () => true })
    expectTypeOf<ConnectionsAccessPolicy>().toEqualTypeOf<"development" | ((request: Request, event?: unknown) => string | undefined | Promise<string | undefined>)>()
  })

  it("accepts only an access from the check in a route body", async () => {
    const route = connectionsRoutes[0]!
    // @ts-expect-error A plain object is not a checked access.
    await route.handle({ actor: "user:owner", request }, "/_vitehub/connections")
    // @ts-expect-error The runtime needs a checked access.
    connectionsRuntimeFor({ actor: "user:owner", request })

    const check = await checkConnectionsAccess(() => "user:owner", request, undefined, runtime)
    // @ts-expect-error The check can return a rejection instead of an access.
    await route.handle(check.access, "/_vitehub/connections")
    if (check.rejection) return
    expectTypeOf(check.access).toEqualTypeOf<ConnectionsAccess>()
    // @ts-expect-error An access is read-only.
    check.access.actor = "user:other"
    await route.handle(check.access, "/_vitehub/connections")
  })
})
