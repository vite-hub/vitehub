import { expectTypeOf } from "vitest"

import { defineConsoleAuthorize } from "vite-hub/console/auth"
import { bindConsoleAccess, installConsoleAccess, withConsoleAccess } from "../src/console/runtime/server/access.ts"

import type { ConsoleAccess } from "../src/console/runtime/server/access.ts"
import type { ConsoleRequestEvent } from "../src/console/runtime/server/request.ts"

declare const event: ConsoleRequestEvent
declare const access: ConsoleAccess

const route = withConsoleAccess(async (_event: ConsoleRequestEvent, checked) => checked.mode)
expectTypeOf(route).returns.toEqualTypeOf<Promise<ConsoleAccess["mode"] | Response>>()

// @ts-expect-error Callers cannot pass their own access. Only the guard creates it.
void route(event, access)

// @ts-expect-error A guard needs the protected handler.
withConsoleAccess()

withConsoleAccess((_event: ConsoleRequestEvent, checked) => {
  // @ts-expect-error The checked access is read-only.
  checked.mode = "local"
})

async function readMode(): Promise<ConsoleAccess["mode"]> {
  // @ts-expect-error Callers must handle the rejection Response before they use the result.
  return await route(event)
}
void readMode

// @ts-expect-error console.authorize installs a function, not a file path.
installConsoleAccess({ mode: "host-managed", authorize: "server/console-authorize.ts" })
// @ts-expect-error Unknown access modes must not open the Console.
installConsoleAccess({ mode: "public" })
// @ts-expect-error The local development policy has no check to replace.
installConsoleAccess({ mode: "local", check: async () => undefined })

defineConsoleAuthorize(({ request }) => request.headers.get("x-role") === "admin")
defineConsoleAuthorize(() => new Response("Sign in at the host.", { status: 401 }))
// @ts-expect-error An authorize function returns a boolean or a Response.
defineConsoleAuthorize(() => "admin")

expectTypeOf(bindConsoleAccess(access, event)).toEqualTypeOf<ConsoleRequestEvent>()
