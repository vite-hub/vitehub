import { describe, expectTypeOf, it } from "vitest"

import { defineConsoleAuthorize } from "vite-hub/console/auth"
import { bindConsoleAccess, installConsoleAccess, withConsoleAccess } from "../src/console/runtime/server/access.ts"

import type { ConsoleAccess } from "../src/console/runtime/server/access.ts"
import type { ConsoleRequestEvent } from "../src/console/runtime/server/request.ts"

declare const event: ConsoleRequestEvent
declare const access: ConsoleAccess

describe("Console access types", () => {
  it("type checks", () => {
    const route = withConsoleAccess(async (_event: ConsoleRequestEvent, checked) => checked.mode, { section: "kv" })
    expectTypeOf(route).returns.toEqualTypeOf<Promise<ConsoleAccess["mode"] | Response>>()
    expectTypeOf<ConsoleAccess["sections"]>().toEqualTypeOf<"all" | readonly string[]>()

    // @ts-expect-error Callers cannot pass their own access. Only the guard creates it.
    void route(event, access)

    // @ts-expect-error A guard needs the protected handler.
    withConsoleAccess()

    // @ts-expect-error Every guarded route declares its Console section.
    withConsoleAccess((_event: ConsoleRequestEvent) => "data")

    withConsoleAccess((_event: ConsoleRequestEvent) => "data", { section: event => event.method })
    withConsoleAccess((_event: ConsoleRequestEvent) => "data", { anySection: true })
    // @ts-expect-error A route serves one section or every section, not both.
    withConsoleAccess((_event: ConsoleRequestEvent) => "data", { anySection: false })

    withConsoleAccess((_event: ConsoleRequestEvent, checked) => {
      // @ts-expect-error The checked access is read-only.
      checked.mode = "open"
    }, { section: "kv" })

    async function readMode(): Promise<ConsoleAccess["mode"]> {
      // @ts-expect-error Callers must handle the rejection Response before they use the result.
      return await route(event)
    }
    void readMode

    // @ts-expect-error console.authorize installs a function, not a file path.
    installConsoleAccess({ mode: "open", authorize: "server/console-authorize.ts" })
    // @ts-expect-error Unknown access modes must not open the Console.
    installConsoleAccess({ mode: "public" })
    // @ts-expect-error The open policy has no check to replace.
    installConsoleAccess({ mode: "open", check: async () => undefined })

    defineConsoleAuthorize(({ request }) => request.headers.get("x-role") === "admin")
    defineConsoleAuthorize(() => new Response("Sign in at the host.", { status: 401 }))
    defineConsoleAuthorize(({ user }) => user?.role === "editor" ? { sections: ["content"] } : true)
    // @ts-expect-error An authorize function returns a boolean, a Response, or { sections }.
    defineConsoleAuthorize(() => "admin")
    // @ts-expect-error Section ids are strings.
    defineConsoleAuthorize(() => ({ sections: [1] }))

    expectTypeOf(bindConsoleAccess(access, event)).toEqualTypeOf<ConsoleRequestEvent>()
  })
})
