import { afterEach, describe, expect, it } from "vitest"

import { consoleStateKey } from "../src/console/internal.ts"
import { installConsoleAccess } from "../src/console/runtime/server/access.ts"
import { listConsoleSections } from "../src/console/runtime/server/sections.get.ts"
import { installConsoleSections } from "../src/console/runtime/server/sections.ts"
import { requestEvent } from "./console-event.ts"
import { consoleAccess } from "./support/console-access.ts"

afterEach(() => {
  for (const key of [consoleStateKey, Symbol.for("vitehub.console.access")]) {
    Reflect.deleteProperty(globalThis, key)
  }
})

describe("Console section access metadata", () => {
  it.each([
    { mode: "auth" as const, independentAuth: false, auth: true },
    { mode: "open" as const, independentAuth: true, auth: true },
    { mode: "open" as const, independentAuth: false, auth: false },
    { mode: "cloudflare-access" as const, independentAuth: "cloudflare-access" as const, auth: "cloudflare-access" },
  ])("preserves read-only grants with $mode access and independent Auth $independentAuth", async ({ mode, independentAuth, auth }) => {
    const authorize = () => ({ sections: ["kv:read", "blob"] })
    installConsoleAccess(mode === "open" ? { mode, authorize } : { mode, authorize, check: async () => undefined })
    installConsoleSections("/app", ["kv", "blob", "email"], independentAuth)

    const result = listConsoleSections(await consoleAccess(requestEvent(new Request("https://app.example/_vitehub/api/sections"))))
    expect(result).toMatchObject({ readOnly: ["kv"], scoped: true, sections: ["kv", "blob"] })
    if (auth) expect(result).toHaveProperty("auth", auth)
    else expect(result).not.toHaveProperty("auth")
  })
})
